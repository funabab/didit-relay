/**
 * Graceful shutdown: stop accepting new work, then wait for in-flight work.
 *
 * `drain` holds no server handle. The caller injects `stop` and `waitForIdle`,
 * so the logic is testable without a real server, and `now`/`sleep` so tests
 * need not wait out real timeouts.
 *
 * Invariant: `stop(false)` is always called first. `stop(true)` runs only
 * when the timeout expires first. A zero (or negative) timeout therefore
 * force-stops immediately instead of hanging.
 */

export type DrainOutcome = "drained" | "timeout";

export interface DrainOptions {
  timeoutMs: number;
  stop: (force: boolean) => void;
  waitForIdle: () => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Stop accepting new connections, then await idleness raced against
 * `timeoutMs`. Returns `"drained"` when idle wins, `"timeout"` (after
 * `stop(true)`) when the budget expires first.
 *
 * A `waitForIdle` rejection propagates to the caller: the waiter is broken,
 * and shutdown must fail loudly rather than claim a drain it cannot prove.
 */
export async function drain(options: DrainOptions): Promise<DrainOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  options.stop(false);
  const start = now();
  if (now() - start >= options.timeoutMs) {
    options.stop(true);
    return "timeout";
  }
  const remaining = options.timeoutMs - (now() - start);
  let idle = false;
  const idlePromise = options.waitForIdle().then(() => {
    idle = true;
  });
  await Promise.race([idlePromise, sleep(Math.max(remaining, 0))]);
  if (idle) {
    return "drained";
  }
  options.stop(true);
  return "timeout";
}
