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
}[] = [
  { code: "UPSTREAM_TIMEOUT", httpStatus: 504, retryable: true },
  { code: "UPSTREAM_ERROR", httpStatus: 502, retryable: true },
  { code: "UPSTREAM_RATE_LIMITED", httpStatus: 429, retryable: true },
  { code: "PAYLOAD_TOO_LARGE", httpStatus: 413, retryable: false },
  { code: "BAD_REQUEST", httpStatus: 400, retryable: false },
  { code: "NOT_FOUND", httpStatus: 404, retryable: false },
  { code: "UNAUTHORIZED", httpStatus: 401, retryable: false },
  { code: "INTERNAL", httpStatus: 500, retryable: false },
  { code: "MEDIA_EXPIRED", httpStatus: 410, retryable: false },
];

describe("AppError taxonomy", () => {
  for (const expected of CASES) {
    test(`${expected.code} maps to ${expected.httpStatus} with retryable=${expected.retryable}`, () => {
      const err = new AppError(expected.code, "boom");
      expect(err.code).toBe(expected.code);
      expect(err.httpStatus).toBe(expected.httpStatus);
      expect(err.retryable).toBe(expected.retryable);
      expect(err.message).toBe("boom");
    });
  }

  test("timeouts and upstream failures are retryable; client errors are not", () => {
    for (const code of ["UPSTREAM_TIMEOUT", "UPSTREAM_ERROR"] as const) {
      expect(new AppError(code, "x").retryable).toBe(true);
    }
    for (const code of ["BAD_REQUEST", "NOT_FOUND", "UNAUTHORIZED"] as const) {
      expect(new AppError(code, "x").retryable).toBe(false);
    }
  });

  test("our own bug is not retryable: the same request would hit the same bug", () => {
    expect(new AppError("INTERNAL", "x").retryable).toBe(false);
  });

  test("toResponse uses the stable envelope and mapped status", async () => {
    const res = new AppError("UPSTREAM_TIMEOUT", "upstream timed out").toResponse();
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      error: {
        code: "UPSTREAM_TIMEOUT",
        message: "upstream timed out",
        retryable: true,
      },
    });
  });

  test("toEnvelope carries exactly code, message and retryable for every code", () => {
    // Every code in the table, including NOT_IMPLEMENTED which the mapping
    // oracle above omits (nothing returns it now that the proxy exists).
    const codes: ErrorCode[] = [...CASES.map((entry) => entry.code), "NOT_IMPLEMENTED"];
    for (const code of codes) {
      const { error } = new AppError(code, "boom").toEnvelope();
      expect(Object.keys(error).sort()).toEqual(["code", "message", "retryable"]);
    }
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
