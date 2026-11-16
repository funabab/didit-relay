# didit-relay

Relay service between a bank-hosted mandate authorization module and Didit's identity API.

It exists for one reason: a bank will allowlist one inbound IP and two domains it already
trusts, and nothing else. The relay makes that possible.

Three jobs, built in phases:

1. Proxy Didit API calls so the bank only ever talks to `api.<domain>`.
2. Re-serve short-lived presigned biometric media from `assets.<domain>`.
3. Store per-authorization evidence packs append-only, inside the bank's perimeter.

Status: Phase 0 scaffold (config, server, error taxonomy, redaction-safe logging, health
endpoints, tests, container packaging). The Didit proxy is not implemented yet: every
path under `/v3/*` answers `501`.

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
| `DIDIT_API_BASE` | `https://verification.didit.me` | Must be an http(s) URL. |
| `UPSTREAM_TIMEOUT_MS` | `1200` | Positive integer, milliseconds. |
| `MEDIA_CACHE_DIR` | `./.cache/media` | Any non-empty path. |
| `LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. |
| `NODE_ENV` | `development` | Any non-empty string. |

## Endpoints

| Method | Path | Behaviour |
| - | - | - |
| `GET` | `/healthz` | Liveness. Always `200 {"status":"ok"}`; never depends on config. |
| `GET` | `/readyz` | Readiness. `200 {"status":"ready"}` when boot config was valid, otherwise `503 {"status":"not_ready","reason":"..."}`. |
| any | `/v3/*` | Phase 0 stub: `501` with the error envelope. |
| any | anything else | `404` with the error envelope. |

Every response carries an `x-request-id` header.

## Error taxonomy

All errors use one envelope:

```json
{ "error": { "code": "UPSTREAM_TIMEOUT", "message": "...", "retryable": true, "fallbackToOtp": true } }
```

`fallbackToOtp` tells the caller whether to fall back to an OTP challenge. Timeouts and
upstream failures set it `true`; client errors set it `false`.

| Code | HTTP | `retryable` | `fallbackToOtp` |
| - | - | - | - |
| `UPSTREAM_TIMEOUT` | 504 | true | true |
| `UPSTREAM_ERROR` | 502 | true | true |
| `BAD_REQUEST` | 400 | false | false |
| `NOT_FOUND` | 404 | false | false |
| `UNAUTHORIZED` | 401 | false | false |
| `INTERNAL` | 500 | false | false |
| `NOT_IMPLEMENTED` | 501 | false | false |

`NOT_IMPLEMENTED` is stub-only: it backs the phase 0 `/v3/*` stub.

## Logging

JSON lines to stdout: `level`, `time`, `msg`, `requestId`, plus caller fields. Access logs
carry method, path (no query string), status, duration and requestId only. Request and
response bodies are never logged.

Redaction replaces the value of any key matching this case-insensitive pattern with
`[REDACTED]`:

```
api[_-]?key|authorization|portrait|selfie|image|document|token|secret|password|cookie
```

It applies recursively through nested objects and arrays, to `Error.message` and
`Error.stack` contents, and to repeats of already-redacted values. Circular references
serialise as `"[Circular]"`, strings over 2048 characters are truncated, and the logger
never throws: a failed write cannot take down a request.

## Layout

```
src/config.ts              env parsing, validation, typed Config, fail fast at boot
src/server.ts              Bun.serve, route table, graceful shutdown
src/http/errors.ts         AppError hierarchy
src/logging/logger.ts      structured JSON logger with recursive redaction
src/routes/health.ts       GET /healthz, GET /readyz
src/routes/passthrough.ts  stub only: responds 501
tests/*.test.ts            bun test suite (health, config, errors, logger)
Dockerfile                 bun-slim runtime image, non-root, healthchecked
docker-compose.yml         local container run with a media-cache volume
.env.example               documented defaults (copy to .env, never commit .env)
```

## Dependencies

Zero runtime dependencies. `devDependencies` are TypeScript plus `@types/bun` and
`@types/node` for `bun run typecheck` only; nothing is installed with
`bun install --production` inside the image.
