import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logging/logger";
import { MEDIA_LOG_PATH } from "../src/routes/media";
import { createApp } from "../src/server";

/**
 * Phase 2 media contract: host-based rewriting of presigned URLs in
 * proxied JSON, signed `/m/{token}` links, and the read-through disk
 * cache. Two fakes on port 0 stand in for the Didit API and the media
 * host; nothing here may reach the network.
 *
 * Secrets below are obvious placeholders. Tokens are minted at runtime
 * (via the relay's own rewriting, or via the independent oracle under
 * "token format") and never hardcoded.
 */

const FAKE_KEY = "relay-fake-key-PLACEHOLDER-9f8e7d6c5b4a";
const OTHER_KEY = "relay-other-key-PLACEHOLDER-1a2b3c4d5e6f";
const MEDIA_SECRET = "media-test-secret-PLACEHOLDER-7f6e5d4c3b2a";
const PUBLIC_MEDIA_BASE = "https://assets.bank.example";

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
}

const runningServers: { stop: (force?: boolean) => void }[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  let server: { stop: (force?: boolean) => void } | undefined;
  while ((server = runningServers.pop()) !== undefined) {
    server.stop(true);
  }
  let dir: string | undefined;
  while ((dir = tempDirs.pop()) !== undefined) {
    await rm(dir, { recursive: true, force: true });
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
  return { baseUrl: `http://127.0.0.1:${server.port}`, calls };
}

async function testApp(
  apiBaseUrl: string,
  env?: Record<string, string | undefined>,
  lines?: string[],
): Promise<{ app: ReturnType<typeof createApp>; lines: string[]; cacheDir: string }> {
  const cacheDir = await mkdtemp(join(tmpdir(), "didit-media-"));
  tempDirs.push(cacheDir);
  const sink: string[] = lines ?? [];
  const app = createApp(
    {
      DIDIT_API_KEY: FAKE_KEY,
      DIDIT_API_BASE: apiBaseUrl,
      NODE_ENV: "test",
      DIDIT_MEDIA_HOSTS: "127.0.0.1",
      PUBLIC_MEDIA_BASE,
      MEDIA_CACHE_DIR: cacheDir,
      ...env,
    },
    { logger: createLogger({ level: "debug", sink: (line) => sink.push(line) }) },
  );
  expect(app.isReady).toBe(true);
  return { app, lines: sink, cacheDir };
}

/** Presigned-style URL on the fake media host (query string included). */
function mediaUrl(media: FakeUpstream, path = "/face/1.jpg?sig=abc123"): string {
  return `${media.baseUrl}${path}`;
}

function tokenFromRelayUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  expect(url.origin).toBe(PUBLIC_MEDIA_BASE);
  expect(url.pathname.startsWith("/m/")).toBe(true);
  return url.pathname.slice("/m/".length);
}

/**
 * Independent oracle for the link format: builds a token from the spec
 * (`base64url(payload) + "." + base64url(hmac)`) without importing the
 * relay's own minting code. Only usable with an explicit
 * `MEDIA_SIGNING_SECRET`, since the derived key is not reproducible here.
 */
function mintToken(url: string, expiresAtMs: number, secret: string): string {
  const payloadJson = JSON.stringify({ u: url, e: expiresAtMs });
  const payloadBytes = Buffer.from(payloadJson, "utf8");
  const signature = createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(payloadBytes)
    .digest("base64url");
  return `${payloadBytes.toString("base64url")}.${signature}`;
}

function logRecords(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface ErrorBody {
  error: { code: string; message: string; retryable: boolean };
}

async function errorBody(res: Response): Promise<ErrorBody["error"]> {
  return ((await res.json()) as ErrorBody).error;
}

/** Entries directly under the cache dir (the `v1/` subdirectory when used). */
async function cacheDirEntries(cacheDir: string): Promise<string[]> {
  return readdir(cacheDir);
}

/** Entries under the cache `v1/` subdirectory ([] when never created). */
async function cacheV1Entries(cacheDir: string): Promise<string[]> {
  try {
    return await readdir(join(cacheDir, "v1"));
  } catch {
    return [];
  }
}

describe("rewriting", () => {
  test("a media-host URL is rewritten, other hosts are left alone", async () => {
    const media = startFakeUpstream(() => new Response("unused"));
    const face = mediaUrl(media);
    const api = startFakeUpstream(() =>
      Response.json({
        face,
        api: "https://verification.didit.me/v3/session/abc",
        other: "https://other.example/y",
      }),
    );
    const { app } = await testApp(api.baseUrl);
    const res = await app.fetch(new Request("http://localhost/v3/session/abc/decision/"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(Number(res.headers.get("content-length"))).toBe(Buffer.byteLength(text));
    const body = JSON.parse(text) as Record<string, string>;
    expect(body["face"]?.startsWith(`${PUBLIC_MEDIA_BASE}/m/`)).toBe(true);
    expect(tokenFromRelayUrl(body["face"] as string).split(".")).toHaveLength(2);
    expect(body["api"]).toBe("https://verification.didit.me/v3/session/abc");
    expect(body["other"]).toBe("https://other.example/y");
  });

  test("nested arrays and objects are rewritten; non-strings are untouched", async () => {
    const media = startFakeUpstream(() => new Response("unused"));
    const first = mediaUrl(media, "/a.jpg");
    const second = mediaUrl(media, "/b.jpg");
    const api = startFakeUpstream(() =>
      Response.json({
        list: [{ img: first }, second],
        nested: { deep: [first, 42, true, null, "plain"] },
        n: 7,
        b: false,
        z: null,
        s: "not a url",
      }),
    );
    const { app } = await testApp(api.baseUrl);
    const res = await app.fetch(new Request("http://localhost/v3/session/abc/decision/"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      list: [{ img: string }, string];
      nested: { deep: [string, number, boolean, null, string] };
      n: number;
      b: boolean;
      z: null;
      s: string;
    };
    for (const rewritten of [body.list[0].img, body.list[1], body.nested.deep[0]]) {
      expect(rewritten.startsWith(`${PUBLIC_MEDIA_BASE}/m/`)).toBe(true);
    }
    expect(body.nested.deep[1]).toBe(42);
    expect(body.nested.deep[2]).toBe(true);
    expect(body.nested.deep[3]).toBeNull();
    expect(body.nested.deep[4]).toBe("plain");
    expect(body.n).toBe(7);
    expect(body.b).toBe(false);
    expect(body.z).toBeNull();
    expect(body.s).toBe("not a url");
  });

  test("the same URL yields an identical token, different URLs differ", async () => {
    const media = startFakeUpstream(() => new Response("unused"));
    const urlA = mediaUrl(media, "/a.jpg");
    const urlB = mediaUrl(media, "/b.jpg");
    const api = startFakeUpstream(() => Response.json({ first: urlA, second: urlA, other: urlB }));
    const { app } = await testApp(api.baseUrl);
    const res = await app.fetch(new Request("http://localhost/v3/session/abc/decision/"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body["first"]).toBe(body["second"]);
    expect(body["first"]).not.toBe(body["other"]);
  });

  test("rewriting is inert with either key empty: bodies stay byte-identical", async () => {
    const media = startFakeUpstream(() => new Response("unused"));
    const upstreamBody = JSON.stringify({ face: mediaUrl(media) }, null, 2);
    const api = startFakeUpstream(
      () => new Response(upstreamBody, { headers: { "content-type": "application/json" } }),
    );
    for (const env of [{ DIDIT_MEDIA_HOSTS: "" }, { PUBLIC_MEDIA_BASE: "" }]) {
      const { app } = await testApp(api.baseUrl, env);
      const res = await app.fetch(new Request("http://localhost/v3/session/abc/decision/"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(upstreamBody);
      const bare = await app.fetch(new Request("http://localhost/m/anything"));
      expect(bare.status).toBe(404);
      expect((await errorBody(bare)).code).toBe("NOT_FOUND");
    }
    expect(api.calls.length).toBeGreaterThan(0);
  });

  test("an idempotent replay returns the rewritten body", async () => {
    const media = startFakeUpstream(() => new Response("unused"));
    const api = startFakeUpstream(() =>
      Response.json({ face: mediaUrl(media) }, { status: 201 }),
    );
    const { app } = await testApp(api.baseUrl);
    const keyed = () =>
      new Request("http://localhost/v3/session/", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "media-order-1" },
        body: "{}",
      });
    const first = await app.fetch(keyed());
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const firstBody = await first.text();
    expect(firstBody).toContain(`${PUBLIC_MEDIA_BASE}/m/`);
    expect(firstBody).not.toContain(media.baseUrl);

    const second = await app.fetch(keyed());
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await second.text()).toBe(firstBody);
    expect(api.calls).toHaveLength(1);
  });
});

describe("serving", () => {
  test("a valid token serves the upstream bytes with the upstream content-type", async () => {
    const media = startFakeUpstream(
      () => new Response("fake-jpeg-bytes", { headers: { "content-type": "image/jpeg" } }),
    );
    const api = startFakeUpstream(() => Response.json({ face: mediaUrl(media) }));
    const { app } = await testApp(api.baseUrl);
    const decision = await app.fetch(new Request("http://localhost/v3/session/abc/decision/"));
    const { face } = (await decision.json()) as { face: string };
    const res = await app.fetch(
      new Request(`http://localhost/m/${tokenFromRelayUrl(face)}`),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("fake-jpeg-bytes");
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toMatch(/^private, max-age=\d+$/);
    expect(res.headers.get("cache-control")).not.toContain("public");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const maxAge = Number(res.headers.get("cache-control")?.split("=")[1]);
    expect(maxAge).toBeGreaterThan(1700);
    expect(maxAge).toBeLessThanOrEqual(1800);
    expect(media.calls).toHaveLength(1);
    expect(media.calls[0]?.headers["x-api-key"]).toBeUndefined();
  });

  test("a tampered token answers 404 and never fetches", async () => {
    const media = startFakeUpstream(() => new Response("must not be fetched"));
    const api = startFakeUpstream(() => Response.json({ face: mediaUrl(media) }));
    const { app } = await testApp(api.baseUrl);
    const decision = await app.fetch(new Request("http://localhost/v3/session/abc/decision/"));
    const { face } = (await decision.json()) as { face: string };
    const token = tokenFromRelayUrl(face);
    const dot = token.indexOf(".");
    const payload = token.slice(0, dot);
    const flipped = `${payload[0] === "A" ? "B" : "A"}${payload.slice(1)}${token.slice(dot)}`;
    expect(flipped).not.toBe(token);
    const res = await app.fetch(new Request(`http://localhost/m/${flipped}`));
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("NOT_FOUND");
    expect(media.calls).toHaveLength(0);
  });

  test("a token signed with a different key answers 404", async () => {
    const media = startFakeUpstream(() => new Response("must not be fetched"));
    const api = startFakeUpstream(() => Response.json({ face: mediaUrl(media) }));
    const { app: appA } = await testApp(api.baseUrl);
    const { app: appB } = await testApp(api.baseUrl, { DIDIT_API_KEY: OTHER_KEY });
    const decision = await appA.fetch(
      new Request("http://localhost/v3/session/abc/decision/"),
    );
    const { face } = (await decision.json()) as { face: string };
    const res = await appB.fetch(
      new Request(`http://localhost/m/${tokenFromRelayUrl(face)}`),
    );
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("NOT_FOUND");
    expect(media.calls).toHaveLength(0);
  });

  test("an expired token answers 410 MEDIA_EXPIRED without fetching", async () => {
    const media = startFakeUpstream(
      () => new Response("fresh-bytes", { headers: { "content-type": "image/png" } }),
    );
    const api = startFakeUpstream(() => Response.json({ ok: true }));
    const { app } = await testApp(api.baseUrl, { MEDIA_SIGNING_SECRET: MEDIA_SECRET });
    const url = mediaUrl(media);
    const expired = mintToken(url, Date.now() - 1000, MEDIA_SECRET);
    const res = await app.fetch(new Request(`http://localhost/m/${expired}`));
    expect(res.status).toBe(410);
    const err = await errorBody(res);
    expect(err.code).toBe("MEDIA_EXPIRED");
    expect(err.retryable).toBe(false);
    expect(media.calls).toHaveLength(0);

    // The same oracle with a live expiry verifies, proving the formats match.
    const fresh = mintToken(url, Date.now() + 60000, MEDIA_SECRET);
    const served = await app.fetch(new Request(`http://localhost/m/${fresh}`));
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("fresh-bytes");
    expect(media.calls).toHaveLength(1);
  });

  test("upstream 403 answers 410 and the cache entry is not kept", async () => {
    const media = startFakeUpstream(() => new Response("expired presign", { status: 403 }));
    const api = startFakeUpstream(() => Response.json({ face: mediaUrl(media) }));
    const { app, cacheDir } = await testApp(api.baseUrl);
    const decision = await app.fetch(new Request("http://localhost/v3/session/abc/decision/"));
    const { face } = (await decision.json()) as { face: string };
    const token = tokenFromRelayUrl(face);
    const first = await app.fetch(new Request(`http://localhost/m/${token}`));
    expect(first.status).toBe(410);
    expect((await errorBody(first)).code).toBe("MEDIA_EXPIRED");
    expect(await cacheDirEntries(cacheDir)).toEqual([]);
    const second = await app.fetch(new Request(`http://localhost/m/${token}`));
    expect(second.status).toBe(410);
    expect(media.calls).toHaveLength(2);
  });
});

describe("cache", () => {
  test("a second request hits the cache with zero further upstream calls", async () => {
    const media = startFakeUpstream(
      () => new Response("cached-bytes", { headers: { "content-type": "image/png" } }),
    );
    const api = startFakeUpstream(() => Response.json({ face: mediaUrl(media) }));
    const { app, lines, cacheDir } = await testApp(api.baseUrl);
    const decision = await app.fetch(new Request("http://localhost/v3/session/abc/decision/"));
    const { face } = (await decision.json()) as { face: string };
    const token = tokenFromRelayUrl(face);
    const first = await app.fetch(new Request(`http://localhost/m/${token}`));
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("cached-bytes");
    // Body bytes plus the content-type sidecar.
    expect((await cacheV1Entries(cacheDir)).sort()).toHaveLength(2);

    const second = await app.fetch(new Request(`http://localhost/m/${token}`));
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("cached-bytes");
    expect(second.headers.get("content-type")).toBe("image/png");
    expect(media.calls).toHaveLength(1);

    const serves = logRecords(lines).filter((record) => record["msg"] === "media");
    expect(serves).toHaveLength(2);
    expect(serves[0]?.["cache"]).toBe("miss");
    expect(serves[0]?.["upstreamStatus"]).toBe(200);
    expect(serves[0]?.["bytes"]).toBe("cached-bytes".length);
    expect(serves[1]?.["cache"]).toBe("hit");
    expect(serves[1]?.["upstreamStatus"]).toBeNull();
    expect(serves[1]?.["bytes"]).toBe("cached-bytes".length);
    expect(typeof serves[1]?.["durationMs"]).toBe("number");
  });

  test("oldest entries are evicted first when the cache is full", async () => {
    const media = startFakeUpstream(
      () => new Response("x".repeat(100), { headers: { "content-type": "image/jpeg" } }),
    );
    const api = startFakeUpstream(() => Response.json({ ok: true }));
    // One ~155-byte entry fits under the cap; the second forces the first out.
    const { app, cacheDir } = await testApp(api.baseUrl, {
      MEDIA_SIGNING_SECRET: MEDIA_SECRET,
      MEDIA_CACHE_MAX_BYTES: "200",
    });
    const link = (path: string) =>
      mintToken(`${media.baseUrl}${path}`, Date.now() + 60000, MEDIA_SECRET);
    const first = await app.fetch(new Request(`http://localhost/m/${link("/one.jpg")}`));
    expect(first.status).toBe(200);
    const second = await app.fetch(new Request(`http://localhost/m/${link("/two.jpg")}`));
    expect(second.status).toBe(200);
    // Exactly one entry (body plus sidecar) survives.
    expect((await cacheV1Entries(cacheDir)).sort()).toHaveLength(2);
    // The evicted URL fetches upstream again; the survivor does not.
    await app.fetch(new Request(`http://localhost/m/${link("/one.jpg")}`));
    await app.fetch(new Request(`http://localhost/m/${link("/two.jpg")}`));
    const paths = media.calls.map((call) => call.path);
    expect(paths.filter((path) => path === "/one.jpg")).toHaveLength(2);
    expect(paths.filter((path) => path === "/two.jpg")).toHaveLength(2);
  });

  test("an entry that cannot fit is refused but still served", async () => {
    const media = startFakeUpstream(
      () => new Response("x".repeat(100), { headers: { "content-type": "image/jpeg" } }),
    );
    const api = startFakeUpstream(() => Response.json({ ok: true }));
    const { app, cacheDir } = await testApp(api.baseUrl, {
      MEDIA_SIGNING_SECRET: MEDIA_SECRET,
      MEDIA_CACHE_MAX_BYTES: "10",
    });
    const token = mintToken(mediaUrl(media), Date.now() + 60000, MEDIA_SECRET);
    const res = await app.fetch(new Request(`http://localhost/m/${token}`));
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBe(100);
    expect(await cacheV1Entries(cacheDir)).toEqual([]);
  });

  test("MEDIA_CACHE_ENABLED=false serves twice upstream and writes no files", async () => {
    const media = startFakeUpstream(
      () => new Response("live-bytes", { headers: { "content-type": "image/jpeg" } }),
    );
    const api = startFakeUpstream(() => Response.json({ face: mediaUrl(media) }));
    const { app, lines, cacheDir } = await testApp(api.baseUrl, {
      MEDIA_CACHE_ENABLED: "false",
    });
    const decision = await app.fetch(new Request("http://localhost/v3/session/abc/decision/"));
    const { face } = (await decision.json()) as { face: string };
    const token = tokenFromRelayUrl(face);
    for (let round = 0; round < 2; round += 1) {
      const res = await app.fetch(new Request(`http://localhost/m/${token}`));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("live-bytes");
    }
    expect(media.calls).toHaveLength(2);
    expect(await cacheDirEntries(cacheDir)).toEqual([]);
    const serves = logRecords(lines).filter((record) => record["msg"] === "media");
    expect(serves).toHaveLength(2);
    expect(serves[0]?.["cache"]).toBe("miss");
    expect(serves[1]?.["cache"]).toBe("miss");
  });
});

describe("serving edges", () => {
  test("upstream 410 answers 410 MEDIA_EXPIRED like a 403", async () => {
    const media = startFakeUpstream(() => new Response("gone", { status: 410 }));
    const api = startFakeUpstream(() => Response.json({ ok: true }));
    const { app } = await testApp(api.baseUrl, { MEDIA_SIGNING_SECRET: MEDIA_SECRET });
    const token = mintToken(mediaUrl(media), Date.now() + 60000, MEDIA_SECRET);
    const res = await app.fetch(new Request(`http://localhost/m/${token}`));
    expect(res.status).toBe(410);
    const err = await errorBody(res);
    expect(err.code).toBe("MEDIA_EXPIRED");
    expect(err.retryable).toBe(false);
  });

  test("an upstream redirect is an upstream failure, never followed", async () => {
    const media = startFakeUpstream(
      () => new Response(null, { status: 302, headers: { location: "https://other.example/x" } }),
    );
    const api = startFakeUpstream(() => Response.json({ ok: true }));
    const { app } = await testApp(api.baseUrl, { MEDIA_SIGNING_SECRET: MEDIA_SECRET });
    const token = mintToken(mediaUrl(media), Date.now() + 60000, MEDIA_SECRET);
    for (let round = 0; round < 2; round += 1) {
      const res = await app.fetch(new Request(`http://localhost/m/${token}`));
      expect(res.status).toBe(502);
      expect((await res.json()) as unknown).toHaveProperty("error.code", "UPSTREAM_ERROR");
      expect(res.headers.get("location")).toBeNull();
    }
    expect(media.calls).toHaveLength(2);
  });

  test("bare, nested and non-GET /m/ paths answer 404 without fetching", async () => {
    const media = startFakeUpstream(() => new Response("must not be fetched"));
    const api = startFakeUpstream(() => Response.json({ ok: true }));
    const { app } = await testApp(api.baseUrl, { MEDIA_SIGNING_SECRET: MEDIA_SECRET });
    const token = mintToken(mediaUrl(media), Date.now() + 60000, MEDIA_SECRET);
    for (const req of [
      new Request("http://localhost/m"),
      new Request("http://localhost/m/"),
      new Request(`http://localhost/m/${token}/extra`),
      new Request(`http://localhost/m/${token}`, { method: "POST" }),
    ]) {
      const res = await app.fetch(req);
      expect(res.status).toBe(404);
      expect((await errorBody(res)).code).toBe("NOT_FOUND");
    }
    expect(media.calls).toHaveLength(0);
  });
});

describe("hygiene", () => {
  test("the link token, upstream URL and secrets never appear in any log line", async () => {
    const media = startFakeUpstream(
      () => new Response("secret-bytes", { headers: { "content-type": "image/jpeg" } }),
    );
    const face = mediaUrl(media);
    const api = startFakeUpstream(() => Response.json({ face }));
    const lines: string[] = [];
    const { app } = await testApp(
      api.baseUrl,
      { MEDIA_SIGNING_SECRET: MEDIA_SECRET },
      lines,
    );
    const decision = await app.fetch(new Request("http://localhost/v3/session/abc/decision/"));
    const token = tokenFromRelayUrl(((await decision.json()) as { face: string }).face);
    // Valid serve, tampered token, expired token, bare token path.
    await app.fetch(new Request(`http://localhost/m/${token}`));
    await app.fetch(new Request(`http://localhost/m/${token.slice(0, -1)}x`));
    await app.fetch(
      new Request(`http://localhost/m/${mintToken(face, Date.now() - 1000, MEDIA_SECRET)}`),
    );
    await app.fetch(new Request("http://localhost/m/"));
    expect(lines.length).toBeGreaterThan(0);
    const raw = lines.join("\n");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(face);
    expect(raw).not.toContain("sig=abc123");
    expect(raw).not.toContain(MEDIA_SECRET);
    expect(raw).not.toContain(FAKE_KEY);
    // Every media path on the wire is the redacted marker instead.
    for (const record of logRecords(lines)) {
      if (record["msg"] === "media" || record["msg"] === "request") {
        expect(String(record["path"] ?? "")).not.toContain(token);
      }
    }
    const mediaPaths = logRecords(lines)
      .filter((record) => record["msg"] === "media")
      .map((record) => record["path"]);
    expect(mediaPaths.length).toBeGreaterThan(0);
    for (const path of mediaPaths) {
      expect(path).toBe(MEDIA_LOG_PATH);
    }
    const accessPaths = logRecords(lines)
      .filter((record) => record["msg"] === "request")
      .map((record) => record["path"]);
    expect(accessPaths).toContain(MEDIA_LOG_PATH);
  });
});
