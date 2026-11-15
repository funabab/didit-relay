# didit-relay

Relay service between a bank-hosted mandate authorization module and Didit's identity API.

It exists for one reason: a bank will allowlist one inbound IP and two domains it already
trusts, and nothing else. The relay makes that possible.

Three jobs, built in phases:

1. Proxy Didit API calls so the bank only ever talks to `api.<domain>`.
2. Re-serve short-lived presigned biometric media from `assets.<domain>`.
3. Store per-authorization evidence packs append-only, inside the bank's perimeter.

Status: Phase 0 scaffold. See `PROMPTS/` for the specification handed to the build agent.
