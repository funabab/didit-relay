# didit-relay

Relay service between a bank-hosted mandate authorization module and Didit's identity API.

One point of scope, because it is easy to get backwards: Didit does not authorize
mandates. The bank's module decides whether a direct debit is authorized. Today it asks
the customer for an OTP; the change this relay supports is to replace that OTP with
liveness plus a face match against the portrait the bank already holds, using Didit's
`biometric_authentication` workflow. Didit answers one question: is this the person
behind the mandate. The mandate decision stays where it was. The relay
implements neither side of that policy: it carries the portrait in and the
decision out.

It exists for one reason: banks whitelist the IPs of environments they already have a
relationship with. A third-party SaaS dependency is a different conversation: a new
vendor's egress addresses go through security review, and the answer is often no. The
relay means the bank talks to infrastructure it already trusts, and the credential stays
on our side of the boundary.

Three jobs, built in phases:

1. Proxy Didit API calls so the bank only ever talks to `api.<domain>`.
2. Re-serve short-lived presigned biometric media from `assets.<domain>`.
3. Store per-authorization evidence packs append-only, inside the bank's perimeter.

Status: Phase 2 media. `GET`, `POST`, `PATCH` and `DELETE` under `/v3/*` are proxied
to `DIDIT_API_BASE` with key injection, per-method timeout budgets, read-only retry
and per-path `POST` idempotency; presigned media URLs in `2xx` JSON responses are
rewritten to signed links served from this relay at `GET /m/{token}`. Evidence
storage (Phase 3) and webhooks are not implemented.

## Design decisions worth defending

**Why a relay instead of letting the bank call Didit.** Banks whitelist the IPs of
environments they already trust; a partner with a signed relationship gets its addresses
allowed, a SaaS dependency does not automatically. Asking for `verification.didit.me` plus
an undocumented media host is a new third-party allowlist entry, and the answer to that is
usually a security review, not a yes. The relay puts the call back on infrastructure the
bank already has a relationship with, and keeps the API key out of the bank entirely.

**Why the key lives here and nowhere else.** The bank's authorization module never holds a
Didit credential. A compromise inside the bank can spend nothing at Didit and cannot reach
another tenant's data, and one key rotation is a relay deploy instead of a bank release.

**Why the timeout is two numbers.** A create measured at 1.3–2.2 s and a decision read at
~300 ms are not the same call, and one budget either cuts off the create or makes a hung
read hold the mandate screen. Two measured budgets cost one config row each.

**Why JSON errors pass through and HTML does not.** Didit's validation errors are field
maps the caller must surface verbatim. Its unknown-path errors are Django HTML pages,
which a JSON client must never receive as if it were an answer. Both are `4xx`; only one
is ours to forward.

**Why idempotency is in-process and what that costs.** A retried create with a freshly
captured portrait is a duplicate authorization. The store is a `Map` with a TTL and a cap,
which is correct for one instance and wrong for two. See what I would change below.

**Why media URLs are rewritten by host, not by field name.** No completed session has been
observed yet, so the field names are unknown. Matching the host cannot rewrite an API URL,
because API hosts are not in the media list, and it keeps working when Didit renames a key.

**Why there is no evidence store.** The bank already has an append-only store inside its
perimeter and owns the retention policy. A second copy of biometrics in a new service adds
breach surface and no capability.

**Why the relay does not own the fallback.** It is one module that answers one question.
If verification fails it returns an error and stops; whether the bank then completes the
mandate by OTP, retries, or declines outright belongs to the bank, which holds the risk
and the customer relationship. A relay that advertises a fallback is a relay that thinks
it owns a decision it does not.

## What I would change before this carried real traffic

- **Idempotency needs shared state.** A unique constraint on `(path, key)` in Postgres, or
  Redis with the same semantics, so two instances cannot create two sessions for one key.
- **Metrics and alerting.** There is none. A relay that silently retries, or whose key
  expired, is invisible today; counters on `attempts`, `upstreamStatus` and `MEDIA_EXPIRED`
  would be the first thing I added.
- **Media bodies are buffered whole.** Fine for face crops, wrong for a 40 MB document
  scan. Cap the buffered size and stream above it.
- **Media URLs accept `http:`.** Needed for development, should be refused in production.
- **No request-level rate limiting.** The body cap and the queue for in-flight idempotent
  keys are the only backpressure that exists.

## Prerequisites

- [Bun](https://bun.sh) 1.4.x
- Docker, only for the container steps

## Quickstart

```sh
bun install
cp .env.example .env   # then set DIDIT_API_KEY inside .env
bun run typecheck
bun test
bun run start
```

Bun loads `.env` automatically. In another terminal:

```sh
curl -s localhost:8080/healthz
curl -s localhost:8080/readyz
curl -s localhost:8080/v3/session/ -o /dev/null -w "%{http_code}\n"
```

Without a valid `DIDIT_API_KEY` the process exits non-zero with one readable line:

```sh
DIDIT_API_KEY= bun src/server.ts
```

Container:

```sh
docker build -t didit-relay .
docker compose up --build
```

## Configuration

| Key | Default | Notes |
| - | - | - |
| `DIDIT_API_KEY` | (required) | Missing or empty fails boot. Failure output states only whether it is present, never its value. |
| `PORT` | `8080` | Integer 1-65535. |
| `DIDIT_API_BASE` | `https://verification.didit.me` | Must be an https URL, unless `NODE_ENV` is `development` or `test` (then `http:` is allowed with a boot-time warning). Must not contain credentials or a query string. |
| `UPSTREAM_TIMEOUT_MS` | `1500` | Positive integer, milliseconds. Budget for `GET`/`HEAD` upstream calls. |
| `UPSTREAM_WRITE_TIMEOUT_MS` | `5000` | Positive integer, milliseconds. Budget for `POST`/`PATCH`/`DELETE` upstream calls. |
| `UPSTREAM_MAX_BODY_BYTES` | `8388608` | Positive integer, bytes. Inbound bodies past the cap answer `413` and the upstream is never called. |
| `MEDIA_CACHE_DIR` | `./.cache/media` | Any non-empty path. Media entries live in a `v1/` subdirectory. |
| `DIDIT_MEDIA_HOSTS` | (empty) | Comma-separated hostnames of Didit's presigned media hosts. Empty disables rewriting; with rewriting disabled, `/m/*` answers `404`. |
| `PUBLIC_MEDIA_BASE` | (empty) | Absolute origin the bank reaches for media, e.g. `https://assets.bank.example`. Empty disables rewriting. Must be an origin (no path, credentials, query or fragment); `http:` follows the same `NODE_ENV` rule as `DIDIT_API_BASE`. |
| `MEDIA_LINK_TTL_MS` | `1800000` | Positive integer, milliseconds. Lifetime of a relay media link. |
| `MEDIA_CACHE_ENABLED` | `true` | `true` or `false`. `false` streams every media request upstream and writes nothing to disk. |
| `MEDIA_SIGNING_SECRET` | (empty) | Optional explicit media signing secret. When empty the key is derived from `DIDIT_API_KEY` via HKDF-SHA256 with info `media-signing/v1`. |
| `MEDIA_CACHE_MAX_BYTES` | `268435456` | Positive integer, bytes. Upper bound on the media cache; oldest entries are evicted first. |
| `LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. |
| `NODE_ENV` | `development` | Any non-empty string. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Positive integer, milliseconds. How long shutdown waits for in-flight requests before force-closing. |

## Endpoints

| Method | Path | Behaviour |
| - | - | - |
| `GET` | `/healthz` | Liveness. Always `200 {"status":"ok"}`; never depends on config. |
| `GET` | `/readyz` | Readiness. `200 {"status":"ready"}` when boot config was valid, otherwise `503 {"status":"not_ready","reason":"..."}`. |
| any | `/v3`, `/v3/*` | Proxied to `{DIDIT_API_BASE}/v3...`: method, path, query and body forwarded; API key injected; JSON `4xx` passed through verbatim; everything else mapped into the error envelope. See "Proxy" below. |
| `GET` | `/m/{token}` | Serves one signed media link: verifies signature and expiry, then serves the upstream bytes from cache or fetch. See "Media" below. |
| any | anything else | `404` with the error envelope. |

Every response carries an `x-request-id` header. When the inbound request supplies
one in a safe shape (`[A-Za-z0-9._:-]{1,64}`), it is propagated and echoed;
anything else is replaced with a generated UUID, and the access log records
which happened in `requestIdSource` (`"inbound"` or `"generated"`).

## Error taxonomy

All errors use one envelope:

```json
{ "error": { "code": "UPSTREAM_TIMEOUT", "message": "...", "retryable": true } }
```

`retryable` describes whether the same request may succeed on retry. Whether a
failed verification ends the attempt, is retried, or is completed another way
is the caller's decision; the relay does not model it.

| Code | HTTP | `retryable` |
| - | - | - |
| `UPSTREAM_TIMEOUT` | 504 | true |
| `UPSTREAM_ERROR` | 502 | true |
| `UPSTREAM_RATE_LIMITED` | 429 | true |
| `PAYLOAD_TOO_LARGE` | 413 | false |
| `BAD_REQUEST` | 400 | false |
| `NOT_FOUND` | 404 | false |
| `UNAUTHORIZED` | 401 | false |
| `INTERNAL` | 500 | false |
| `NOT_IMPLEMENTED` | 501 | false |
| `MEDIA_EXPIRED` | 410 | false |

`NOT_IMPLEMENTED` is retained from phase 0; nothing returns it now that the
proxy replaced the `/v3/*` stub.

`UNAUTHORIZED` needs one footnote: the row above is the taxonomy default for
a caller authentication failure. A `401` from upstream instead means the
relay's own key is wrong, and the proxy answers the same code and status.
The caller cannot distinguish the two, and the log line is what tells an
operator which one happened.

## Proxy

Every Didit call the bank makes passes through `/v3/*`, so the bank's
authorization module only ever calls a host it already whitelists and never
needs a rule for a third-party vendor's addresses. The proxy:

- resolves the inbound path against `DIDIT_API_BASE` and refuses anything
  that does not stay `/v3` or under `/v3/` (`404`), including encoded
  traversal, `//host/` tricks and backslashes; the resolved origin is
  re-verified before every call, so no request can leave for another host;
- forwards method, path, query string (byte-for-byte) and body, with the
  trailing slash preserved (`/v3/session/` and `/v3/session` stay different);
- injects `x-api-key`, sends the relay request id as `x-request-id` so
  Didit support can correlate a complaint with our logs, forces
  `accept-encoding: identity`, and appends its own user-agent; caller keys,
  cookies, `authorization`, `content-length` and every `x-forwarded-*` are
  dropped (`x-forwarded-for` is set only to the observed socket address,
  when the server provides one);
- enforces the deadline for the method (`UPSTREAM_TIMEOUT_MS` for
  `GET`/`HEAD`, `UPSTREAM_WRITE_TIMEOUT_MS` for `POST`/`PATCH`/`DELETE`)
  for the whole exchange, covering time-to-response-headers; expiry
  answers `504 UPSTREAM_TIMEOUT`;
- retries `GET`/`HEAD` at most once, only on transport errors and upstream
  `502`/`503`/`504`, only with at least half the budget left, and never
  retries `POST`, `PATCH`, `DELETE` or `429`;
- passes JSON upstream `4xx` (other than `401`/`429`) through verbatim, so
  the caller sees Didit's own field errors; maps transport failures,
  timeouts, `5xx`, `401` and `429` into the envelope; and maps a non-JSON
  `4xx` (Django answers unknown `/v3/` paths with an HTML page) to
  `UPSTREAM_ERROR` rather than handing a JSON client a page of HTML;
- streams response bodies back without buffering, forwarding only
  `content-type`, `content-length`, `retry-after` and `location`, except
  `2xx` JSON bodies, which are buffered for media-URL rewriting when
  rewriting is active (see "Media" below).

`PATCH /v3/session/{id}/update-status/` is proxied like any other path: its
body shape is the caller's business, not the relay's, and it gets no
special semantics here.

### Idempotency

`POST /v3/*` requests carrying an `Idempotency-Key` header
(`[A-Za-z0-9._:-]{1,128}`) execute once per path: a repeat within 10
minutes replays the recorded status, body and `content-type` with an
`idempotent-replayed: true` header and no upstream call, and a repeat that
arrives while the first is in flight waits for it. Only `2xx` responses
are recorded; failures are never cached. Keys are scoped per path, so the
same key on two paths cannot collide.

The store is in-process (10,000 entries, oldest evicted first, lazy TTL
sweep) with no new dependency. It is single-instance by design: this is
not a distributed lock, two relay instances do not coordinate, and a
restart drops every record. Without the header, behaviour is unchanged.

Recorded bodies are the rewritten bytes, so an idempotent replay hands
back relay links, not upstream URLs.

### Known limitations

- Idempotency is in-process and single-instance (see above).
- The proxy timeout covers time-to-response-headers; a stalled response
  body is not bounded there. Media fetches are bounded for the whole
  exchange under `UPSTREAM_WRITE_TIMEOUT_MS`.

## Media

Didit returns biometric media (face crops, liveness frames, document
images) as presigned URLs on a host separate from the API. That host is a
third-party S3 bucket the bank has no relationship with, so the relay
re-serves the bytes from an origin the bank already trusts: `2xx` JSON
responses have their media URLs rewritten to
`${PUBLIC_MEDIA_BASE}/m/{token}`, and `GET /m/{token}` serves the bytes.

Rewriting is shape-agnostic on purpose. It was written before a completed
session had ever been observed, so the field names carrying media URLs were
unknown. Rewriting matches by host instead: any string value that parses as
an absolute `http(s)` URL whose host is in `DIDIT_MEDIA_HOSTS` is replaced,
whatever field holds it. API hosts are never in that list, so an API URL
cannot be rewritten. Only `2xx` `application/json` responses are
rewritten; a body that fails to parse is forwarded untouched.

Rewritten bodies are re-serialized with `JSON.stringify`, which
normalises insignificant whitespace; key order is preserved,
`content-length` is set to the new byte length, and the upstream `etag`
is dropped (the proxy's header allowlist already drops it everywhere).
With either `DIDIT_MEDIA_HOSTS` or `PUBLIC_MEDIA_BASE` empty, rewriting
is inert: bodies pass through byte-identical and `/m/*` answers `404`.

Each link token carries the upstream URL and an expiry, authenticated by
HMAC-SHA256 over the payload with `MEDIA_SIGNING_SECRET`, or with a key
derived from `DIDIT_API_KEY` when no secret is set. Verification checks
the signature (constant-time) before parsing the payload. A malformed
token, a bad signature, or a host outside `DIDIT_MEDIA_HOSTS` answers
`404`; an expired link answers `410 MEDIA_EXPIRED`, telling the caller
to request a fresh decision rather than retry. The token is the only
authority: there is no raw-URL parameter, no caller-supplied host, and
upstream redirects are never followed. No unauthenticated media access
exists: every `/m/*` request must pass signature and expiry.

Serves read through a disk cache under `MEDIA_CACHE_DIR/v1/`, keyed by
`sha256(upstream url)`, holding body bytes plus a sidecar with the
upstream content-type and fetch time. Only `content-type` and
`content-length` pass through from upstream, served with
`cache-control: private` (never `public`: this is biometric data) and
`x-content-type-options: nosniff`. An upstream `403`/`410` means the
presign died, so the relay answers `410 MEDIA_EXPIRED` and drops the
cache entry. The cache is a liability to size: it is bounded by
`MEDIA_CACHE_MAX_BYTES` (256 MiB default, oldest evicted first, entries
being written never evicted), and `MEDIA_CACHE_ENABLED=false` disables
it entirely, streaming every request upstream and writing nothing.

Observed in a completed biometric session (2026-11-19): the media fields are
`liveness_checks[].reference_image`, `liveness_checks[].video_url` and
`face_matches[].target_image`, all on a per-environment S3 bucket in `eu-west-1`
(`service-didit-verification-production-<hash>.s3.amazonaws.com`, which says
"production" even for sandbox sessions, so the host must be configured per environment).
Rewriting matches by host, so a field renamed or added later keeps working without a code
change; only the host allowlist needs to be right.

A completed session on 2026-11-19 showed presigned URLs carrying
`X-Amz-Expires=14400`: four hours, not the hour this README previously assumed.
`MEDIA_LINK_TTL_MS` stays at 30 minutes anyway. A relay link is a capability to fetch a
face, so the shorter window is the point: long enough for a UI to render the evidence,
short enough that a leaked link dies before the day is out. The four-hour upstream window
is a constraint to stay under, not a target to match.

Media links are per-instance when the signing key is derived: two relay
instances with different API keys mint links the other rejects. Set one
shared `MEDIA_SIGNING_SECRET` if links must verify across instances.

## Verified against the live sandbox API

Measured 2026-11-18 against `https://verification.didit.me`:

| call | observed | default | basis |
| - | - | - | - |
| `POST /v3/session/` x8, with portrait | 2036 1426 1406 2024 1494 2229 1287 1440 ms | `UPSTREAM_WRITE_TIMEOUT_MS=5000` | >2x max (2229) |
| `GET .../decision/` | ~300 ms | `UPSTREAM_TIMEOUT_MS=1500` | 5x observed |

- A `biometric_authentication` create without a portrait is refused with
  `400` (`portrait_image`); with one it returns `201` with `session_id`,
  `url` and `expires_at`.
- Three identical creates returned the same `session_id`: Didit
  deduplicates identical payloads. The relay's `Idempotency-Key` is still
  required, because a retry with a freshly captured portrait is not
  byte-identical and would create a second session.
- SIGTERM drain with a request in flight: signal at t0, request finished
  at 3030 ms, `waitedMs 2010`, `outcome: "drained"`, exit 0.
- A completed biometric session, read through the relay: `status: Approved`,
  liveness `PASSIVE` score `99.0`, face match `95.0`, three media URLs
  rewritten to `/m/{token}` with no S3 host left in the body, and the
  reference image served back as a 216,485-byte JPEG that decodes, then
  served again from cache.

## Logging

JSON lines to stdout: `level`, `time`, `msg`, `requestId`, plus caller fields. Access logs
carry method, path (no query string), status, duration and requestId only. Proxied calls
add `upstreamStatus` (last upstream status, null when upstream never answered),
`upstreamMs` (wall time on the upstream exchange), `attempts` (upstream fetch
attempts, 0 when upstream was never called) and, on idempotent replays,
`replayed: true`. Each media serve logs one `media` line with `path`, `cache`
(`hit` or `miss`), `bytes`, `upstreamStatus` and `durationMs`. Request and
response bodies are never logged, and neither is the link token: any `/m/...`
path is logged as `/m/[REDACTED]`.

Redaction replaces the value of any key matching this case-insensitive pattern with
`[REDACTED]`:

```
api[_-]?key|authorization|portrait|selfie|image|document|token|secret|password|cookie
```

It applies recursively through nested objects and arrays, to `Error.message` and
`Error.stack` contents, and to repeats of already-redacted values. Circular references
serialise as `"[Circular]"`, strings over 2048 characters are truncated, and the logger
never throws: a failed write cannot take down a request.

The process's own `DIDIT_API_KEY` is registered for scrubbing at startup, so it is
redacted everywhere it appears, even when quoted back inside an upstream error
message that arrived without any field carrying it. A configured
`MEDIA_SIGNING_SECRET` is registered alongside it.

Redaction is lossy on purpose: error text is scrubbed at the word level, so a
message may come out mangled (for example `"Invalid token format"` becomes
`"Invalid [REDACTED] format"`). Leaking a key is worse than a mangled message,
so callers should treat `message` as human-readable text and never parse it.

## Layout

```
src/config.ts              env parsing, validation, typed Config, fail fast at boot
src/server.ts              Bun.serve, route table, graceful shutdown
src/lifecycle.ts           drain helper for graceful shutdown (testable, no server handle)
src/http/errors.ts         AppError hierarchy
src/logging/logger.ts      structured JSON logger with recursive redaction
src/routes/health.ts       GET /healthz, GET /readyz
src/routes/passthrough.ts  Didit proxy: path safety, body cap, forward, retry, mapping, media rewrite
src/routes/media.ts        GET /m/{token}: signed media links, cache-or-fetch serving
src/media/links.ts         link mint/verify (HMAC-SHA256, HKDF-derived key)
src/media/rewrite.ts       shape-agnostic host-based URL rewriting for 2xx JSON
src/media/cache.ts         read-through disk cache under MEDIA_CACHE_DIR/v1 (bounded, never throws)
src/proxy/idempotency.ts   in-process idempotency store for POST /v3/* (single-instance)
tests/*.test.ts            bun test suite (health, config, errors, logger, lifecycle, proxy, media)
Dockerfile                 bun-slim runtime image, non-root, healthchecked
docker-compose.yml         local container run with a media-cache volume
.env.example               documented defaults (copy to .env, never commit .env)
```

## Dependencies

Zero runtime dependencies. `devDependencies` are TypeScript plus `@types/bun` and
`@types/node` for `bun run typecheck` only; nothing is installed with
`bun install --production` inside the image.
