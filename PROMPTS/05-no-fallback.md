# Phase 3 correction: the relay does not own the fallback

## The error

The error envelope currently carries `fallbackToOtp`:

```json
{ "error": { "code": "UPSTREAM_TIMEOUT", "message": "...", "retryable": true, "fallbackToOtp": true } }
```

That field is a design mistake. It makes the relay assert what the *caller* should do when
verification fails, which is policy the relay has no standing to decide. Whether a failed
liveness check ends the mandate attempt, retries it, or hands the customer to an OTP
challenge is the bank's decision, made in the bank's module, against the bank's own risk
rules. The relay is one component: it verifies or it errors. It does not know, and must not
claim to know, what happens after that.

Remove it. Completely. Not deprecated, not always-`false`, not hidden behind a flag.

## What replaces it

`retryable` survives unchanged: it says whether the *same request* may succeed on retry,
which is a fact about this call, not advice about the mandate.

The envelope becomes:

```json
{ "error": { "code": "UPSTREAM_TIMEOUT", "message": "...", "retryable": true } }
```

Three keys. Nothing else.

## Code

- `src/http/errors.ts`
  - delete `fallbackToOtp` from `ErrorDefaults`, `DEFAULTS`, `ErrorEnvelope`,
    `AppError`, and the file header comment;
  - delete `ErrorFlagOverrides` and the `overrides` parameter of the `AppError`
    constructor. Its single purpose was the `401`-from-upstream case below, and with the
    field gone the parameter has no callers. If you find a second caller, stop and say so
    rather than inventing a replacement mechanism.
  - rewrite the header comment: the envelope is `code`, `message`, `retryable`; the relay
    reports what happened to the call and nothing about the authorization.
- `src/routes/passthrough.ts`
  - delete `flags` from `FailOptions` and the `options?.flags` argument;
  - the `401`-from-upstream branch keeps its code, status and log line, and loses its
    comment about OTP. New comment: the caller cannot distinguish this from a caller
    authentication failure, and the log line is what tells an operator which one happened;
  - rewrite the file header sentence that promises `fallbackToOtp` on every outcome.

## README

- The envelope example and the prose under it: `retryable` only, plus one sentence —
  whether a failed verification ends the attempt, is retried, or is completed another way
  is the caller's decision; the relay does not model it.
- Delete the `fallbackToOtp` column from the error table.
- The `UNAUTHORIZED` footnote: drop the OTP clause, keep the fact that a `401` from
  upstream means the relay's key is wrong and is indistinguishable to the caller from a
  caller authentication failure.
- Add one entry to "Design decisions worth defending":

  **Why the relay does not own the fallback.** It is one module that answers one question.
  If verification fails it returns an error and stops; whether the bank then completes the
  mandate by OTP, retries, or declines outright belongs to the bank, which holds the risk
  and the customer relationship. A relay that advertises a fallback is a relay that thinks
  it owns a decision it does not.

- Intro paragraph, lines about OTP: keep the statement that the bank's module currently asks
  for an OTP and that the change being supported is to replace it with liveness plus a face
  match, but make clear the relay implements neither side of that policy — it carries the
  portrait in and the decision out.

## Tests

- Remove every `fallbackToOtp` expectation from `tests/errors.test.ts`,
  `tests/passthrough.test.ts`, `tests/media.test.ts` and `tests/server.test.ts`, including
  the type annotations that name the field.
- Add two tests that make the removal stay removed:
  1. `AppError.toEnvelope()` has exactly the keys `code`, `message`, `retryable` —
     `Object.keys(error).sort()` equals that list — for every code in the table.
  2. An error response over the wire contains no `fallbackToOtp` key anywhere, checked by
     string search on the serialized body (`"fallbackToOtp"` absent), so a later refactor
     cannot quietly reintroduce it.
- Do not weaken any other assertion to make the change compile.

## Done means

- `grep -rn fallbackToOtp src/ tests/ README.md` returns nothing.
- `bun test` green, `bunx tsc --noEmit` clean.
- `docker build` succeeds and a container start plus `/readyz` still answers `200`.
- No other behaviour changes: path safety, retry eligibility, status mapping, idempotency
  and media serving are untouched.

## Hard rules

- This is a removal, not a refactor. Do not rename the field to something equivalent
  (`shouldFallback`, `callerAction`, `otpEligible`). If the concept reappears under another
  name, the change failed.
- No dependency added. No new config key.
- Do not mention OTP anywhere in `src/` after this change, in a comment or a string.
