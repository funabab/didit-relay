# Phase 1 corrections: timeout budgets, measured

Phase 1 was verified against the live sandbox API on 2026-11-18. Two findings. Everything
else passed: typecheck, 84 tests, container build, live `POST` through the proxy, live
`GET` decision, HTML-404 mapping, idempotent replay, and SIGTERM drain with a request in
flight (3010 ms request, `outcome: "drained"`, exit 0).

## Evidence (measured, not estimated)

Eight `POST /v3/session/` calls on the `biometric_authentication` workflow, each carrying
a real base64 JPEG portrait, from this machine to `https://verification.didit.me`:

```
2036  1426  1406  2024  1494  2229  1287  1440  ms
min 1287   median ~1470   max 2229
```

`GET /v3/session/{id}/decision/` returned in roughly 300 ms.

A `POST` with the 1200 ms default therefore failed about half the time, including the
first end-to-end attempt through the relay, which answered
`504 UPSTREAM_TIMEOUT`. That is the one call this service exists to serve.

## Finding 1 — one budget cannot fit both shapes of call (blocker)

`UPSTREAM_TIMEOUT_MS` currently caps every method at 1200 ms. Creates need more than that
and reads need less: a hung read should hand the customer to OTP in about a second, not
hold the mandate screen for five.

**Fix: two budgets, selected by method.**

| config key | applies to | default | basis |
| --- | --- | --- | --- |
| `UPSTREAM_TIMEOUT_MS` | `GET`, `HEAD` | `1500` | decision read observed ~300 ms; 5x headroom |
| `UPSTREAM_WRITE_TIMEOUT_MS` | `POST`, `PATCH`, `DELETE` | `5000` | create observed 1.29–2.23 s; >2x max |

Rules:

- `UPSTREAM_TIMEOUT_MS` keeps its name and meaning for reads, so existing env files still
  parse; only its default changes from `1200` to `1500`.
- `UPSTREAM_WRITE_TIMEOUT_MS` is new, validated in the existing style (positive integer,
  blank means default, invalid refuses boot, no env values in the message).
- Add `upstreamWriteTimeoutMs` to `Config`.
- `forwardWithRetry` takes the budget for its method; the retry rule "only when at least
  half the budget remains" stays as-is and now evaluates against the correct budget.
- The deadline, the abort timer and the `finally` clear are unchanged.
- Update `.env.example`, the README config table, and `tests/config.test.ts`.
- In `src/config.ts`, replace the bare constants with a short comment stating the measured
  figures above, so the numbers are auditable rather than magic.

Tests to add:

1. `loadConfig` defaults: `upstreamTimeoutMs` 1500, `upstreamWriteTimeoutMs` 5000.
2. Invalid `UPSTREAM_WRITE_TIMEOUT_MS` (`0`, `-1`, `1.5`, `abc`) refuses boot.
3. A `GET` honours the read budget and a `POST` honours the write budget: hang the fake
   upstream and assert the `GET` answers ~1500 ms and the `POST` ~5000 ms, each with 504.

## Finding 2 — the README states numbers without their evidence (docs)

The README must let a reader check the claims instead of trusting them. Add a short
"Verified against the live sandbox API" section containing:

- the eight measured create latencies and the derived defaults, as a small table;
- the observed behaviour that a `biometric_authentication` session is refused with `400`
  `portrait_image` when no portrait is supplied, and that supplying one returns `201`
  with `session_id` / `url` / `expires_at`;
- the observation that three identical creates returned the **same** `session_id`, so
  Didit already deduplicates identical payloads; state plainly that the relay's
  `Idempotency-Key` is still required because a retry with a freshly captured portrait is
  not byte-identical and would create a second session;
- the drain evidence: signal at t0, request finished at 3030 ms, `waitedMs 2010`,
  exit 0.

Keep it under 30 lines. No marketing language, no adjectives about quality.

## Hard rules

- Do not change path safety, header policy, retry eligibility, error mapping or the
  idempotency store. They are verified.
- Do not add dependencies.
- Do not weaken any existing test to make the new defaults pass; update expectations
  where the default genuinely changed.
- Never write the API key into a file, a test fixture, or a log.

## Done means

- `bun test` green with at least 87 tests, `bunx tsc --noEmit` clean.
- `docker build` succeeds; container starts; `POST /v3/session/` with a portrait through
  the container returns 201 against the real API.
- README config table lists both budgets with the new defaults.
