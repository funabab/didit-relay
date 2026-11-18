import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logging/logger";
import { createApp } from "../src/server";

const VALID_ENV: Record<string, string | undefined> = {
  DIDIT_API_KEY: "test-placeholder-key",
};

// Routing tests assert on responses, not log lines; keep the suite quiet.
const QUIET = { logger: createLogger({ level: "error", sink: () => {} }) };

function get(appPath: string): Request {
  return new Request(`http://localhost${appPath}`, { method: "GET" });
}

describe("health endpoints", () => {
  test("/healthz returns 200 and the documented body", async () => {
    const app = createApp({ ...VALID_ENV }, QUIET);
    const res = await app.fetch(get("/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("/healthz has no config dependency (200 even when invalid)", async () => {
    const app = createApp({}, QUIET);
    expect(app.isReady).toBe(false);
    const res = await app.fetch(get("/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("/readyz returns 200 with valid config", async () => {
    const app = createApp({ ...VALID_ENV }, QUIET);
    const res = await app.fetch(get("/readyz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
  });

  test("/readyz returns 503 with invalid config", async () => {
    const app = createApp({}, QUIET);
    const res = await app.fetch(get("/readyz"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; reason: string };
    expect(body.status).toBe("not_ready");
    expect(typeof body.reason).toBe("string");
  });

  test("/readyz returns 503 when an optional value is malformed", async () => {
    const app = createApp({ ...VALID_ENV, PORT: "not-a-port" }, QUIET);
    const res = await app.fetch(get("/readyz"));
    expect(res.status).toBe(503);
  });
});

describe("proxy early rejects (no upstream call, no network)", () => {
  test("an unsafe /v3 path returns 404 with the error envelope", async () => {
    const app = createApp({ ...VALID_ENV }, QUIET);
    const res = await app.fetch(get("/v3/%2e%2e%2f%2e%2e%2fetc/passwd"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string; retryable: boolean; fallbackToOtp: boolean };
    };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(typeof body.error.message).toBe("string");
    expect(typeof body.error.retryable).toBe("boolean");
    expect(typeof body.error.fallbackToOtp).toBe("boolean");
  });

  test("a /v3 body over the cap returns 413 without calling upstream", async () => {
    const app = createApp({ ...VALID_ENV, UPSTREAM_MAX_BODY_BYTES: "16" }, QUIET);
    const res = await app.fetch(
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ portrait_image: "x".repeat(64) }),
      }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("routing", () => {
  test("unknown paths return 404 with the error envelope", async () => {
    const app = createApp({ ...VALID_ENV }, QUIET);
    const res = await app.fetch(get("/does-not-exist"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("responses carry the request id header", async () => {
    const app = createApp({ ...VALID_ENV }, QUIET);
    const res = await app.fetch(get("/healthz"));
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("request id propagation", () => {
  function appWithSink(): {
    app: ReturnType<typeof createApp>;
    lines: string[];
  } {
    const lines: string[] = [];
    const app = createApp(
      { ...VALID_ENV },
      { logger: createLogger({ level: "debug", sink: (line) => lines.push(line) }) },
    );
    return { app, lines };
  }

  function accessRecord(lines: string[]): Record<string, unknown> {
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const access = records.find((record) => record["msg"] === "request");
    if (access === undefined) {
      throw new Error("no access log line emitted");
    }
    return access;
  }

  test("a valid inbound id is echoed and logged as inbound", async () => {
    const { app, lines } = appWithSink();
    const inbound = "bank-trace_2024.11:7";
    const res = await app.fetch(
      new Request("http://localhost/healthz", {
        method: "GET",
        headers: { "x-request-id": inbound },
      }),
    );
    expect(res.headers.get("x-request-id")).toBe(inbound);
    const access = accessRecord(lines);
    expect(access["requestId"]).toBe(inbound);
    expect(access["requestIdSource"]).toBe("inbound");
  });

  test("junk and oversized inbound ids are replaced and never logged", async () => {
    for (const inbound of ["a b/c", "x".repeat(65)]) {
      const { app, lines } = appWithSink();
      const res = await app.fetch(
        new Request("http://localhost/healthz", {
          method: "GET",
          headers: { "x-request-id": inbound },
        }),
      );
      const echoed = res.headers.get("x-request-id");
      expect(echoed).toBeTruthy();
      expect(echoed).not.toBe(inbound);
      const raw = lines.join("\n");
      expect(raw).not.toContain(inbound);
      const access = accessRecord(lines);
      expect(access["requestId"]).toBe(echoed);
      expect(access["requestIdSource"]).toBe("generated");
    }
  });
});
