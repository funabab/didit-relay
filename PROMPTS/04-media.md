# Phase 2: re-serve presigned biometric media

Didit returns biometric media (face crops, liveness frames, document images) as presigned
URLs on a host that is separate from the API and undocumented, valid for roughly an hour.
The bank allowlists two domains it already trusts (`api.` and `assets.`), so it cannot
fetch those URLs. Phase 2 makes `assets.<domain>` serve the bytes.

Non-goals: evidence storage (Phase 3), webhooks, transcoding, thumbnails. Do not add them.

## Why shape-agnostic

We have not observed a completed session yet, so the exact JSON field names carrying media
URLs are unknown. Do **not** guess them. Rewrite by **host**: any string value in a
response body that parses as an absolute `http(s)` URL whose host is in the configured
media host list becomes a relay URL. This is independent of field names and cannot
rewrite an API URL, because API hosts are not in the media list.

## Config

| key | default | meaning |
| --- | --- | --- |
| `DIDIT_MEDIA_HOSTS` | (empty) | Comma-separated hostnames. Empty disables rewriting entirely. |
| `PUBLIC_MEDIA_BASE` | (empty) | Absolute origin the bank reaches, e.g. `https://assets.bank.example`. Empty disables rewriting. |
| `MEDIA_LINK_TTL_MS` | `1800000` | Lifetime of a relay media link. Must stay below the upstream presign lifetime (~1h); 30 min is chosen to leave margin. |
| `MEDIA_CACHE_ENABLED` | `true` | `false` streams every request upstream and writes nothing to disk. |
| `MEDIA_SIGNING_SECRET` | (empty) | Optional. When empty the signing key is derived from `DIDIT_API_KEY` via HKDF-SHA256 with info `media-signing/v1`. |

Rewriting is active only when **both** `DIDIT_MEDIA_HOSTS` and `PUBLIC_MEDIA_BASE` are
set. With either missing, responses pass through untouched and `/m/*` answers `404`.
Validate all five in the existing style: invalid refuses boot, messages carry no values.

## Link format

```
GET /m/{token}
```

`token = base64url(payloadJson) + "." + base64url(hmacSha256(signingKey, payloadJson))`

`payloadJson = {"u":"<upstream url>","e":<unix ms expiry>}`

Rules:

- Verify the signature **before** parsing the payload, with a constant-time compare.
- Reject with `404` when the token is malformed, the signature fails, or the host is not
  in `DIDIT_MEDIA_HOSTS`.
- Reject with `410 MEDIA_EXPIRED` (new code: not retryable, `fallbackToOtp: false`) when
  `e` is in the past.
- The token is the only authority. Never accept a raw URL as a parameter, never accept a
  caller-supplied `Host`, and never follow a redirect from the media host (`redirect:
  "manual"`; a 3xx is an upstream failure).

## Serving

- Read through the disk cache under `MEDIA_CACHE_DIR`, in a `v1/` subdirectory, keyed by
  `sha256(upstream url)`. Store body bytes plus a sidecar holding content-type and the
  fetch time.
- On a miss, fetch the upstream URL under `UPSTREAM_WRITE_TIMEOUT_MS`, stream the body to
  the caller, and write the cache entry only after a successful `2xx`.
- Serve `cache-control: private, max-age={remaining seconds of the link}` and
  `x-content-type-options: nosniff`. Never `public` — this is biometric data.
- Pass through only `content-type` and `content-length` from upstream.
- An upstream `403` or `410` (presign expired) answers `410 MEDIA_EXPIRED` and drops the
  cache entry, so the caller learns to request a fresh decision rather than retry.
- Bound the cache: refuse to write when the directory exceeds `MEDIA_CACHE_MAX_BYTES`
  (default `268435456`, 256 MiB); evict oldest entries first, and never evict an entry
  being written.

## Rewriting

Apply only to responses that are `2xx` **and** `content-type: application/json`:

1. Parse. On a parse failure forward the original bytes untouched — a body we cannot
   parse is not ours to rewrite.
2. Walk objects and arrays. Replace any string that is an absolute `http(s)` URL whose
   host is in `DIDIT_MEDIA_HOSTS` with `${PUBLIC_MEDIA_BASE}/m/${token}`.
3. Re-serialize with `JSON.stringify`. Document in the README that re-serialization
   normalises insignificant whitespace; key order is preserved.
4. Set `content-length` to the new byte length. Drop any upstream `etag`, as it no longer
   matches.

Requests that already carry an `Idempotency-Key` replay a **recorded** body from Phase 1's
store. Rewriting must happen when the response is recorded, not when it is replayed, or a
replay would hand back unrewritten upstream URLs. Record the rewritten bytes.

## Logging

- One line per media serve: `path` (never the token), `cache: hit|miss`, `bytes`,
  `upstreamStatus`, `durationMs`.
- Never log the token, the upstream presigned URL, or the media host.
- Never log the signing secret. Register it alongside the API key.

## Tests

`tests/media.test.ts`, fake upstream on port `0`, temp cache dir per test. No network.

1. A JSON response containing a URL on a configured media host is rewritten to
   `PUBLIC_MEDIA_BASE/m/...`, and a URL on a non-media host is left alone.
2. Nested arrays and objects are rewritten; non-string values are untouched.
3. Two different upstream URLs produce two different tokens; the same URL produces an
   identical token (deterministic signing).
4. A valid token serves the upstream bytes with the upstream content-type.
5. A tampered token (one payload character changed) answers `404` and never fetches.
6. A token signed with a different key answers `404`.
7. An expired token answers `410 MEDIA_EXPIRED` without fetching.
8. A second request for the same URL is served from cache with `cache: hit` and zero
   upstream calls.
9. `MEDIA_CACHE_ENABLED=false` serves twice with two upstream calls and writes no files.
10. Upstream `403` answers `410` and the cache entry is not kept.
11. The link token never appears in any log line.
12. Rewriting is inert when `DIDIT_MEDIA_HOSTS` or `PUBLIC_MEDIA_BASE` is empty: bodies
    are byte-identical to upstream.
13. An idempotent replay of a rewritten response returns the **rewritten** body.

## Done means

- `bun test` green (expect roughly 100+), `bunx tsc --noEmit` clean.
- `docker build` succeeds; container starts with the new env unset (rewriting inert) and
  with them set (rewriting active) without changing any Phase 1 behaviour.
- README: new config rows, a short "Media" section stating the two-domain allowlist
  reason, the token model, the cache liability, and that preset TTLs are estimates until
  a real presigned URL is observed.

## Hard rules

- No dependency added.
- No unauthenticated media access: every `/m/*` request must pass signature and expiry.
- Never write the signing secret or a token into a log, a test fixture, or a file in git.
- Do not touch path safety, header allowlist, retry policy, error mapping or idempotency
  beyond the recording point named above.
