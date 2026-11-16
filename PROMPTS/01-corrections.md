# Phase 0 corrections

Follow-up to `PROMPTS/00-scaffold.md`. The scaffold is accepted in shape: layout, error envelope,
redaction approach, tests and container all match the spec. Review found seven defects, four of them
in code you wrote, three in packaging. Fix all seven. Do not add features that are not listed here.

Everything you already built stays. This is a correction pass, not a rewrite. Keep the existing
style: doc comment at the top of each file stating the invariant, no runtime dependencies,
`strict` clean, `bun test` green.

## 1. The logger never learns the process's own API key

`src/logging/logger.ts` collects "secrets" per call, from string values stored under sensitive keys
in the current `fields` and `bindings`. That only scrubs text that arrived alongside the value.

The failure: `DIDIT_API_KEY` is loaded into `config.diditApiKey` and used as a header value in later
phases. If an upstream error message or a stack trace ever contains that key without a field
carrying it, nothing scrubs it. `replaceSecrets` receives an empty array and the key goes to stdout
verbatim.

Required:

- Export `registerSecret(value: string): void`. Values shorter than 4 characters are ignored. Keep
  them in a module-level set.
- Export `clearRegisteredSecrets(): void` for tests.
- Every scrub path (`sanitize` on plain strings, `scrubErrorText`, `msg`) must apply registered
  secrets in addition to per-call secrets. Order per-call first, then registered.
- Call `registerSecret(config.diditApiKey)` in `createApp` when config is valid, so both the booted
  server and test apps get it.
- Bound the registry: at most 64 values. Drop nothing silently — if the cap is hit, log a warning
  once via the existing logger. In practice there is one secret.

Test, in `tests/logger.test.ts`:

- Register a fake key, then log `logger.error("upstream failed", { err: new Error("rejected key sk_live_abc123") })`
  and assert the output contains neither `sk_live_abc123` nor its prefix.
- Assert the same key is scrubbed when it appears in a plain `msg` string.
- Assert a value shorter than 4 characters is not registered (it would otherwise blank out
  unrelated log text).

## 2. `DIDIT_API_BASE` accepts `http:` unconditionally

`src/config.ts` validates the protocol as `http:` or `https:`. `http:` means the API key and every
biometric payload travel in plaintext. That must not be possible in production, where a typo in an
env var silently downgrades the transport.

Required:

- Accept `http:` only when `NODE_ENV` is `development` or `test`. Reject it otherwise with
  `DIDIT_API_BASE must use https (http: is only allowed when NODE_ENV is development or test).`
- Parse `NODE_ENV` before `DIDIT_API_BASE`, since the base check depends on it.
- When `http:` is accepted, the boot path logs a single `warn` line:
  `"DIDIT_API_BASE uses plaintext http (development); the API key will be sent unencrypted"`. Do
  not log the URL's host if it carries credentials — reject a URL with userinfo or query outright.

Tests:

- `http:` with `NODE_ENV=production` → config error.
- `http:` with `NODE_ENV=development` → ok.
- `https://user:pass@host` → config error (`DIDIT_API_BASE must not contain credentials or query`).
- `https://host?x=1` → config error.

## 3. Shutdown drops in-flight authorizations

`src/server.ts` calls `server.stop(true)` and then `process.exit(0)` on the next line. `stop(true)`
force-closes active connections, and the exit fires before anything could finish anyway. A SIGTERM
during a deploy kills a mandate authorization that was already in flight, which is exactly the
failure the relay exists to prevent.

Required, in a new `src/lifecycle.ts` so the logic is testable without a real server:

- `export async function drain(options: { timeoutMs: number; stop: (force: boolean) => void; waitForIdle: () => Promise<void>; now?: () => number; sleep?: (ms: number) => Promise<void>; }): Promise<"drained" | "timeout">`
- Behaviour: call `stop(false)` to stop accepting new connections, then await `waitForIdle()`
  raced against `timeoutMs`. On success return `"drained"`. On timeout call `stop(true)` and return
  `"timeout"`.
- Add `SHUTDOWN_TIMEOUT_MS` to config, default `10000`, positive integer.
- `server.ts` shutdown becomes: log, `await drain(...)`, log the outcome with
  `{ signal, outcome, waitedMs }`, then `process.exit(outcome === "drained" ? 0 : 1)`.
- A second signal while draining forces immediate exit. Use the existing `stopping` guard and a
  separate `forcing` guard.
- Never `process.exit` from module scope in a way that fires during tests. The boot block stays
  behind `import.meta.main`.

Tests, `tests/lifecycle.test.ts`:

- `waitForIdle` resolves before timeout → `"drained"`, `stop` called once with `false`.
- `waitForIdle` never resolves → `"timeout"`, `stop` called with `false` then `true`.
- Timeout of `0` still calls `stop(true)` rather than hanging.

## 4. `INTERNAL` blocks the OTP fallback

`src/http/errors.ts` maps `INTERNAL` to `fallbackToOtp: false`. That is backwards for this caller.
An unexpected bug inside the relay must never be the reason a customer cannot authorize a debit.
The bank's module only falls back to OTP when we say so, so a 500 with `fallbackToOtp: false` turns
our bug into an outage of the mandate flow.

Change `INTERNAL` to `fallbackToOtp: true`, keep `retryable: false`, keep status 500. Update the
rationale comment in `errors.ts` and the table in `README.md` to say so explicitly: retryable
describes whether the same request may succeed; `fallbackToOtp` describes whether the caller can
still complete the authorization another way. Those are independent.

Update `tests/errors.test.ts` so the canonical table matches. Add one test asserting the *reason*:
every error code except `BAD_REQUEST`, `NOT_FOUND` and `UNAUTHORIZED` sets `fallbackToOtp: true`.

## 5. Request IDs ignore the caller's

`src/server.ts` generates a fresh `crypto.randomUUID()` per request and never looks at the inbound
header. When a bank reports "authorization X failed at 14:02", its support team holds the bank's
trace ID, not ours, and there is no way to join the two logs. The relay sits on a boundary; it must
propagate correlation.

Required:

- If the inbound request carries `x-request-id` and it matches `^[A-Za-z0-9._:-]{1,64}$`, use it.
  Otherwise generate a UUID.
- Echo the chosen value in the response header, as today.
- Never log a rejected inbound value (it is attacker-controlled free text); log only that a
  supplied ID was rejected, at `debug`, without the value. Add a `requestIdSource: "inbound" | "generated"`
  field to the access log line.

Tests, `tests/server.test.ts`:

- Valid inbound ID is echoed and logged as `inbound`.
- Oversized or junk inbound ID (`"a b/c"`, 65 chars) is replaced, response ID differs, and the
  rejected value appears nowhere in the sink output.

## 6. Container install is not reproducible and health is wrong

`Dockerfile` copies only `package.json` and runs `bun install --production`, so the image resolves
dependencies fresh on every build. `HEALTHCHECK` probes `/healthz`, which by design ignores config,
so a container with a missing or invalid `DIDIT_API_KEY` reports healthy while `/readyz` is 503.

Required:

- `COPY package.json bun.lock ./` and `RUN bun install --production --frozen-lockfile`.
- `HEALTHCHECK` probes `/readyz`.
- Keep the non-root `bun` user, the `.cache/media` volume and `oven/bun:1.4-slim`.
- `docker-compose.yml` gains a `healthcheck` block mirroring the image's, and
  `depends_on`/`restart` unchanged.

Verify by building: `docker build -t didit-relay .` and
`docker run --rm -e DIDIT_API_KEY=x -e PORT=8080 -d -p 18080:8080 didit-relay`, then
`curl -sf localhost:18080/readyz`. Stop and remove the container afterwards. Do not commit a `.env`.

## 7. Word-level over-redaction is intentional but undocumented

`scrubErrorText` replaces the bare words `token`, `document`, `image` anywhere in an error message,
so `"Invalid token format"` becomes `"Invalid [REDACTED] format"`. That is the right trade — leaking
a key is worse than a mangled message — but a future reader will file it as a bug and "fix" it.

Required:

- Document it in the `logger.ts` header comment with that exact example.
- Add a short "Redaction is lossy on purpose" paragraph to `README.md` explaining that error text
  may be mangled and that callers should not parse our `message` field.
- Add a test pinning the behaviour: scrubbing `"Invalid token format"` yields
  `"Invalid [REDACTED] format"`. Pin it so removing it is a deliberate act.

## Definition of done

All of these pass, from a clean checkout:

```
bun install
bun run typecheck
bun test
docker build -t didit-relay .
```

Plus:

- `grep -rn "portrait\|selfie" src/` still hits only the redaction pattern.
- No new runtime dependency.
- `.env.example` gains `SHUTDOWN_TIMEOUT_MS=10000`.
- Every new config key appears in both `.env.example` and the README table.
- No secret, real or plausible-looking, anywhere in the repo.

Report at the end: what you changed per item, the test count before and after, and anything you
chose not to do with the reason.
