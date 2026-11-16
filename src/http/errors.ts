/**
 * Application error taxonomy.
 *
 * Every error returned to a caller uses the stable envelope:
 *
 *   { "error": { "code": "...", "message": "...",
 *                "retryable": true, "fallbackToOtp": true } }
 *
 * `retryable` tells the caller whether retrying the same request may succeed.
 * `fallbackToOtp` tells the caller whether to fall back to an OTP challenge:
 * timeouts and upstream failures set it `true`, client errors set it `false`.
 */
export type ErrorCode =
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_ERROR"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "INTERNAL"
  | "NOT_IMPLEMENTED";

interface ErrorDefaults {
  httpStatus: number;
  retryable: boolean;
  fallbackToOtp: boolean;
}

/**
 * Canonical mapping. The same table is documented in README.md;
 * tests/errors.test.ts asserts the two stay in sync.
 *
 * NOT_IMPLEMENTED is stub-only: it backs the phase 0 /v3/* stub and the
 * readyz "not ready" path never uses it.
 */
const DEFAULTS: Record<ErrorCode, ErrorDefaults> = {
  UPSTREAM_TIMEOUT: { httpStatus: 504, retryable: true, fallbackToOtp: true },
  UPSTREAM_ERROR: { httpStatus: 502, retryable: true, fallbackToOtp: true },
  BAD_REQUEST: { httpStatus: 400, retryable: false, fallbackToOtp: false },
  NOT_FOUND: { httpStatus: 404, retryable: false, fallbackToOtp: false },
  UNAUTHORIZED: { httpStatus: 401, retryable: false, fallbackToOtp: false },
  INTERNAL: { httpStatus: 500, retryable: false, fallbackToOtp: false },
  NOT_IMPLEMENTED: { httpStatus: 501, retryable: false, fallbackToOtp: false },
};

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    fallbackToOtp: boolean;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly fallbackToOtp: boolean;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    const defaults = DEFAULTS[code];
    this.httpStatus = defaults.httpStatus;
    this.retryable = defaults.retryable;
    this.fallbackToOtp = defaults.fallbackToOtp;
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
