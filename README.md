# didit-relay

Relay service between a bank-hosted mandate authorization module and Didit's identity API.

It exists for one reason: a bank will allowlist one inbound IP and two domains it already
trusts, and nothing else. The relay makes that possible.

Three jobs, built in phases:

1. Proxy Didit API calls so the bank only ever talks to `api.<domain>`.
2. Re-serve short-lived presigned biometric media from `assets.<domain>`.
3. Store per-authorization evidence packs append-only, inside the bank's perimeter.

Status: Phase 2 media. `GET`, `POST`, `PATCH` and `DELETE` under `/v3/*` are proxied
to `DIDIT_API_BASE` with key injection, per-method timeout budgets, read-only retry
and per-path `POST` idempotency; presigned media URLs in `2xx` JSON responses are
rewritten to signed links served from this relay at `GET /m/{token}`. Evidence
storage (Phase 3) and webhooks are not implemented.

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
{ "error": { "code": "UPSTREAM_TIMEOUT", "message": "...", "retryable": true, "fallbackToOtp": true } }
```

`retryable` describes whether the same request may succeed on retry.
`fallbackToOtp` describes whether the caller can still complete the authorization
another way, via an OTP challenge. Those are independent: `INTERNAL` is not
retryable (the same request would hit the same bug), but it still sets
`fallbackToOtp: true`, because an unexpected bug inside the relay must never be
the reason a customer cannot authorize a debit.

| Code | HTTP | `retryable` | `fallbackToOtp` |
| - | - | - | - |
| `UPSTREAM_TIMEOUT` | 504 | true | true |
| `UPSTREAM_ERROR` | 502 | true | true |
| `UPSTREAM_RATE_LIMITED` | 429 | true | true |
| `PAYLOAD_TOO_LARGE` | 413 | false | false |
| `BAD_REQUEST` | 400 | false | false |
| `NOT_FOUND` | 404 | false | false |
| `UNAUTHORIZED` | 401 | false | false |
| `INTERNAL` | 500 | false | true |
| `NOT_IMPLEMENTED` | 501 | false | false |
| `MEDIA_EXPIRED` | 410 | false | false |

`NOT_IMPLEMENTED` is retained from phase 0; nothing returns it now that the
proxy replaced the `/v3/*` stub.

`UNAUTHORIZED` needs one footnote: the row above is the taxonomy default for
a caller authentication failure. A `401` from upstream instead means the
relay's own key is wrong, so the proxy answers the same code and status but
with `fallbackToOtp: true` — our misconfiguration must never be the reason
a customer cannot authorize a debit.

## Proxy

Every Didit call the bank makes passes through `/v3/*`, because the bank
allowlists exactly one host. The proxy:

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
  `502`/`503`/`504`, only with at least half the budget left — and never
  retries `POST`, `PATCH`, `DELETE` or `429`;
- passes JSON upstream `4xx` (other than `401`/`429`) through verbatim, so
  the caller sees Didit's own field errors; maps transport failures,
  timeouts, `5xx`, `401` and `429` into the envelope; and maps a non-JSON
  `4xx` (Django answers unknown `/v3/` paths with an HTML page) to
  `UPSTREAM_ERROR` rather than handing a JSON client a page of HTML;
- streams response bodies back without buffering, forwarding only
  `content-type`, `content-length`, `retry-after` and `location` — except
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
images) as presigned URLs on a host separate from the API. The bank
allowlists two domains it already trusts (`api.` and `assets.`) and
cannot fetch those URLs, so the relay re-serves the bytes: `2xx` JSON
responses have their media URLs rewritten to
`${PUBLIC_MEDIA_BASE}/m/{token}`, and `GET /m/{token}` serves the bytes.

Rewriting is shape-agnostic on purpose: no completed session has been
observed yet, so the field names carrying media URLs are unknown.
Rewriting matches by host instead — any string value that parses as an
absolute `http(s)` URL whose host is in `DIDIT_MEDIA_HOSTS` is replaced,
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

Preset TTLs are estimates until a real presigned URL is observed: the
upstream presign lifetime is believed to be roughly an hour, and
`MEDIA_LINK_TTL_MS` defaults to 30 minutes to leave margin. Revisit both
numbers once a completed session shows a real expiry.

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
