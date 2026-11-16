import { describe, expect, test } from "bun:test";
import { createLogger, type LogFields } from "../src/logging/logger";

/** Logger wired to an in-memory sink; returns parsed JSON records. */
function loggedRecords(
  fn: (log: (msg: string, fields?: LogFields) => void) => void,
): Record<string, unknown>[] {
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", sink: (line) => lines.push(line) });
  fn((msg, fields) => logger.info(msg, fields));
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function loggedRaw(fn: (log: (msg: string, fields?: LogFields) => void) => void): string {
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", sink: (line) => lines.push(line) });
  fn((msg, fields) => logger.info(msg, fields));
  return lines.join("\n");
}

describe("logger record shape", () => {
  test("emits level, time, msg plus caller fields", () => {
    const [record] = loggedRecords((log) =>
      log("request", { requestId: "r-1", status: 200 }),
    );
    expect(record?.["level"]).toBe("info");
    expect(typeof record?.["time"]).toBe("string");
    expect(record?.["msg"]).toBe("request");
    expect(record?.["requestId"]).toBe("r-1");
    expect(record?.["status"]).toBe(200);
  });

  test("level filtering drops records below the configured level", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", sink: (line) => lines.push(line) });
    logger.info("dropped");
    logger.warn("kept");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("kept");
  });

  test("child bindings appear on every record", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (line) => lines.push(line) });
    logger.child({ requestId: "r-9" }).info("hi");
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record["requestId"]).toBe("r-9");
  });
});

describe("logger redaction", () => {
  test("redacts a top-level apiKey", () => {
    const raw = loggedRaw((log) => log("t", { apiKey: "TOP-SECRET-KEY" }));
    expect(raw).not.toContain("TOP-SECRET-KEY");
    const [record] = loggedRecords((log) => log("t", { apiKey: "TOP-SECRET-KEY" }));
    expect(record?.["apiKey"]).toBe("[REDACTED]");
  });

  test("redacts a nested portrait_image inside an array", () => {
    const [record] = loggedRecords((log) =>
      log("t", { items: [{ portrait_image: "BASE64-BYTES-HERE" }] }),
    );
    const items = record?.["items"] as Record<string, unknown>[];
    expect(items[0]?.["portrait_image"]).toBe("[REDACTED]");
    const raw = loggedRaw((log) =>
      log("t", { items: [{ portrait_image: "BASE64-BYTES-HERE" }] }),
    );
    expect(raw).not.toContain("BASE64-BYTES-HERE");
  });

  test("redaction is case-insensitive and matches key variants", () => {
    const [record] = loggedRecords((log) =>
      log("t", {
        Authorization: "Bearer abc",
        "x-api-key": "k",
        selfieUrl: "https://example.invalid/s",
        PASSWORD: "p",
      }),
    );
    expect(record?.["Authorization"]).toBe("[REDACTED]");
    expect(record?.["x-api-key"]).toBe("[REDACTED]");
    expect(record?.["selfieUrl"]).toBe("[REDACTED]");
    expect(record?.["PASSWORD"]).toBe("[REDACTED]");
  });

  test("survives a circular object", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj["self"] = obj;
    let raw = "";
    expect(() => {
      raw = loggedRaw((log) => log("t", { obj }));
    }).not.toThrow();
    expect(raw).toContain("[Circular]");
  });

  test("survives a circular array", () => {
    const arr: unknown[] = [];
    arr.push(arr);
    const raw = loggedRaw((log) => log("t", { arr }));
    expect(raw).toContain("[Circular]");
  });

  test("redacts a secret that appears inside Error.message", () => {
    const raw = loggedRaw((log) =>
      log("t", { err: new Error("upstream failed: apiKey=SUPER-SECRET-123") }),
    );
    expect(raw).not.toContain("SUPER-SECRET-123");
    expect(raw).toContain("[REDACTED]");
  });

  test("redacts a known secret value repeated in an error message", () => {
    const raw = loggedRaw((log) =>
      log("t", {
        token: "hunter2-value",
        err: new Error("call failed for hunter2-value"),
      }),
    );
    expect(raw).not.toContain("hunter2-value");
  });

  test("serialises Error values with name, message and stack", () => {
    const [record] = loggedRecords((log) => log("t", { err: new Error("boom") }));
    const err = record?.["err"] as Record<string, unknown>;
    expect(err["name"]).toBe("Error");
    expect(err["message"]).toBe("boom");
    expect(typeof err["stack"]).toBe("string");
  });

  test("truncates a single string value over 2048 characters", () => {
    const long = "x".repeat(3000);
    const [record] = loggedRecords((log) => log("t", { note: long }));
    const note = record?.["note"] as string;
    expect(note.length).toBeLessThan(long.length);
    expect(note).toContain("[truncated]");
  });

  test("never throws, even when the sink fails", () => {
    const logger = createLogger({
      level: "debug",
      sink: () => {
        throw new Error("sink down");
      },
    });
    expect(() => logger.info("t", { a: 1 })).not.toThrow();
  });
});
