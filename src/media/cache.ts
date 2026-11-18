/**
 * Read-through disk cache for upstream biometric media.
 *
 * Entries live under `<MEDIA_CACHE_DIR>/v1/`, keyed by
 * `sha256(upstream url)`: body bytes plus a JSON sidecar holding the
 * upstream content-type and the fetch time. Writes are atomic (temp file +
 * rename), so readers only ever see complete entries, and the cache never
 * throws: any filesystem failure degrades to a miss or a skipped write,
 * because a cache fault must not fail a biometric serve.
 *
 * The cache is bounded by `MEDIA_CACHE_MAX_BYTES`: before writing, oldest
 * entries (by file mtime) are evicted until the new entry fits, and the
 * write is refused when nothing evictable frees enough room. Entries being
 * written are tracked and never evicted; readers treat them as a miss, so
 * no torn entry is ever served.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface MediaCacheOptions {
  baseDir: string;
  enabled: boolean;
  maxBytes: number;
}

export interface CachedMedia {
  body: Uint8Array;
  contentType: string | null;
  fetchedAt: number;
}

let tmpCounter = 0;

export class MediaCache {
  private readonly dir: string;
  private readonly enabled: boolean;
  private readonly maxBytes: number;
  /** Keys with a write in flight (refcounted for concurrent writers). */
  private readonly inProgress = new Map<string, number>();

  constructor(options: MediaCacheOptions) {
    this.dir = join(options.baseDir, "v1");
    this.enabled = options.enabled;
    this.maxBytes = options.maxBytes;
  }

  static keyForUrl(url: string): string {
    return createHash("sha256").update(url, "utf8").digest("hex");
  }

  async read(url: string): Promise<CachedMedia | null> {
    if (!this.enabled) {
      return null;
    }
    const key = MediaCache.keyForUrl(url);
    if (this.inProgress.has(key)) {
      return null;
    }
    try {
      const [metaRaw, body] = await Promise.all([
        readFile(join(this.dir, `${key}.meta`), "utf8"),
        readFile(join(this.dir, `${key}.body`)),
      ]);
      const meta = JSON.parse(metaRaw) as { contentType?: unknown; fetchedAt?: unknown };
      if (
        (typeof meta.contentType !== "string" && meta.contentType !== null) ||
        typeof meta.fetchedAt !== "number" ||
        !Number.isFinite(meta.fetchedAt)
      ) {
        return null;
      }
      return { body, contentType: meta.contentType, fetchedAt: meta.fetchedAt };
    } catch {
      return null;
    }
  }

  /**
   * Store a fetched body. `"skipped"` covers the disabled cache, a full
   * cache that cannot be compacted, and any filesystem failure; the caller
   * still serves the bytes it already holds.
   */
  async write(
    url: string,
    body: Uint8Array,
    contentType: string | null,
  ): Promise<"written" | "skipped"> {
    if (!this.enabled) {
      return "skipped";
    }
    const key = MediaCache.keyForUrl(url);
    const metaBytes = Buffer.from(
      JSON.stringify({ contentType, fetchedAt: Date.now() }),
      "utf8",
    );
    this.inProgress.set(key, (this.inProgress.get(key) ?? 0) + 1);
    const bodyTmp = join(this.dir, `${key}.body.tmp-${process.pid}-${(tmpCounter += 1)}`);
    const metaTmp = join(this.dir, `${key}.meta.tmp-${process.pid}-${tmpCounter}`);
    try {
      try {
        await mkdir(this.dir, { recursive: true });
      } catch {
        return "skipped";
      }
      const needed = body.byteLength + metaBytes.byteLength;
      const size = await this.makeRoom(needed);
      if (size + needed > this.maxBytes) {
        return "skipped";
      }
      await writeFile(bodyTmp, body);
      await rename(bodyTmp, join(this.dir, `${key}.body`));
      await writeFile(metaTmp, metaBytes);
      await rename(metaTmp, join(this.dir, `${key}.meta`));
      return "written";
    } catch {
      return "skipped";
    } finally {
      for (const tmp of [bodyTmp, metaTmp]) {
        try {
          await unlink(tmp);
        } catch {
          // Already renamed away, or never created.
        }
      }
      const remaining = (this.inProgress.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        this.inProgress.delete(key);
      } else {
        this.inProgress.set(key, remaining);
      }
    }
  }

  /** Best-effort removal (used when the upstream presign is known dead). */
  async drop(url: string): Promise<void> {
    const key = MediaCache.keyForUrl(url);
    for (const suffix of [".body", ".meta"] as const) {
      try {
        await unlink(join(this.dir, `${key}${suffix}`));
      } catch {
        // Missing already.
      }
    }
  }

  /**
   * Evict oldest entries until `needed` bytes fit, skipping entries being
   * written. Returns the directory size after eviction (an estimate: a
   * concurrent writer may land between the scan and the caller).
   */
  private async makeRoom(needed: number): Promise<number> {
    let size = await this.directorySize();
    if (size + needed <= this.maxBytes) {
      return size;
    }
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return size;
    }
    const keys = new Set<string>();
    for (const name of names) {
      if (name.endsWith(".body")) {
        keys.add(name.slice(0, -".body".length));
      } else if (name.endsWith(".meta")) {
        keys.add(name.slice(0, -".meta".length));
      }
    }
    const candidates: { key: string; mtimeMs: number; bytes: number }[] = [];
    for (const key of keys) {
      if (this.inProgress.has(key)) {
        continue;
      }
      let mtimeMs: number | null = null;
      let bytes = 0;
      for (const suffix of [".body", ".meta"] as const) {
        try {
          const info = await stat(join(this.dir, `${key}${suffix}`));
          bytes += info.size;
          mtimeMs = mtimeMs === null ? info.mtimeMs : Math.min(mtimeMs, info.mtimeMs);
        } catch {
          // Half of a pair vanished; the other half still counts.
        }
      }
      if (mtimeMs !== null) {
        candidates.push({ key, mtimeMs, bytes });
      }
    }
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const candidate of candidates) {
      if (size + needed <= this.maxBytes) {
        break;
      }
      // Re-checked: a write may have started while the scan was awaiting.
      if (this.inProgress.has(candidate.key)) {
        continue;
      }
      for (const suffix of [".body", ".meta"] as const) {
        try {
          await unlink(join(this.dir, `${candidate.key}${suffix}`));
        } catch {
          // Already gone.
        }
      }
      size -= candidate.bytes;
    }
    return size;
  }

  private async directorySize(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    let total = 0;
    for (const name of names) {
      try {
        total += (await stat(join(this.dir, name))).size;
      } catch {
        // Vanished mid-scan; ignore.
      }
    }
    return total;
  }
}
