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

describe("passthrough stub", () => {
  test("/v3/session/ returns 501 with the error envelope", async () => {
    const app = createApp({ ...VALID_ENV }, QUIET);
    const res = await app.fetch(get("/v3/session/"));
    expect(res.status).toBe(501);
    const body = (await res.json()) as {
      error: { code: string; message: string; retryable: boolean; fallbackToOtp: boolean };
    };
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
    expect(typeof body.error.message).toBe("string");
    expect(typeof body.error.retryable).toBe("boolean");
    expect(typeof body.error.fallbackToOtp).toBe("boolean");
  });

  test("other /v3 paths also return the 501 stub", async () => {
    const app = createApp({ ...VALID_ENV }, QUIET);
    const res = await app.fetch(
      new Request("http://localhost/v3/session/abc/decision/", { method: "POST" }),
    );
    expect(res.status).toBe(501);
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
