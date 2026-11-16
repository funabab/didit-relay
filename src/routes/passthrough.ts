/**
 * Phase 0 stub for the Didit proxy. Every path under `/v3/*` answers 501
 * with the standard error envelope until a later phase implements the
 * upstream call, key injection and media handling.
 */
import { AppError } from "../http/errors";

export function handlePassthrough(): Response {
  return new AppError(
    "NOT_IMPLEMENTED",
    "Didit proxy is not implemented yet (phase 0 stub).",
  ).toResponse();
}
