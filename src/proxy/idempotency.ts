/**
 * In-process idempotency for `POST /v3/*`.
 *
 * Why this exists: the bank's authorization module retries on transport
 * failures, and a retried session creation is a duplicate authorization and
 * a duplicate charge. When the caller sends an `Idempotency-Key`, the first
 * request executes and a repeat within the TTL replays the recorded
 * response without touching upstream again. A repeat that arrives while the
 * first is still in flight waits for it instead of issuing a second call.
 *
 * Why in-process: this phase runs a single instance with no shared store,
 * so the record lives in a `Map` with lazy TTL expiry. Only successful
 * (`2xx`) responses are recorded; a failure is never cached, because the
 * caller may legitimately retry after fixing their payload.
 *
 * This is not a distributed lock and must not be described as one: two
 * relay instances do not coordinate, and a restart drops every record.
 */

export interface RecordedResponse {
  status: number;
  contentType: string | null;
  body: Uint8Array<ArrayBuffer>;
}

/** Accepted shape of an inbound `Idempotency-Key` header value. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** How long a recorded response may be replayed. */
const TTL_MS = 10 * 60 * 1000;

/** Upper bound on entries (completed and in-flight alike). */
const MAX_ENTRIES = 10_000;

/** Minimum gap between full expiry sweeps; reads also drop what they find. */
const SWEEP_INTERVAL_MS = 60 * 1000;

interface CompletedEntry {
  readonly kind: "completed";
  readonly recorded: RecordedResponse;
  readonly expiresAt: number;
}

interface PendingEntry {
  readonly kind: "pending";
  readonly token: symbol;
  /** Resolves when the owner settles the entry (or it is evicted). */
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

type Entry = CompletedEntry | PendingEntry;

export type ClaimResult =
  | { claimed: true; token: symbol }
  | { claimed: false; wait: Promise<void> };

function createPending(): PendingEntry {
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { kind: "pending", token: Symbol("idempotency"), settled, settle };
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private lastSweepAt = 0;

  /** Number of entries currently held. Exposed for tests and operators. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Return the recorded response for `path` + `key`, or `null` when there
   * is none, it expired, or the first request is still in flight (call
   * `claim` to wait for that case). Expired entries are dropped on sight.
   *
   * `path` must be the exact inbound path (trailing slash significant);
   * the query string is not part of the scope.
   */
  lookup(path: string, key: string): RecordedResponse | null {
    this.sweepIfDue();
    const entry = this.entries.get(compositeKey(path, key));
    if (entry === undefined || entry.kind === "pending") {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(compositeKey(path, key));
      return null;
    }
    return entry.recorded;
  }

  /**
   * Take ownership of `path` + `key` for one upstream execution, or get
   * the in-flight wait when another request already owns it. The caller
   * must settle the claim with exactly one of `complete` / `release`.
   */
  claim(path: string, key: string): ClaimResult {
    this.sweepIfDue();
    const composite = compositeKey(path, key);
    const existing = this.entries.get(composite);
    if (existing !== undefined && existing.kind === "pending") {
      return { claimed: false, wait: existing.settled };
    }
    const pending = createPending();
    // Delete-then-set refreshes insertion order so a re-claimed key is no
    // longer the oldest entry.
    this.entries.delete(composite);
    this.entries.set(composite, pending);
    this.evictOverflow();
    return { claimed: true, token: pending.token };
  }

  /**
   * Record a successful response, but only when `token` still owns the
   * slot: a claim evicted under cap pressure must not overwrite the
   * entry that replaced it.
   */
  complete(path: string, key: string, token: symbol, recorded: RecordedResponse): void {
    const composite = compositeKey(path, key);
    const existing = this.entries.get(composite);
    if (existing === undefined || existing.kind !== "pending" || existing.token !== token) {
      return;
    }
    existing.settle();
    this.entries.delete(composite);
    this.entries.set(composite, {
      kind: "completed",
      recorded,
      expiresAt: Date.now() + TTL_MS,
    });
    this.evictOverflow();
  }

  /**
   * Give up a claim without recording (upstream failure, non-`2xx`, or an
   * unexpected throw). Waiters wake, find nothing cached, and one of them
   * claims the next execution. Unknown or foreign tokens are ignored.
   */
  release(path: string, key: string, token: symbol): void {
    const composite = compositeKey(path, key);
    const existing = this.entries.get(composite);
    if (existing === undefined || existing.kind !== "pending" || existing.token !== token) {
      return;
    }
    existing.settle();
    this.entries.delete(composite);
  }

  private sweepIfDue(): void {
    const now = Date.now();
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweepAt = now;
    for (const [composite, entry] of this.entries) {
      if (entry.kind === "completed" && entry.expiresAt <= now) {
        this.entries.delete(composite);
      }
    }
  }

  /** Evict oldest first until back under the cap. */
  private evictOverflow(): void {
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      const entry = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      // An evicted in-flight claim must still wake its waiters; they
      // re-check and one of them starts a fresh execution.
      if (entry !== undefined && entry.kind === "pending") {
        entry.settle();
      }
    }
  }
}

function compositeKey(path: string, key: string): string {
  // `\n` cannot appear in a validated key, so the scope cannot be forged.
  return `${path}\n${key}`;
}
