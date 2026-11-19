/**
 * Application error taxonomy.
 *
 * Every error returned to a caller uses the stable envelope:
 *
 *   { "error": { "code": "...", "message": "...", "retryable": true } }
 *
 * The envelope is `code`, `message`, `retryable` and nothing else.
 * `retryable` tells the caller whether retrying the same request may
 * succeed. The relay reports what happened to the call and nothing about
 * the authorization.
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
}

/**
 * Canonical mapping. The same table is documented in README.md;
 * tests/errors.test.ts asserts the two stay in sync.
 *
 * NOT_IMPLEMENTED is retained from phase 0: it backed the /v3/* stub and
 * nothing returns it now that the proxy is implemented.
 */
const DEFAULTS: Record<ErrorCode, ErrorDefaults> = {
  UPSTREAM_TIMEOUT: { httpStatus: 504, retryable: true },
  UPSTREAM_ERROR: { httpStatus: 502, retryable: true },
  UPSTREAM_RATE_LIMITED: { httpStatus: 429, retryable: true },
  PAYLOAD_TOO_LARGE: { httpStatus: 413, retryable: false },
  BAD_REQUEST: { httpStatus: 400, retryable: false },
  NOT_FOUND: { httpStatus: 404, retryable: false },
  UNAUTHORIZED: { httpStatus: 401, retryable: false },
  INTERNAL: { httpStatus: 500, retryable: false },
  NOT_IMPLEMENTED: { httpStatus: 501, retryable: false },
  // A relay media link (or the upstream presign behind it) expired. The
  // caller must request a fresh decision for fresh URLs; retrying the same
  // link cannot help.
  MEDIA_EXPIRED: { httpStatus: 410, retryable: false },
};

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    const defaults = DEFAULTS[code];
    this.httpStatus = defaults.httpStatus;
    this.retryable = defaults.retryable;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
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
