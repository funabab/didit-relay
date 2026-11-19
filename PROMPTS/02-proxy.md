# Phase 1: Didit proxy

> **Superseded in part** by `05-no-fallback.md`: the error envelope no longer carries
> `fallbackToOtp`. The relay reports `code`, `message` and `retryable`, and leaves the
> caller's next step alone.

Replace the `/v3/*` stub with a real proxy to the Didit verification API.

The bank's authorization module can reach exactly one host. Every Didit call it makes
must therefore pass through this service, which injects the API key, enforces a time
budget, and guarantees that a failure here is never the reason a customer cannot
complete a debit.

Non-goals for this phase: media re-serving (Phase 2), evidence storage (Phase 3),
webhook receipt. Do not add them. Do not modify any Phase 0 behaviour that is not
listed below.

## Contract

| inbound | upstream |
| --- | --- |
| `GET /v3/...` | `GET {base}/v3/...` |
| `POST /v3/...` | `POST {base}/v3/...` |
| `PATCH /v3/...` | `PATCH {base}/v3/...` |
| `DELETE /v3/...` | `DELETE {base}/v3/...` |

Query string is forwarded byte-for-byte. Trailing slash matters: `/v3/session/` and
`/v3/session` are different upstream paths and must stay different.

Only `/v3` and `/v3/*` are proxied. Everything else keeps answering `404 NOT_FOUND`
from the existing router; `/healthz` and `/readyz` are unchanged.

## Verified upstream behaviour (probed 2026-11-18, sandbox key)

These were observed, not read in documentation. Treat them as the contract.

- `POST /v3/session/` with a `biometric_authentication` workflow and no `portrait_image`
  answers **400** `{"portrait_image": ["No stored face image was found for this user. Send a portrait_image, or complete an approved verification first."]}`.
  Do not paper over this: a caller with no portrait must see it verbatim.
- A successful create answers **201** with `session_id`, `session_number`,
  `session_token`, `url`, `expires_at`, `vendor_data`, `status`.
- `GET /v3/session/` is **405**; it is a write-only collection. Forward it, do not special-case.
- `GET /v3/session/{id}/decision/` answers 200 with `status`, `features`,
  `decision_trace`, and per-check arrays (`liveness_checks`, `face_matches`, ...).
- `PATCH /v3/session/{id}/update-status/` rejects any session whose current status is not
  one of `Approved, Declined, In Review, Kyc Expired, Abandoned, Resubmitted`, with
  `{"detail": "Only sessions with status ... can be updated. Current status: X"}`.
- Validation failures are Django REST Framework field maps (`{"field": ["message"]}`),
  not Didit's own envelope. Pass them through untouched.
- Unknown paths under `/v3/` return **HTML** from Django, not JSON. See the content-type
  guard in Error mapping.

## Request pipeline

Run these in this exact order. Each step's failure short-circuits to the named error.

1. **Path safety.** Build the upstream URL from `diditApiBase` and the inbound path.
   Reject (`404 NOT_FOUND`) when the resulting `URL.origin` differs from the configured
   base origin, or when the path (after decoding) is not `/v3` or under `/v3/`.
   This must survive `%2e%2e%2f`, `//evil.example/`, `\` and mixed-case scheme tricks.
   Never string-concatenate a URL.
2. **Body size.** Read the request body with an 8 MiB cap (`UPSTREAM_MAX_BODY_BYTES`,
   default `8388608`). Exceeding it answers `413 PAYLOAD_TOO_LARGE` and the upstream is
   not called. `GET`/`HEAD`/`DELETE` bodies are passed through only when non-empty.
3. **Idempotency** (see below) for `POST` only.
4. **Forward** with the timeout budget.
5. **Retry** for reads only (see below).
6. **Map** the outcome or stream it back.

## Header policy

Allowlist inbound request headers, copying only these:

- `content-type`
- `accept`
- `accept-language`
- `user-agent` (relay's own UA is appended, not substituted)

Everything else is dropped, including `x-api-key`, `authorization`, `cookie`, `host`,
`content-length` and all `x-forwarded-*`. Never forward a caller-supplied
`x-forwarded-for`; the relay sets it to the inbound socket address only if the code has
it, otherwise omits it.

Always set:

- `x-api-key: {config.diditApiKey}` — injected, never echoed to the caller, never logged.
- `x-request-id: {relay request id}` — so Didit support can correlate a complaint with
  our logs. The inbound `x-request-id` is already validated in `server.ts`; reuse that
  value rather than generating a second one.
- `accept-encoding: identity` — the relay must not have to decompress or re-compress.

Do not forward hop-by-hop headers: `connection`, `keep-alive`, `transfer-encoding`,
`te`, `trailer`, `upgrade`, `proxy-authorization`, `proxy-connection`.

## Timeout budget

One deadline for the whole exchange, `UPSTREAM_TIMEOUT_MS` (existing config, default
1200). Implement with `AbortController`; the timer must be cleared in `finally` so a
successful request cannot leave a pending abort.

On expiry answer `504 UPSTREAM_TIMEOUT` (existing taxonomy: retryable, falls back to
OTP). Do not distinguish "we aborted" from "upstream hung" in the response body; log
the distinction instead.

The deadline covers time-to-response-headers. Response **body** streaming is not
covered by it — see Known limitations.

## Retry policy

- `GET` and `HEAD` only. **Never** retry `POST`, `PATCH` or `DELETE`. A retried session
  creation is a duplicate authorization and a duplicate charge.
- Retry at most once, and only when: the failure was a transport error, or the upstream
  answered `502`, `503`, or `504`.
- Do not retry when the remaining budget is under half of `UPSTREAM_TIMEOUT_MS`; it
  would only produce a timeout.
- Do not retry `429`. Pass it through mapped (below) with `retry-after` preserved.
- Log the attempt number and the reason. A silent retry is a lie in the log.

## Error mapping

Upstream `4xx` (except `401`, `429`) passes through **verbatim**: status, body, and
`content-type` — **but only when the upstream `content-type` is JSON**. Django answers
some errors with an HTML page (an unknown `/v3/...` path returns a full HTML 404), and
handing a bank's JSON client a page of HTML is worse than an envelope. When a `4xx`
carries a non-JSON content type, map it to `UPSTREAM_ERROR` and log the upstream
content-type. These are validation answers about the caller's request, so the caller
must see Didit's own field errors when they exist.

Everything else maps into the existing envelope (`src/http/errors.ts`):

| condition | code | status |
| --- | --- | --- |
| transport failure after retries | `UPSTREAM_ERROR` | 502 |
| deadline exceeded | `UPSTREAM_TIMEOUT` | 504 |
| upstream `5xx` | `UPSTREAM_ERROR` | 502 |
| upstream `429` | `UPSTREAM_RATE_LIMITED` | 429 |
| upstream `401` | `UNAUTHORIZED` | 401 |
| body over cap | `PAYLOAD_TOO_LARGE` | 413 |
| unsafe path | `NOT_FOUND` | 404 |

Two codes are new: `UPSTREAM_RATE_LIMITED` (`retryable: true`, `fallbackToOtp: true`,
preserve `retry-after` response header) and `PAYLOAD_TOO_LARGE` (`retryable: false`,
`fallbackToOtp: false`). Add both to `DEFAULTS` and to the README table; the existing
`tests/errors.test.ts` sync assertion must keep passing.

A `401` from upstream means our key is wrong, not the caller's. Log it at `error` with
no key material, and answer with the envelope — the caller still gets `fallbackToOtp`.

## Idempotency

For `POST /v3/*` carrying an `Idempotency-Key` header (1-128 chars, `[A-Za-z0-9._:-]`):

- First request executes and its **successful** response is recorded.
- A repeat with the same key inside 10 minutes replays the recorded status, body and
  `content-type`, adds `idempotent-replayed: true`, and does not call upstream.
- A repeat while the first is still in flight waits for it rather than issuing a second
  call.
- Only `2xx` responses are recorded. A failure is not cached: the caller may legitimately
  retry after fixing their payload.
- Keys are scoped per path, so the same key on `/v3/session/` and
  `/v3/session/{id}/decision/` cannot collide.
- Without the header, behaviour is unchanged: every request goes upstream.

Keep the store in-process with a TTL sweep; no new dependency. Cap it (e.g. 10,000
entries) and evict oldest first. Document the single-instance limitation in the README —
this is not a distributed lock and must not be described as one.

## Response policy

- Preserve upstream status and body; stream the body, do not buffer it.
- Forward only `content-type`, `content-length`, `retry-after`, `location`.
  Drop `set-cookie`, `server`, `via`, `x-powered-by` and anything else.
- Always set `x-request-id` on the way out (already done in `server.ts`).
- Never expose a presigned media URL host change in this phase; those URLs are returned
  inside JSON bodies and Phase 2 handles them.

## Logging

One `request` line per inbound call already exists. Extend it, do not duplicate it:

- add `upstreamStatus`, `upstreamMs`, `attempts`
- add `replayed: true` on idempotent replays

Never log: request bodies, response bodies, `x-api-key`, presigned URLs, or the
`portrait_image` field. `registerSecret` already scrubs the key at word boundaries; the
new fields must not reintroduce it.

Log `error` level once per upstream failure with `code` and `requestId`, never with the
upstream body.

## Config

Add `UPSTREAM_MAX_BODY_BYTES` (positive integer, default `8388608`), validated in
`src/config.ts` in the existing style: blank means default, invalid means boot failure,
failure text contains no env values. Add it to `.env.example` and to the README table.

## Tests

`tests/passthrough.test.ts`, using a real `Bun.serve` fake upstream on port `0`. No test
may reach the network.

Required cases:

1. `POST /v3/session/` forwards method, path, query and the exact JSON body.
2. `x-api-key` is injected; an inbound `x-api-key` is dropped, not forwarded.
3. Inbound `cookie` and `authorization` are not forwarded.
4. `content-type` survives in both directions; upstream `4xx` body is byte-identical.
5. Upstream `500` becomes `502 UPSTREAM_ERROR` with `retryable: true`.
6. A hanging upstream becomes `504 UPSTREAM_TIMEOUT` within the budget (+250 ms slack).
7. `GET` retried once on transport failure; `attempts: 2` logged.
8. `POST` not retried on transport failure; `attempts: 1`.
9. `429` maps to `UPSTREAM_RATE_LIMITED` and preserves `retry-after`.
10. Body over the cap answers `413` and the fake upstream records zero calls.
11. Encoded traversal (`/v3/%2e%2e%2f%2e%2e%2fetc/passwd`) and `//evil.example/v3/x`
    are refused with `404`.
12. Idempotent replay: second `POST` with the same key returns the cached body, header
    `idempotent-replayed: true`, and upstream call count stays 1.
13. Idempotent failure is not cached: a `400` then a `200` both reach upstream.
14. Different paths with the same key do not collide.
15. The key never appears in any captured log line.
16. A `404` from upstream carrying `content-type: text/html` becomes `502 UPSTREAM_ERROR`
    and the HTML body is not forwarded.
17. A `400` carrying `application/json` is forwarded byte-identical with its status.

Existing 51 tests must keep passing unchanged.

## Done means

- `bun test` green, `bunx tsc --noEmit` clean.
- `docker build` succeeds; container answers `/readyz` 200 and `POST /v3/session/` with
  the real key against `https://verification.didit.me` creates a session (200/201) and
  a bad path still 404s.
- One real `GET /v3/session/{id}/decision/` through the proxy returns the upstream body
  unchanged.
- README: update the status line, the error table, the config table, and replace the
  "not implemented yet" paragraph with what the proxy does and does not guarantee.

## Hard rules

- No new runtime dependencies.
- No secret in any response, log line, or error message.
- No retry of a non-idempotent method, ever.
- No proxy to any host other than `diditApiBase`.
- Keep the Phase 0 code style: JSDoc header per file explaining *why*, runner-free tests,
  typed boundaries, no `any`.

## Known limitations (document in README, do not hide)

- Idempotency is in-process and single-instance.
- The timeout covers time-to-headers; a stalled response body is not bounded here.
- `PATCH /v3/session/{id}/update-status/` is proxied but not given special semantics;
  its body shape is the caller's business, not the relay's.
