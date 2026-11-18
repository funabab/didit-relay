/**
 * Shape-agnostic rewriting of presigned media URLs in proxied JSON.
 *
 * No completed session has been observed yet, so the field names carrying
 * media URLs are unknown. Rewriting therefore matches by host, not by
 * field: any string value that parses as an absolute http(s) URL whose
 * hostname is in `DIDIT_MEDIA_HOSTS` becomes
 * `${PUBLIC_MEDIA_BASE}/m/${token}`. API hosts are never in that list, so
 * an API URL cannot be rewritten.
 *
 * Only the proxy calls this, only for `2xx` JSON responses, and only when
 * rewriting is active (both `DIDIT_MEDIA_HOSTS` and `PUBLIC_MEDIA_BASE`
 * set). Bodies that fail to parse, or that contain no media URL, are
 * returned by reference, untouched down to the byte.
 */
import { mintMediaToken } from "./links";

export interface RewriteOptions {
  /** Lowercased hostnames from `DIDIT_MEDIA_HOSTS`. */
  mediaHosts: ReadonlySet<string>;
  /** Normalized `PUBLIC_MEDIA_BASE` (no trailing slash). */
  publicMediaBase: string;
  signingKey: Uint8Array;
  /** Single expiry for every token minted for this body (deterministic). */
  expiresAtMs: number;
}

/**
 * Rewrite media URLs in a JSON body. Returns the input unchanged when the
 * body is not valid JSON or holds no media URL; otherwise returns freshly
 * serialized bytes (`JSON.stringify`: insignificant whitespace normalised,
 * key order preserved).
 */
export function rewriteJsonBody(
  body: Uint8Array<ArrayBuffer>,
  opts: RewriteOptions,
): Uint8Array<ArrayBuffer> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return body;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A body we cannot parse is not ours to rewrite.
    return body;
  }
  const rewritten = rewriteValue(parsed, opts, new Map<string, string | null>());
  if (!rewritten.changed) {
    return body;
  }
  return new TextEncoder().encode(JSON.stringify(rewritten.value));
}

function rewriteValue(
  value: unknown,
  opts: RewriteOptions,
  cache: Map<string, string | null>,
): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const replacement = rewriteString(value, opts, cache);
    return replacement === null
      ? { value, changed: false }
      : { value: replacement, changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = rewriteValue(item, opts, cache);
      if (next.changed) {
        changed = true;
      }
      return next.value;
    });
    return changed ? { value: out, changed: true } : { value, changed: false };
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    // Insertion order is preserved, so key order survives re-serialization.
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = rewriteValue(item, opts, cache);
      if (next.changed) {
        changed = true;
      }
      out[key] = next.value;
    }
    return changed ? { value: out, changed: true } : { value, changed: false };
  }
  return { value, changed: false };
}

function rewriteString(
  text: string,
  opts: RewriteOptions,
  cache: Map<string, string | null>,
): string | null {
  if (cache.has(text)) {
    return cache.get(text) ?? null;
  }
  let replacement: string | null = null;
  try {
    const url = new URL(text);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      opts.mediaHosts.has(url.hostname.toLowerCase())
    ) {
      replacement = `${opts.publicMediaBase}/m/${mintMediaToken(text, opts.expiresAtMs, opts.signingKey)}`;
    }
  } catch {
    // Not an absolute URL: untouched.
  }
  cache.set(text, replacement);
  return replacement;
}
