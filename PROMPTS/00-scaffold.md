# Phase 0: scaffold

> **Superseded in part** by `05-no-fallback.md`: the error envelope no longer carries
> `fallbackToOtp`. The relay reports `code`, `message` and `retryable`, and leaves the
> caller's next step alone.

You are building the skeleton of `didit-relay`, a relay service. Build **only** what is listed
under "Scope". Do not implement the Didit proxy yet.

## What this service is

A bank runs its own mandate authorization module inside its VPC. It whitelists the IPs of
partner environments it already has a relationship with; a third-party vendor's addresses
go through security review and are often refused. So the bank will not whitelist any Didit
hostname.

So this relay sits outside the bank and does three things:

1. Proxies Didit API calls, injecting our API key server-side.
2. Fetches and re-serves short-lived presigned biometric media from a stable domain we control.
3. Stores per-authorization evidence packs append-only.

Phase 0 is the skeleton only: config, server, error taxonomy, redaction-safe logging, health
endpoints, a test harness, and container packaging.

## Stack

- Bun 1.4.x. TypeScript, `strict: true`.
- `Bun.serve` for HTTP. No Express, no Fastify, no Hono.
- `bun test` for tests.
- Zero runtime dependencies is the target. If you add one, justify it in the README.

## Scope

Create exactly this layout:

```
src/config.ts              env parsing, validation, typed Config, fail fast at boot
src/server.ts              Bun.serve, route table, graceful shutdown
src/http/errors.ts         AppError hierarchy
src/logging/logger.ts      structured JSON logger with recursive redaction
src/routes/health.ts       GET /healthz, GET /readyz
src/routes/passthrough.ts  stub only: responds 501
tests/*.test.ts
Dockerfile
docker-compose.yml
.env.example
.dockerignore
package.json
tsconfig.json
README.md
```

### Config

Parse and validate at boot. Required: `DIDIT_API_KEY`. Optional with defaults:

| Key | Default |
| - | - |
| `PORT` | `8080` |
| `DIDIT_API_BASE` | `https://verification.didit.me` |
| `UPSTREAM_TIMEOUT_MS` | `1200` |
| `MEDIA_CACHE_DIR` | `./.cache/media` |
| `LOG_LEVEL` | `info` |
| `NODE_ENV` | `development` |

Missing or invalid config must exit non-zero with a single readable line. Never print the key
value, only whether it is present.

### Endpoints

- `GET /healthz` returns `200` with `{"status":"ok"}`. No config dependency.
- `GET /readyz` returns `200` when config is valid, `503` otherwise.
- Anything under `/v3/*` returns `501` with the error envelope. Stub only.

### Error taxonomy

A typed `AppError` with: `code`, `httpStatus`, `retryable`, `fallbackToOtp`, `message`.
Required codes: `UPSTREAM_TIMEOUT`, `UPSTREAM_ERROR`, `BAD_REQUEST`, `NOT_FOUND`,
`UNAUTHORIZED`, `INTERNAL`.

`fallbackToOtp` is the flag the caller uses to decide whether to fall back to an OTP challenge.
Timeouts and upstream failures must set it `true`. Client errors must set it `false`.

Error responses use a stable envelope:

```json
{ "error": { "code": "UPSTREAM_TIMEOUT", "message": "...", "retryable": true, "fallbackToOtp": true } }
```

### Logger

JSON lines to stdout. Fields: `level`, `time`, `msg`, `requestId`, plus caller-supplied fields.

Redaction is the important part. Any key matching this case-insensitive pattern must have its
value replaced with `[REDACTED]` before serialisation:

```
api[_-]?key|authorization|portrait|selfie|image|document|token|secret|password|cookie
```

Requirements:

- Redaction applies recursively through nested objects and arrays.
- It also applies to `Error.message` and `Error.stack`.
- Circular references must not throw; serialise them as `"[Circular]"`.
- The logger never throws. A failed log write must not take down a request.
- Truncate any single string value over 2048 characters.

### Tests

`bun test` must cover at least:

1. `/healthz` returns 200 and the documented body.
2. `/readyz` returns 200 with valid config.
3. `/readyz` returns 503 with invalid config.
4. Logger redacts a top-level `apiKey`.
5. Logger redacts a nested `portrait_image` inside an array.
6. Logger survives a circular object.
7. Logger redacts a secret that appears inside `Error.message`.
8. `AppError` maps each code to its documented status and `fallbackToOtp` value.
9. `/v3/session/` returns 501 with the error envelope.

## Didit contract (reference only, do not implement)

Included so later phases do not invent field names.

- Base: `https://verification.didit.me`
- Auth: `x-api-key` header
- `POST /v3/session/` with `workflow_id`, `vendor_data`, optional `portrait_image`
  (base64 JPEG, max 1MB)
- `GET /v3/session/{sessionId}/decision/`
- `PATCH /v3/session/{sessionId}/update-status/` with the new status
- `GET /v3/session/{sessionId}/generate-pdf/`
- Media fields (`portrait_image`, `front_image`, `document_file`) are presigned URLs with a
  short validity window. The host is documented only as `<media-host>`.

If you are unsure of a field name, do not guess. Leave a `TODO(contract)` comment.

## Hard rules

- No secrets in the repo. No real API key anywhere, including tests and examples.
- Never log request or response bodies. Log method, path, status, duration, requestId only.
- `bun run typecheck` must pass under `strict`.
- Every command in the README must work from a clean clone.
- Do not create anything outside this directory.

## Done means

From a clean checkout, all of these pass:

```
bun install
bun run typecheck
bun test
docker build -t didit-relay .
```

And this finds only redaction rules, never body logging:

```
grep -rn "portrait\|selfie" src/
```
