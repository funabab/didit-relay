import { afterEach, describe, expect, test } from "bun:test";
import { createLogger } from "../src/logging/logger";
import { createApp } from "../src/server";

/**
 * Proxy contract tests against a fake upstream (`Bun.serve` on port 0).
 * Nothing here may reach the network: every app under test points at the
 * fake, at a closed loopback port, or at a path rejected before any call.
 */

const FAKE_KEY = "relay-fake-key-PLACEHOLDER-9f8e7d6c5b4a";

interface CapturedCall {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
}

type UpstreamHandler = (call: CapturedCall) => Response | Promise<Response>;

interface FakeUpstream {
  baseUrl: string;
  calls: CapturedCall[];
  stop: () => void;
}

const runningServers: { stop: (force?: boolean) => void }[] = [];

afterEach(() => {
  let server: { stop: (force?: boolean) => void } | undefined;
  while ((server = runningServers.pop()) !== undefined) {
    server.stop(true);
  }
});

function startFakeUpstream(handler: UpstreamHandler): FakeUpstream {
  const calls: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      const call: CapturedCall = {
        method: req.method,
        path: url.pathname,
        query: url.search,
        headers: Object.fromEntries(req.headers.entries()),
        body: await req.text(),
      };
      calls.push(call);
      return handler(call);
    },
  });
  runningServers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

/** A base URL nothing listens on (fast connection-refused, no network). */
function deadBaseUrl(): string {
  const upstream = startFakeUpstream(() => new Response("unused"));
  const baseUrl = upstream.baseUrl;
  upstream.stop();
  return baseUrl;
}

function testApp(
  baseUrl: string,
  env?: Record<string, string | undefined>,
  lines?: string[],
): { app: ReturnType<typeof createApp>; lines: string[] } {
  const sink: string[] = lines ?? [];
  const app = createApp(
    { DIDIT_API_KEY: FAKE_KEY, DIDIT_API_BASE: baseUrl, NODE_ENV: "test", ...env },
    { logger: createLogger({ level: "debug", sink: (line) => sink.push(line) }) },
  );
  return { app, lines: sink };
}

function logRecords(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function accessRecords(lines: string[]): Record<string, unknown>[] {
  return logRecords(lines).filter((record) => record["msg"] === "request");
}

function singleAccessRecord(lines: string[]): Record<string, unknown> {
  const found = accessRecords(lines);
  expect(found).toHaveLength(1);
  return found[0] as Record<string, unknown>;
}

interface ErrorBody {
  error: { code: string; message: string; retryable: boolean };
}

async function errorBody(res: Response): Promise<ErrorBody["error"]> {
  return ((await res.json()) as ErrorBody).error;
}

describe("proxy forwarding", () => {
  test("POST /v3/session/ forwards method, path, query and the exact JSON body", async () => {
    const upstreamBody = JSON.stringify({ session_id: "s-1", status: "In Progress" });
    const upstream = startFakeUpstream(
      () =>
        new Response(upstreamBody, {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const { app } = testApp(upstream.baseUrl);
    const payload = JSON.stringify({ workflow: "biometric_authentication", vendor_data: "o-7" });
    const res = await app.fetch(
      new Request("http://localhost/v3/session/?b=2&a=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.text()).toBe(upstreamBody);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.method).toBe("POST");
    expect(upstream.calls[0]?.path).toBe("/v3/session/");
    expect(upstream.calls[0]?.query).toBe("?b=2&a=1");
    expect(upstream.calls[0]?.body).toBe(payload);
  });

  test("trailing slash is significant: /v3/session and /v3/session/ stay different", async () => {
    const upstream = startFakeUpstream(() => Response.json({ ok: true }));
    const { app } = testApp(upstream.baseUrl);
    await app.fetch(
      new Request("http://localhost/v3/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    await app.fetch(
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls[0]?.path).toBe("/v3/session");
    expect(upstream.calls[1]?.path).toBe("/v3/session/");
  });

  test("PATCH update-status is proxied with no special semantics", async () => {
    const decision = JSON.stringify({ status: "Approved" });
    const upstream = startFakeUpstream(
      () => new Response(decision, { headers: { "content-type": "application/json" } }),
    );
    const { app } = testApp(upstream.baseUrl);
    const res = await app.fetch(
      new Request("http://localhost/v3/session/abc/update-status/", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "Approved" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(decision);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.method).toBe("PATCH");
    expect(upstream.calls[0]?.path).toBe("/v3/session/abc/update-status/");
  });

  test("DELETE keeps a non-empty body and streams the answer back", async () => {
    const upstream = startFakeUpstream(
      () => new Response('{"deleted":true}', { headers: { "content-type": "application/json" } }),
    );
    const { app } = testApp(upstream.baseUrl);
    const res = await app.fetch(
      new Request("http://localhost/v3/session/abc/", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "duplicate" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"deleted":true}');
    expect(upstream.calls[0]?.method).toBe("DELETE");
    expect(upstream.calls[0]?.body).toBe(JSON.stringify({ reason: "duplicate" }));
  });

  test("GET decision answers stream back byte-identical", async () => {
    const decision = JSON.stringify({
      status: "Approved",
      features: ["FACE_MATCH"],
      liveness_checks: [],
    });
    const upstream = startFakeUpstream(
      () => new Response(decision, { headers: { "content-type": "application/json" } }),
    );
    const { app } = testApp(upstream.baseUrl);
    const res = await app.fetch(new Request("http://localhost/v3/session/abc/decision/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(decision);
  });

  test("upstream 405 is forwarded, not special-cased", async () => {
    const upstream = startFakeUpstream(
      () =>
        new Response(JSON.stringify({ detail: "Method not allowed." }), {
          status: 405,
          headers: { "content-type": "application/json" },
        }),
    );
    const { app } = testApp(upstream.baseUrl);
    const res = await app.fetch(new Request("http://localhost/v3/session/"));
    expect(res.status).toBe(405);
    expect(await res.text()).toBe(JSON.stringify({ detail: "Method not allowed." }));
  });
});

describe("header policy", () => {
  test("x-api-key is injected; an inbound x-api-key is dropped, never echoed", async () => {
    const upstream = startFakeUpstream(() => Response.json({ ok: true }));
    const { app } = testApp(upstream.baseUrl);
    const res = await app.fetch(
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "caller-supplied-key" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(upstream.calls[0]?.headers["x-api-key"]).toBe(FAKE_KEY);
    expect(res.headers.get("x-api-key")).toBeNull();
  });

  test("inbound cookie, authorization and x-forwarded-* are not forwarded", async () => {
    const upstream = startFakeUpstream(() => Response.json({ ok: true }));
    const { app } = testApp(upstream.baseUrl);
    await app.fetch(
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session=caller-cookie",
          authorization: "Bearer caller-bearer-value",
          "x-forwarded-for": "9.9.9.9",
          "x-forwarded-proto": "https",
        },
        body: "{}",
      }),
    );
    const seen = upstream.calls[0]?.headers ?? {};
    expect(seen["cookie"]).toBeUndefined();
    expect(seen["authorization"]).toBeUndefined();
    expect(seen["x-forwarded-for"]).toBeUndefined();
    expect(seen["x-forwarded-proto"]).toBeUndefined();
  });

  test("x-forwarded-for carries the socket address only when the server provides it", async () => {
    const upstream = startFakeUpstream(() => Response.json({ ok: true }));
    const { app } = testApp(upstream.baseUrl);
    const req = new Request("http://localhost/v3/session/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
      body: "{}",
    });
    await app.fetch(req, { requestIP: () => ({ address: "10.1.2.3" }) });
    // The observed socket address wins; the caller-supplied value is gone.
    expect(upstream.calls[0]?.headers["x-forwarded-for"]).toBe("10.1.2.3");
  });

  test("user-agent is appended, accept-encoding is identity, x-request-id correlates", async () => {
    const upstream = startFakeUpstream(() => Response.json({ ok: true }));
    const { app } = testApp(upstream.baseUrl);
    const res = await app.fetch(
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "bank-module/2.4",
          "x-request-id": "bank-trace-1",
        },
        body: "{}",
      }),
    );
    expect(res.headers.get("x-request-id")).toBe("bank-trace-1");
    expect(upstream.calls[0]?.headers["user-agent"]).toBe("bank-module/2.4 didit-relay/1.0");
    expect(upstream.calls[0]?.headers["accept-encoding"]).toBe("identity");
    expect(upstream.calls[0]?.headers["x-request-id"]).toBe("bank-trace-1");
  });

  test("upstream set-cookie and server are dropped; location survives a 302", async () => {
    const upstream = startFakeUpstream(
      () =>
        new Response(null, {
          status: 302,
          headers: {
            location: "https://other.example/x",
            "set-cookie": "tracking=1",
            server: "gunicorn",
          },
        }),
    );
    const { app } = testApp(upstream.baseUrl);
    const res = await app.fetch(new Request("http://localhost/v3/session/"));
    // Manual redirect handling: returned to the caller, never followed.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://other.example/x");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("server")).toBeNull();
    expect(upstream.calls).toHaveLength(1);
  });
});

describe("error mapping", () => {
  test("content-type survives in both directions; upstream 4xx body is byte-identical", async () => {
    const fieldErrors = JSON.stringify({
      portrait_image: [
        "No stored face image was found for this user. Send a portrait_image, or complete an approved verification first.",
      ],
    });
    const upstream = startFakeUpstream(
      () =>
        new Response(fieldErrors, {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const { app } = testApp(upstream.baseUrl);
    const res = await app.fetch(
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: "biometric_authentication" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(upstream.calls[0]?.headers["content-type"]).toBe("application/json");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe(fieldErrors);
  });

  test("a 400 carrying application/json is forwarded byte-identical with its status", async () => {
    const body = JSON.stringify({ workflow: ["Unknown workflow: nope."] });
    const upstream = startFakeUpstream(
      () =>
        new Response(body, {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
    );
    const { app } = testApp(upstream.baseUrl);
    const res = await app.fetch(
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.text()).toBe(body);
  });

  test("upstream 500 becomes 502 UPSTREAM_ERROR with retryable true", async () => {
    const upstream = startFakeUpstream(
      () => new Response("django blew up", { status: 500, headers: { "content-type": "text/plain" } }),
    );
    const { app, lines } = testApp(upstream.baseUrl);
    const res = await app.fetch(
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(502);
    const rawText = await res.text();
    expect(rawText).not.toContain("django blew up");
    const err = (JSON.parse(rawText) as ErrorBody).error;
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.retryable).toBe(true);
    const access = singleAccessRecord(lines);
    expect(access["attempts"]).toBe(1);
    expect(access["upstreamStatus"]).toBe(500);
    const failures = logRecords(lines).filter((record) => record["msg"] === "upstream request failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.["code"]).toBe("UPSTREAM_ERROR");
  });

  test("upstream 429 maps to UPSTREAM_RATE_LIMITED and preserves retry-after", async () => {
    const upstream = startFakeUpstream(
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "content-type": "text/plain", "retry-after": "30" },
        }),
    );
    const { app, lines } = testApp(upstream.baseUrl);
    // GET on purpose: a 429 must not trigger the read retry either.
    const res = await app.fetch(new Request("http://localhost/v3/session/abc/decision/"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    const err = await errorBody(res);
    expect(err.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(err.retryable).toBe(true);
    expect(JSON.stringify(err)).not.toContain("slow down");
    expect(upstream.calls).toHaveLength(1);
    expect(singleAccessRecord(lines)["attempts"]).toBe(1);
  });

  test("upstream 401 means our key is wrong: envelope out, error logged, body dropped", async () => {
    const upstream = startFakeUpstream(
      () => new Response("bad key detail", { status: 401, headers: { "content-type": "text/plain" } }),
    );
    const { app, lines } = testApp(upstream.baseUrl);
    const res = await app.fetch(
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
    const err = await errorBody(res);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.retryable).toBe(false);
    expect(JSON.stringify(err)).not.toContain("bad key detail");
    const failures = logRecords(lines).filter((record) => record["msg"] === "upstream request failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.["code"]).toBe("UNAUTHORIZED");
  });

  test("a 404 carrying text/html becomes 502 and the HTML is not forwarded", async () => {
    const html = "<html><body><h1>Not Found</h1></body></html>";
    const upstream = startFakeUpstream(
      () => new Response(html, { status: 404, headers: { "content-type": "text/html" } }),
    );
    const { app, lines } = testApp(upstream.baseUrl);
    const res = await app.fetch(new Request("http://localhost/v3/no-such-path/"));
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    const raw = await res.text();
    expect(raw).not.toContain("<html>");
    const err = (JSON.parse(raw) as ErrorBody).error;
    expect(err.code).toBe("UPSTREAM_ERROR");
    const failures = logRecords(lines).filter((record) => record["msg"] === "upstream request failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.["upstreamContentType"]).toBe("text/html");
  });

  test("an error response carries no fallback key anywhere on the wire", async () => {
    // String search on the serialized body, not a parsed shape: a later
    // refactor must not quietly reintroduce the removed field. The needle
    // is assembled so this guard itself keeps the `grep` gate clean.
    const removed = ["fallback", "ToOtp"].join("");
    const upstream = startFakeUpstream(
      () => new Response("django blew up", { status: 500, headers: { "content-type": "text/plain" } }),
    );
    const { app } = testApp(upstream.baseUrl);
    const res = await app.fetch(
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(502);
    const rawText = await res.text();
    expect(rawText).not.toContain(removed);
    expect(Object.keys((JSON.parse(rawText) as ErrorBody).error).sort()).toEqual([
      "code",
      "message",
      "retryable",
    ]);
  });
});

describe("timeout budget and retry", () => {
  test("a hanging upstream becomes 504 within the budget plus slack", async () => {
    const upstream = startFakeUpstream(async () => {
      await Bun.sleep(5000);
      return new Response("too late");
    });
    const { app, lines } = testApp(upstream.baseUrl, { UPSTREAM_WRITE_TIMEOUT_MS: "200" });
    const startedAt = Date.now();
    const res = await app.fetch(
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    const elapsedMs = Date.now() - startedAt;
    expect(res.status).toBe(504);
    expect(elapsedMs).toBeLessThan(200 + 250);
    const err = await errorBody(res);
    expect(err.code).toBe("UPSTREAM_TIMEOUT");
    expect(err.retryable).toBe(true);
    const access = singleAccessRecord(lines);
    expect(access["attempts"]).toBe(1);
    expect(access["upstreamStatus"]).toBeNull();
    const timeouts = logRecords(lines).filter((record) => record["msg"] === "upstream timed out");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]?.["code"]).toBe("UPSTREAM_TIMEOUT");
  });

  test("a GET honours the read budget: a hang answers 504 at ~1500 ms", async () => {
    const upstream = startFakeUpstream(async () => {
      await Bun.sleep(15000);
      return new Response("too late");
    });
    const { app, lines } = testApp(upstream.baseUrl);
    const startedAt = Date.now();
    const res = await app.fetch(new Request("http://localhost/v3/session/abc/decision/"));
    const elapsedMs = Date.now() - startedAt;
    expect(res.status).toBe(504);
    expect((await errorBody(res)).code).toBe("UPSTREAM_TIMEOUT");
    expect(elapsedMs).toBeGreaterThanOrEqual(1500 - 250);
    expect(elapsedMs).toBeLessThan(1500 + 1500);
    expect(singleAccessRecord(lines)["attempts"]).toBe(1);
  });

  test("a POST honours the write budget: a hang answers 504 at ~5000 ms", async () => {
    const upstream = startFakeUpstream(async () => {
      await Bun.sleep(15000);
      return new Response("too late");
    });
    const { app, lines } = testApp(upstream.baseUrl);
    const startedAt = Date.now();
    const res = await app.fetch(
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    const elapsedMs = Date.now() - startedAt;
    expect(res.status).toBe(504);
    expect((await errorBody(res)).code).toBe("UPSTREAM_TIMEOUT");
    expect(elapsedMs).toBeGreaterThanOrEqual(5000 - 250);
    expect(elapsedMs).toBeLessThan(5000 + 1500);
    expect(singleAccessRecord(lines)["attempts"]).toBe(1);
  }, 15000);

  test("GET is retried once on transport failure; attempts 2 is logged", async () => {
    const { app, lines } = testApp(deadBaseUrl());
    const res = await app.fetch(new Request("http://localhost/v3/session/abc/decision/"));
    expect(res.status).toBe(502);
    expect((await errorBody(res)).code).toBe("UPSTREAM_ERROR");
    const access = singleAccessRecord(lines);
    expect(access["attempts"]).toBe(2);
    expect(access["upstreamStatus"]).toBeNull();
    const retries = logRecords(lines).filter((record) => record["msg"] === "upstream retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]?.["attempt"]).toBe(2);
    expect(retries[0]?.["reason"]).toBe("transport-error");
  });

  test("POST is never retried on transport failure; attempts stays 1", async () => {
    const { app, lines } = testApp(deadBaseUrl());
    const res = await app.fetch(
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(502);
    expect((await errorBody(res)).code).toBe("UPSTREAM_ERROR");
    expect(singleAccessRecord(lines)["attempts"]).toBe(1);
    expect(logRecords(lines).filter((record) => record["msg"] === "upstream retry")).toHaveLength(0);
  });

  test("GET 503 then 200 retries once and streams the recovery", async () => {
    let seen = 0;
    const upstream = startFakeUpstream(() => {
      seen += 1;
      if (seen === 1) {
        return new Response("try again", { status: 503, headers: { "content-type": "text/plain" } });
      }
      return new Response('{"status":"Approved"}', {
        headers: { "content-type": "application/json" },
      });
    });
    const { app, lines } = testApp(upstream.baseUrl);
    const res = await app.fetch(new Request("http://localhost/v3/session/abc/decision/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"status":"Approved"}');
    expect(upstream.calls).toHaveLength(2);
    expect(singleAccessRecord(lines)["attempts"]).toBe(2);
    const retries = logRecords(lines).filter((record) => record["msg"] === "upstream retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]?.["reason"]).toBe("upstream-503");
    expect(retries[0]?.["upstreamStatus"]).toBe(503);
  });
});

describe("body cap and path safety", () => {
  test("a body over the cap answers 413 and the upstream records zero calls", async () => {
    const upstream = startFakeUpstream(() => Response.json({ ok: true }));
    const { app, lines } = testApp(upstream.baseUrl, { UPSTREAM_MAX_BODY_BYTES: "16" });
    const res = await app.fetch(
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: "biometric_authentication", pad: "x".repeat(64) }),
      }),
    );
    expect(res.status).toBe(413);
    const err = await errorBody(res);
    expect(err.code).toBe("PAYLOAD_TOO_LARGE");
    expect(err.retryable).toBe(false);
    expect(upstream.calls).toHaveLength(0);
    expect(singleAccessRecord(lines)["attempts"]).toBe(0);
  });

  test("encoded traversal and scheme tricks are refused with 404", async () => {
    const upstream = startFakeUpstream(() => Response.json({ ok: true }));
    const { app } = testApp(upstream.baseUrl);
    for (const target of [
      "/v3/%2e%2e%2f%2e%2e%2fetc/passwd",
      "/v3/%2E%2E/x",
      "/v3/%5c..",
      "/v3%5c..%5cx",
      "//evil.example/v3/x",
    ]) {
      const res = await app.fetch(new Request(`http://localhost${target}`));
      expect(res.status).toBe(404);
      expect((await errorBody(res)).code).toBe("NOT_FOUND");
    }
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("idempotency", () => {
  function idempotentPost(path: string, key: string, body = "{}"): Request {
    return new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body,
    });
  }

  test("a repeat with the same key replays without calling upstream again", async () => {
    const created = JSON.stringify({ session_id: "s-9", status: "In Progress" });
    const upstream = startFakeUpstream(
      () => new Response(created, { status: 201, headers: { "content-type": "application/json" } }),
    );
    const { app, lines } = testApp(upstream.baseUrl);
    const first = await app.fetch(idempotentPost("/v3/session/", "order-7"));
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    expect(await first.text()).toBe(created);

    const second = await app.fetch(idempotentPost("/v3/session/", "order-7"));
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(second.headers.get("content-type")).toBe("application/json");
    expect(await second.text()).toBe(created);
    expect(upstream.calls).toHaveLength(1);

    const accesses = accessRecords(lines);
    expect(accesses).toHaveLength(2);
    expect(accesses[0]?.["replayed"]).toBeUndefined();
    expect(accesses[1]?.["replayed"]).toBe(true);
    expect(accesses[1]?.["attempts"]).toBe(0);
  });

  test("a repeat while the first is in flight waits instead of calling twice", async () => {
    const upstream = startFakeUpstream(async () => {
      await Bun.sleep(100);
      return Response.json({ session_id: "s-10" });
    });
    const { app } = testApp(upstream.baseUrl);
    const [first, second] = await Promise.all([
      app.fetch(idempotentPost("/v3/session/", "order-8")),
      app.fetch(idempotentPost("/v3/session/", "order-8")),
    ]);
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    const replayed = [first, second].filter(
      (res) => res?.headers.get("idempotent-replayed") === "true",
    );
    expect(replayed).toHaveLength(1);
  });

  test("a failure is not cached: a 400 then a 200 both reach upstream", async () => {
    let seen = 0;
    const upstream = startFakeUpstream(() => {
      seen += 1;
      if (seen === 1) {
        return new Response(JSON.stringify({ workflow: ["required"] }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({ session_id: "s-11" });
    });
    const { app } = testApp(upstream.baseUrl);
    const first = await app.fetch(idempotentPost("/v3/session/", "order-9"));
    expect(first.status).toBe(400);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const second = await app.fetch(idempotentPost("/v3/session/", "order-9"));
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotent-replayed")).toBeNull();
    expect(upstream.calls).toHaveLength(2);
  });

  test("the same key on different paths does not collide", async () => {
    const upstream = startFakeUpstream((call) =>
      Response.json({ echoed: call.path }, { status: 201 }),
    );
    const { app } = testApp(upstream.baseUrl);
    await app.fetch(idempotentPost("/v3/session/", "shared-key"));
    const other = await app.fetch(idempotentPost("/v3/session/abc/decision/", "shared-key"));
    expect(other.headers.get("idempotent-replayed")).toBeNull();
    expect(upstream.calls).toHaveLength(2);
    const replay = await app.fetch(idempotentPost("/v3/session/", "shared-key"));
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(upstream.calls).toHaveLength(2);
  });

  test("a malformed key is treated as absent, not cached and not rejected", async () => {
    const upstream = startFakeUpstream(() => Response.json({ ok: true }));
    const { app } = testApp(upstream.baseUrl);
    for (let round = 0; round < 2; round += 1) {
      const res = await app.fetch(
        new Request("http://localhost/v3/session/", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "not a valid key!" },
          body: "{}",
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("idempotent-replayed")).toBeNull();
    }
    expect(upstream.calls).toHaveLength(2);
  });
});

describe("secret hygiene", () => {
  test("the API key never appears in any captured log line", async () => {
    const upstream = startFakeUpstream((call) => {
      if (call.path === "/v3/boom/") {
        return new Response("kaboom", { status: 500 });
      }
      if (call.path === "/v3/denied/") {
        return new Response("no", { status: 401 });
      }
      if (call.path === "/v3/slow/") {
        return (async () => {
          await Bun.sleep(5000);
          return new Response("late");
        })();
      }
      return Response.json({ ok: true });
    });
    const lines: string[] = [];
    const keyed = testApp(upstream.baseUrl, { UPSTREAM_TIMEOUT_MS: "100" }, lines);
    const dead = testApp(deadBaseUrl(), undefined, lines);
    // Success, mapped 5xx, 401, timeout, transport failure.
    await keyed.app.fetch(
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    await keyed.app.fetch(new Request("http://localhost/v3/boom/"));
    await keyed.app.fetch(new Request("http://localhost/v3/denied/"));
    await keyed.app.fetch(new Request("http://localhost/v3/slow/"));
    await dead.app.fetch(new Request("http://localhost/v3/session/"));
    // The key went upstream every time the fake was reached.
    for (const call of upstream.calls) {
      expect(call.headers["x-api-key"]).toBe(FAKE_KEY);
    }
    expect(upstream.calls.length).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(FAKE_KEY);
  });
});
