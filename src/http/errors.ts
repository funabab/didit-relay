/**
 * Application error taxonomy.
 *
 * Every error returned to a caller uses the stable envelope:
 *
 *   { "error": { "code": "...", "message": "...",
 *                "retryable": true, "fallbackToOtp": true } }
 *
 * `retryable` tells the caller whether retrying the same request may succeed.
 * `fallbackToOtp` tells the caller whether it can still complete the
 * authorization another way, via an OTP challenge. Those are independent:
 * an unexpected bug inside the relay (`INTERNAL`) is not retryable, but the
 * caller must still fall back to OTP — our bug must never be the reason a
 * customer cannot authorize a debit.
 */
export type ErrorCode =
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "INTERNAL"
  | "NOT_IMPLEMENTED"
  | "MEDIA_EXPIRED";

interface ErrorDefaults {
  httpStatus: number;
  retryable: boolean;
  fallbackToOtp: boolean;
}

/**
 * Canonical mapping. The same table is documented in README.md;
 * tests/errors.test.ts asserts the two stay in sync.
 *
 * NOT_IMPLEMENTED is retained from phase 0: it backed the /v3/* stub and
 * nothing returns it now that the proxy is implemented.
 */
const DEFAULTS: Record<ErrorCode, ErrorDefaults> = {
  UPSTREAM_TIMEOUT: { httpStatus: 504, retryable: true, fallbackToOtp: true },
  UPSTREAM_ERROR: { httpStatus: 502, retryable: true, fallbackToOtp: true },
  UPSTREAM_RATE_LIMITED: { httpStatus: 429, retryable: true, fallbackToOtp: true },
  PAYLOAD_TOO_LARGE: { httpStatus: 413, retryable: false, fallbackToOtp: false },
  BAD_REQUEST: { httpStatus: 400, retryable: false, fallbackToOtp: false },
  NOT_FOUND: { httpStatus: 404, retryable: false, fallbackToOtp: false },
  UNAUTHORIZED: { httpStatus: 401, retryable: false, fallbackToOtp: false },
  INTERNAL: { httpStatus: 500, retryable: false, fallbackToOtp: true },
  NOT_IMPLEMENTED: { httpStatus: 501, retryable: false, fallbackToOtp: false },
  // A relay media link (or the upstream presign behind it) expired. The
  // caller must request a fresh decision for fresh URLs; retrying the same
  // link or falling back to OTP cannot help.
  MEDIA_EXPIRED: { httpStatus: 410, retryable: false, fallbackToOtp: false },
};

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    fallbackToOtp: boolean;
  };
}

export interface ErrorFlagOverrides {
  retryable?: boolean;
  fallbackToOtp?: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly fallbackToOtp: boolean;

  /**
   * `overrides` adjusts the advisory flags only; the code-to-status
   * mapping in DEFAULTS never changes. It exists for the one case where
   * the same code carries different caller semantics: a 401 from
   * upstream means the relay's own key is wrong, so unlike a caller
   * authentication failure it still allows completing via OTP.
   */
  constructor(code: ErrorCode, message: string, overrides?: ErrorFlagOverrides) {
    super(message);
    this.name = "AppError";
    this.code = code;
    const defaults = DEFAULTS[code];
    this.httpStatus = defaults.httpStatus;
    this.retryable = overrides?.retryable ?? defaults.retryable;
    this.fallbackToOtp = overrides?.fallbackToOtp ?? defaults.fallbackToOtp;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        fallbackToOtp: this.fallbackToOtp,
      },
    };
  }

  toResponse(): Response {
    return Response.json(this.toEnvelope(), { status: this.httpStatus });
  }
}

/**
 * Convert anything thrown inside the request handler into a JSON error
 * response. Unknown values become a generic INTERNAL so internal details
 * never leak to the caller; the handler logs the original.
 */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return err.toResponse();
  }
  return new AppError("INTERNAL", "internal server error").toResponse();
}
