import { describe, expect, test } from "bun:test";
import { AppError, toErrorResponse, type ErrorCode } from "../src/http/errors";

/**
 * Independent oracle for the taxonomy documented in README.md.
 * These literals are deliberately duplicated here (not imported from the
 * implementation) so a drift in either place fails loudly.
 */
const CASES: {
  code: ErrorCode;
  httpStatus: number;
  retryable: boolean;
  fallbackToOtp: boolean;
}[] = [
  { code: "UPSTREAM_TIMEOUT", httpStatus: 504, retryable: true, fallbackToOtp: true },
  { code: "UPSTREAM_ERROR", httpStatus: 502, retryable: true, fallbackToOtp: true },
  { code: "BAD_REQUEST", httpStatus: 400, retryable: false, fallbackToOtp: false },
  { code: "NOT_FOUND", httpStatus: 404, retryable: false, fallbackToOtp: false },
  { code: "UNAUTHORIZED", httpStatus: 401, retryable: false, fallbackToOtp: false },
  { code: "INTERNAL", httpStatus: 500, retryable: false, fallbackToOtp: true },
];

describe("AppError taxonomy", () => {
  for (const expected of CASES) {
    test(`${expected.code} maps to ${expected.httpStatus} with fallbackToOtp=${expected.fallbackToOtp}`, () => {
      const err = new AppError(expected.code, "boom");
      expect(err.code).toBe(expected.code);
      expect(err.httpStatus).toBe(expected.httpStatus);
      expect(err.retryable).toBe(expected.retryable);
      expect(err.fallbackToOtp).toBe(expected.fallbackToOtp);
      expect(err.message).toBe("boom");
    });
  }

  test("timeouts and upstream failures fall back to OTP; client errors do not", () => {
    for (const code of ["UPSTREAM_TIMEOUT", "UPSTREAM_ERROR"] as const) {
      expect(new AppError(code, "x").fallbackToOtp).toBe(true);
    }
    for (const code of ["BAD_REQUEST", "NOT_FOUND", "UNAUTHORIZED"] as const) {
      expect(new AppError(code, "x").fallbackToOtp).toBe(false);
    }
  });

  test("every error except client errors still allows completing via OTP", () => {
    // fallbackToOtp is about the caller, not the request: even our own bug
    // (INTERNAL, not retryable) must not block the authorization.
    for (const code of ["UPSTREAM_TIMEOUT", "UPSTREAM_ERROR", "INTERNAL"] as const) {
      expect(new AppError(code, "x").fallbackToOtp).toBe(true);
    }
    for (const code of ["BAD_REQUEST", "NOT_FOUND", "UNAUTHORIZED"] as const) {
      expect(new AppError(code, "x").fallbackToOtp).toBe(false);
    }
  });

  test("toResponse uses the stable envelope and mapped status", async () => {
    const res = new AppError("UPSTREAM_TIMEOUT", "upstream timed out").toResponse();
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      error: {
        code: "UPSTREAM_TIMEOUT",
        message: "upstream timed out",
        retryable: true,
        fallbackToOtp: true,
      },
    });
  });

  test("toErrorResponse passes AppError through and hides unknown failures", async () => {
    const known = toErrorResponse(new AppError("BAD_REQUEST", "bad input"));
    expect(known.status).toBe(400);

    const unknown = toErrorResponse(new Error("database password=xyz exploded"));
    expect(unknown.status).toBe(500);
    const body = (await unknown.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).not.toContain("xyz");
  });
});
