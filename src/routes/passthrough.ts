/**
 * Phase 1 Didit proxy: every call the bank's authorization module makes
 * passes through here, because the bank allowlists exactly one host.
 *
 * Why this shape: the relay injects the API key (the caller never holds
 * it), enforces one time budget for the whole exchange, and guarantees a
 * failure here never blocks a debit — every outcome either carries
 * Didit's own answer or maps into the envelope with `fallbackToOtp` set
 * where the caller can still complete via OTP.
 *
 * Pipeline order is fixed: path safety, body size, idempotency (POST),
 * forward, retry (reads only), map-or-stream. Each step short-circuits;
 * later steps never run after an early failure.
 *
 * Non-goals live elsewhere: media re-serving (Phase 2), evidence storage
 * (Phase 3), webhooks. This file only proxies bytes and headers.
 */
import type { Config } from "../config";
import { AppError, type ErrorCode, type ErrorFlagOverrides } from "../http/errors";
import type { Logger } from "../logging/logger";
import {
  IDEMPOTENCY_KEY_PATTERN,
  type IdempotencyStore,
  type RecordedResponse,
} from "../proxy/idempotency";

export interface ProxyContext {
  config: Config;
  logger: Logger;
  /** Relay request id (the validated inbound one, or generated). */
  requestId: string;
  store: IdempotencyStore;
  /** Inbound socket address when the server provided one, else null. */
  remoteAddr: string | null;
}

export interface ProxyOutcome {
  response: Response;
  /** Last upstream status seen, or null when upstream never answered. */
  upstreamStatus: number | null;
  /** Wall time spent on the upstream exchange (all attempts). */
  upstreamMs: number;
  /** Upstream fetch attempts: 0 when upstream was never called. */
  attempts: number;
  replayed: boolean;
}

/** Appended to an inbound user-agent, or sent alone when absent. */
const RELAY_USER_AGENT = "didit-relay/1.0";

/** Upstream statuses worth one retry on reads. Never 429, never 5xx-wide. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** Response headers allowed back to the caller. Everything else is dropped. */
const RESPONSE_HEADER_ALLOWLIST: readonly string[] = [
  "content-type",
  "content-length",
  "retry-after",
  "location",
];

export async function handleProxy(req: Request, ctx: ProxyContext): Promise<ProxyOutcome> {
  // 1. Path safety. The origin and final-path checks inside the builder
  // are the only things standing between the caller and an arbitrary
  // host, so an unsafe path ends here with a 404 and no upstream call.
  const target = buildUpstreamUrl(req.url, ctx.config.diditApiBase);
  if (!target.ok) {
    return early(new AppError("NOT_FOUND", "not found").toResponse());
  }

  // 2. Body size. Over the cap the upstream is not called.
  const inboundBody = await readBodyCapped(req, ctx.config.upstreamMaxBodyBytes);
  if (!inboundBody.ok) {
    const err =
      inboundBody.reason === "too-large"
        ? new AppError("PAYLOAD_TOO_LARGE", "request body too large")
        : new AppError("BAD_REQUEST", "request body could not be read");
    return early(err.toResponse());
  }

  // 3. Idempotency, POST only. A valid key either replays a recorded
  // success, waits for the in-flight first execution, or claims this
  // execution as the first. Without the header everything goes upstream.
  const idempotencyKey = req.method === "POST" ? validIdempotencyKey(req) : null;
  let slot: Slot | null = null;
  if (idempotencyKey !== null) {
    for (;;) {
      const hit = ctx.store.lookup(target.rawPath, idempotencyKey);
      if (hit !== null) {
        return {
          response: replayResponse(hit),
          upstreamStatus: hit.status,
          upstreamMs: 0,
          attempts: 0,
          replayed: true,
        };
      }
      const claim = ctx.store.claim(target.rawPath, idempotencyKey);
      if (claim.claimed) {
        slot = { path: target.rawPath, key: idempotencyKey, token: claim.token };
        break;
      }
      await claim.wait;
    }
  }

  // 4-6. Forward (with the timeout budget), retry reads once, map or
  // stream the outcome. The slot is always settled: recorded on a 2xx,
  // released on anything else, so a waiter never hangs and a failure is
  // never cached.
  try {
    const forwarded = await forwardWithRetry(
      req.method,
      target.url,
      req.headers,
      inboundBody.body,
      ctx,
    );
    if (forwarded.kind === "timeout") {
      releaseSlot(ctx, slot);
      ctx.logger.error("upstream timed out", {
        requestId: ctx.requestId,
        code: "UPSTREAM_TIMEOUT",
        abortedByRelay: forwarded.abortedByRelay,
      });
      return {
        response: new AppError("UPSTREAM_TIMEOUT", "upstream timed out").toResponse(),
        upstreamStatus: null,
        upstreamMs: forwarded.upstreamMs,
        attempts: forwarded.attempts,
        replayed: false,
      };
    }
    if (forwarded.kind === "transport") {
      releaseSlot(ctx, slot);
      ctx.logger.error("upstream request failed", {
        requestId: ctx.requestId,
        code: "UPSTREAM_ERROR",
      });
      return {
        response: new AppError("UPSTREAM_ERROR", "upstream request failed").toResponse(),
        upstreamStatus: null,
        upstreamMs: forwarded.upstreamMs,
        attempts: forwarded.attempts,
        replayed: false,
      };
    }
    return await mapUpstreamResponse(forwarded.upstream, {
      ctx,
      slot,
      attempts: forwarded.attempts,
      upstreamMs: forwarded.upstreamMs,
    });
  } catch {
    // Unreachable in practice (every expected failure is mapped above);
    // releasing keeps an idempotent waiter from hanging on a bug.
    releaseSlot(ctx, slot);
    throw new AppError("INTERNAL", "internal server error");
  }
}

function early(response: Response): ProxyOutcome {
  return { response, upstreamStatus: null, upstreamMs: 0, attempts: 0, replayed: false };
}

interface Slot {
  path: string;
  key: string;
  token: symbol;
}

function releaseSlot(ctx: ProxyContext, slot: Slot | null): void {
  if (slot !== null) {
    ctx.store.release(slot.path, slot.key, slot.token);
  }
}

// --- path safety -----------------------------------------------------------

interface UpstreamTarget {
  /** Fully verified absolute URL to fetch. */
  url: string;
  /** Exact inbound path (trailing slash significant), for idempotency scope. */
  rawPath: string;
}

type TargetResult = { ok: true } & UpstreamTarget | { ok: false };

/**
 * Resolve the inbound path against `diditApiBase` without ever letting the
 * caller choose the host.
 *
 * The platform already normalizes some tricks away (uppercase `%2E` dot
 * segments, backslashes), but lowercase `%2e`, `//evil.example/` and
 * `%5c` all survive to `req.url` byte-for-byte (probed against
 * `Bun.serve`), so this function checks the raw target itself:
 *
 * - the raw path is sliced out of the serialized URL, never taken from
 *   the normalized `.pathname`;
 * - the decoded path must start with a single `/v3` (this rejects
 *   `//evil.example/...` before resolution could treat it as a host);
 * - the decoded path is dot-normalized and must still be `/v3` or under
 *   `/v3/` (this rejects `/v3/%2e%2e%2f...` escapes);
 * - the resolved URL's origin must equal the base origin, and the exact
 *   bytes about to be fetched are decoded and checked once more, so any
 *   normalization the URL parser applied on top is verified, not trusted.
 *
 * The query string is forwarded byte-for-byte and the trailing slash is
 * preserved: `/v3/session/` and `/v3/session` stay different paths.
 */
function buildUpstreamUrl(reqUrl: string, base: string): TargetResult {
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return { ok: false };
  }

  const schemeEnd = reqUrl.indexOf("://");
  if (schemeEnd < 0) {
    return { ok: false };
  }
  const pathStart = reqUrl.indexOf("/", schemeEnd + 3);
  let rawPathAndQuery = pathStart < 0 ? "/" : reqUrl.slice(pathStart);
  const hashIndex = rawPathAndQuery.indexOf("#");
  if (hashIndex >= 0) {
    rawPathAndQuery = rawPathAndQuery.slice(0, hashIndex);
  }
  let rawPath = rawPathAndQuery;
  let rawQuery = "";
  const queryIndex = rawPathAndQuery.indexOf("?");
  if (queryIndex >= 0) {
    rawPath = rawPathAndQuery.slice(0, queryIndex);
    rawQuery = rawPathAndQuery.slice(queryIndex);
  }
  if (!rawPath.startsWith("/")) {
    return { ok: false };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { ok: false };
  }
  if (decoded.includes("\\") || /[\u0000-\u001f\u007f]/.test(decoded)) {
    return { ok: false };
  }
  if (!isV3Path(decoded)) {
    return { ok: false };
  }
  const normalized = normalizeDecodedPath(decoded);
  if (normalized === null || !isV3Path(normalized)) {
    return { ok: false };
  }

  // The base path prefix is trusted (it comes from validated config), but
  // it still goes through the same parser and the same final check.
  let basePrefix = baseUrl.pathname;
  if (basePrefix === "/") {
    basePrefix = "";
  } else if (basePrefix.endsWith("/")) {
    basePrefix = basePrefix.slice(0, -1);
  }
  let candidate: URL;
  try {
    candidate = new URL(`${basePrefix}${rawPath}${rawQuery}`, baseUrl);
    candidate.hash = "";
  } catch {
    return { ok: false };
  }
  if (candidate.origin !== baseUrl.origin) {
    return { ok: false };
  }
  let finalDecoded: string;
  try {
    finalDecoded = decodeURIComponent(candidate.pathname);
  } catch {
    return { ok: false };
  }
  const remainder =
    basePrefix === ""
      ? finalDecoded
      : finalDecoded === basePrefix
        ? ""
        : finalDecoded.startsWith(`${basePrefix}/`)
          ? finalDecoded.slice(basePrefix.length)
          : null;
  if (remainder === null || remainder === "") {
    return { ok: false };
  }
  const finalNormalized = normalizeDecodedPath(remainder);
  if (finalNormalized === null || !isV3Path(finalNormalized)) {
    return { ok: false };
  }
  return { ok: true, url: candidate.href, rawPath };
}

function isV3Path(decodedPath: string): boolean {
  return decodedPath === "/v3" || decodedPath.startsWith("/v3/");
}

/**
 * Lexically resolve `.` and `..` segments the way the upstream framework
 * will after it decodes the same bytes. Returns null when `..` escapes
 * past the root.
 */
function normalizeDecodedPath(decodedPath: string): string | null {
  const stack: string[] = [];
  for (const segment of decodedPath.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (stack.length === 0) {
        return null;
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return `/${stack.join("/")}`;
}

// --- body size ---------------------------------------------------------------

type BodyResult =
  | { ok: true; body: Uint8Array<ArrayBuffer> | null }
  | { ok: false; reason: "too-large" | "unreadable" };

/**
 * Read the inbound body bounded by `cap` bytes. Past the cap the reader
 * is cancelled and the upstream is never called. `GET` and `HEAD` never
 * carry a body upstream (`fetch` rejects them); `DELETE` keeps its body
 * only when non-empty.
 */
async function readBodyCapped(req: Request, cap: number): Promise<BodyResult> {
  if (req.body === null) {
    return { ok: true, body: null };
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    for (;;) {
      let read: Awaited<ReturnType<typeof reader.read>>;
      try {
        read = await reader.read();
      } catch {
        return { ok: false, reason: "unreadable" };
      }
      if (read.done) {
        break;
      }
      total += read.value.byteLength;
      if (total > cap) {
        try {
          await reader.cancel();
        } catch {
          // Already closing; the 413 below is the outcome either way.
        }
        return { ok: false, reason: "too-large" };
      }
      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0 || req.method === "GET" || req.method === "HEAD") {
    return { ok: true, body: null };
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}

// --- idempotency helpers -----------------------------------------------------

function validIdempotencyKey(req: Request): string | null {
  const key = req.headers.get("idempotency-key");
  if (key === null || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return null;
  }
  return key;
}

function replayResponse(recorded: RecordedResponse): Response {
  const headers = new Headers();
  if (recorded.contentType !== null) {
    safeSet(headers, "content-type", recorded.contentType);
  }
  headers.set("idempotent-replayed", "true");
  // A copy per replay: the recorded bytes must survive every consumer.
  return new Response(recorded.body.slice(), {
    status: recorded.status,
    headers,
  });
}

// --- forward with timeout budget and read-only retry --------------------------

type ForwardResult =
  | { kind: "responded"; upstream: Response; attempts: number; upstreamMs: number }
  | { kind: "timeout"; abortedByRelay: boolean; attempts: number; upstreamMs: number }
  | { kind: "transport"; attempts: number; upstreamMs: number };

/**
 * Run the upstream exchange under one deadline (`UPSTREAM_TIMEOUT_MS`)
 * covering time-to-response-headers. `GET`/`HEAD` are retried at most
 * once on transport errors and 502/503/504, and only when at least half
 * the budget remains; `POST`/`PATCH`/`DELETE` are never retried, and
 * neither is a 429.
 */
async function forwardWithRetry(
  method: string,
  url: string,
  inboundHeaders: Headers,
  body: Uint8Array<ArrayBuffer> | null,
  ctx: ProxyContext,
): Promise<ForwardResult> {
  const budget = ctx.config.upstreamTimeoutMs;
  const deadline = Date.now() + budget;
  const retryableMethod = method === "GET" || method === "HEAD";
  const headers = buildUpstreamHeaders(inboundHeaders, ctx);
  const startedAt = Date.now();
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const remaining = deadline - Date.now();
    const controller = new AbortController();
    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
      controller.abort();
    }, Math.max(remaining, 0));
    try {
      const upstream = await fetch(url, {
        method,
        headers,
        body: body ?? undefined,
        redirect: "manual",
        signal: controller.signal,
      });
      if (retryableMethod && attempts < 2 && RETRYABLE_STATUSES.has(upstream.status)) {
        if (deadline - Date.now() >= budget / 2) {
          ctx.logger.warn("upstream retry", {
            requestId: ctx.requestId,
            attempt: attempts + 1,
            reason: `upstream-${upstream.status}`,
            upstreamStatus: upstream.status,
          });
          await cancelBody(upstream);
          continue;
        }
      }
      return { kind: "responded", upstream, attempts, upstreamMs: Date.now() - startedAt };
    } catch {
      if (controller.signal.aborted) {
        return {
          kind: "timeout",
          abortedByRelay: timerFired,
          attempts,
          upstreamMs: Date.now() - startedAt,
        };
      }
      if (retryableMethod && attempts < 2 && deadline - Date.now() >= budget / 2) {
        ctx.logger.warn("upstream retry", {
          requestId: ctx.requestId,
          attempt: attempts + 1,
          reason: "transport-error",
        });
        continue;
      }
      return { kind: "transport", attempts, upstreamMs: Date.now() - startedAt };
    } finally {
      // A successful request must not leave a pending abort behind.
      clearTimeout(timer);
    }
  }
}

/**
 * Allowlisted inbound headers plus injected credentials and correlation.
 * Everything else — caller keys, cookies, content-length, forwarding
 * headers, hop-by-hop headers — is dropped by construction.
 */
function buildUpstreamHeaders(inbound: Headers, ctx: ProxyContext): Headers {
  const out = new Headers();
  for (const name of ["content-type", "accept", "accept-language"] as const) {
    const value = inbound.get(name);
    if (value !== null) {
      out.set(name, value);
    }
  }
  const inboundAgent = inbound.get("user-agent");
  out.set("user-agent", inboundAgent === null ? RELAY_USER_AGENT : `${inboundAgent} ${RELAY_USER_AGENT}`);
  out.set("x-api-key", ctx.config.diditApiKey);
  out.set("x-request-id", ctx.requestId);
  out.set("accept-encoding", "identity");
  // Never echo a caller-supplied x-forwarded-for; only the socket address
  // the server observed, and nothing when it did not provide one.
  if (ctx.remoteAddr !== null) {
    out.set("x-forwarded-for", ctx.remoteAddr);
  }
  return out;
}

// --- error mapping and response policy ------------------------------------------

interface MapInput {
  ctx: ProxyContext;
  slot: Slot | null;
  attempts: number;
  upstreamMs: number;
}

/**
 * Map the upstream outcome or stream it back. JSON `4xx` (other than 401
 * and 429) passes through verbatim — status, body, content-type — because
 * those are validation answers about the caller's own request. Everything
 * else becomes the envelope, and streamed bodies are never buffered.
 */
async function mapUpstreamResponse(upstream: Response, input: MapInput): Promise<ProxyOutcome> {
  const { ctx, attempts, upstreamMs } = input;
  const status = upstream.status;

  if (status >= 500) {
    return failUpstream(upstream, input, "UPSTREAM_ERROR", "upstream answered with an error");
  }
  if (status === 429) {
    const retryAfter = upstream.headers.get("retry-after");
    await cancelBody(upstream);
    releaseSlot(ctx, input.slot);
    ctx.logger.warn("upstream rate limited", {
      requestId: ctx.requestId,
      code: "UPSTREAM_RATE_LIMITED",
      upstreamStatus: status,
    });
    const response = new AppError(
      "UPSTREAM_RATE_LIMITED",
      "upstream rate limited the request",
    ).toResponse();
    if (retryAfter !== null) {
      safeSet(response.headers, "retry-after", retryAfter);
    }
    return { response, upstreamStatus: status, upstreamMs, attempts, replayed: false };
  }
  if (status === 401) {
    // Our key is wrong, not the caller's request: same code and status
    // as a caller authentication failure, but the caller may still
    // complete via OTP. The log carries no key material.
    return failUpstream(upstream, input, "UNAUTHORIZED", "upstream rejected the relay credentials", {
      flags: { fallbackToOtp: true },
    });
  }
  if (status >= 400) {
    const contentType = upstream.headers.get("content-type");
    if (!isJsonContentType(contentType)) {
      // Django answers unknown /v3/ paths with an HTML page; a bank JSON
      // client must never receive that as if it were an answer.
      return failUpstream(upstream, input, "UPSTREAM_ERROR", "upstream answered with an error", {
        logExtra: { upstreamContentType: contentType ?? "(missing)" },
      });
    }
    releaseSlot(ctx, input.slot);
    return {
      response: streamResponse(upstream),
      upstreamStatus: status,
      upstreamMs,
      attempts,
      replayed: false,
    };
  }

  if (input.slot !== null && status >= 200 && status < 300) {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(await upstream.arrayBuffer());
    } catch {
      return failUpstream(upstream, input, "UPSTREAM_ERROR", "upstream request failed");
    }
    // Recording is the one path that buffers: the bytes are both the
    // response and the replay source, so the record keeps a copy.
    ctx.store.complete(input.slot.path, input.slot.key, input.slot.token, {
      status,
      contentType: upstream.headers.get("content-type"),
      body: bytes.slice(),
    });
    return {
      response: new Response(bytes, { status, headers: filteredHeaders(upstream.headers) }),
      upstreamStatus: status,
      upstreamMs,
      attempts,
      replayed: false,
    };
  }
  releaseSlot(ctx, input.slot);
  return {
    response: streamResponse(upstream),
    upstreamStatus: status,
    upstreamMs,
    attempts,
    replayed: false,
  };
}

interface FailOptions {
  logExtra?: Record<string, unknown>;
  flags?: ErrorFlagOverrides;
}

async function failUpstream(
  upstream: Response,
  input: MapInput,
  code: ErrorCode,
  message: string,
  options?: FailOptions,
): Promise<ProxyOutcome> {
  await cancelBody(upstream);
  releaseSlot(input.ctx, input.slot);
  input.ctx.logger.error("upstream request failed", {
    requestId: input.ctx.requestId,
    code,
    upstreamStatus: upstream.status,
    ...options?.logExtra,
  });
  return {
    response: new AppError(code, message, options?.flags).toResponse(),
    upstreamStatus: upstream.status,
    upstreamMs: input.upstreamMs,
    attempts: input.attempts,
    replayed: false,
  };
}

/** Stream the upstream body back with only the allowlisted headers. */
function streamResponse(upstream: Response): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    headers: filteredHeaders(upstream.headers),
  });
}

function filteredHeaders(upstream: Headers): Headers {
  const out = new Headers();
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = upstream.get(name);
    if (value !== null) {
      safeSet(out, name, value);
    }
  }
  return out;
}

/** Copy one upstream header value, dropping it when it cannot be set. */
function safeSet(headers: Headers, name: string, value: string): void {
  try {
    headers.set(name, value);
  } catch {
    // An unparsable upstream value must not fail the caller's request.
  }
}

function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

/** Best-effort release of an upstream body we are mapping, not forwarding. */
async function cancelBody(upstream: Response): Promise<void> {
  try {
    await upstream.body?.cancel();
  } catch {
    // The connection is already going away; nothing left to free.
  }
}
