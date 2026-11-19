/**
 * `GET /m/{token}`: re-serve presigned biometric media from the relay.
 *
 * The bank whitelists origins it already has a relationship with, not a
 * third-party S3 bucket it has never heard of, so rewritten API responses
 * point here and this handler serves the bytes: it verifies the token
 * (signature before parsing, constant-time), serves from the disk cache on
 * a hit, and otherwise fetches the upstream URL once and caches only a
 * successful `2xx`.
 *
 * Authority and secrecy rules:
 * - every request must pass signature and expiry; anything else is 404,
 *   an expired link is 410 MEDIA_EXPIRED (fetch a fresh decision, do not
 *   retry the link);
 * - the token is the only authority: no raw-URL parameter, no
 *   caller-supplied host, and upstream redirects are never followed
 *   (`redirect: "manual"`; a 3xx is an upstream failure);
 * - only `content-type` and `content-length` pass through from upstream,
 *   with `cache-control: private` (never `public`: biometric data) and
 *   `x-content-type-options: nosniff`;
 * - logs carry neither the token, the upstream URL, the media host, nor
 *   any key material: the access log and the per-serve line both use
 *   `MEDIA_LOG_PATH` in place of the real path.
 */
import type { Config } from "../config";
import { AppError } from "../http/errors";
import type { Logger } from "../logging/logger";
import type { MediaCache } from "../media/cache";
import { verifyMediaToken } from "../media/links";

/** Logged in place of any `/m/...` path, since the path carries the token. */
export const MEDIA_LOG_PATH = "/m/[REDACTED]";

/** Appended to an inbound user-agent, or sent alone when absent. */
export const RELAY_USER_AGENT = "didit-relay/1.0";

export interface MediaContext {
  config: Config;
  logger: Logger;
  /** Relay request id (the validated inbound one, or generated). */
  requestId: string;
  signingKey: Uint8Array;
  cache: MediaCache;
}

export async function handleMedia(token: string, ctx: MediaContext): Promise<Response> {
  const startedAt = Date.now();
  const rewritingActive =
    ctx.config.diditMediaHosts.length > 0 && ctx.config.publicMediaBase !== "";
  if (!rewritingActive || token === "" || token.includes("/")) {
    throw new AppError("NOT_FOUND", "not found");
  }
  const verified = verifyMediaToken(
    token,
    ctx.signingKey,
    new Set(ctx.config.diditMediaHosts),
    Date.now(),
  );
  if (!verified.ok) {
    if (verified.reason === "expired") {
      throw new AppError("MEDIA_EXPIRED", "media link expired");
    }
    throw new AppError("NOT_FOUND", "not found");
  }

  const cached = await ctx.cache.read(verified.url);
  if (cached !== null) {
    return serveBytes(cached.body, cached.contentType, verified.expiresAtMs, {
      ctx,
      startedAt,
      cache: "hit",
      upstreamStatus: null,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.config.upstreamWriteTimeoutMs);
  try {
    let upstream: Response;
    try {
      upstream = await fetch(verified.url, {
        method: "GET",
        headers: mediaUpstreamHeaders(),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        ctx.logger.error("media upstream timed out", {
          requestId: ctx.requestId,
          code: "UPSTREAM_TIMEOUT",
        });
        throw new AppError("UPSTREAM_TIMEOUT", "media upstream timed out");
      }
      ctx.logger.error("media upstream request failed", {
        requestId: ctx.requestId,
        code: "UPSTREAM_ERROR",
      });
      throw new AppError("UPSTREAM_ERROR", "media upstream request failed");
    }
    if (upstream.status === 403 || upstream.status === 410) {
      // The presign behind the link is dead. Drop any cached copy so a
      // later fetch cannot resurrect it, and tell the caller to request a
      // fresh decision rather than retry this link.
      await cancelBody(upstream);
      await ctx.cache.drop(verified.url);
      ctx.logger.warn("media presign expired", {
        requestId: ctx.requestId,
        code: "MEDIA_EXPIRED",
        upstreamStatus: upstream.status,
      });
      throw new AppError("MEDIA_EXPIRED", "media link expired");
    }
    if (upstream.status < 200 || upstream.status >= 300) {
      await cancelBody(upstream);
      ctx.logger.warn("media upstream failed", {
        requestId: ctx.requestId,
        code: "UPSTREAM_ERROR",
        upstreamStatus: upstream.status,
      });
      throw new AppError("UPSTREAM_ERROR", "media upstream request failed");
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await upstream.arrayBuffer());
    } catch {
      if (controller.signal.aborted) {
        ctx.logger.error("media upstream timed out", {
          requestId: ctx.requestId,
          code: "UPSTREAM_TIMEOUT",
        });
        throw new AppError("UPSTREAM_TIMEOUT", "media upstream timed out");
      }
      ctx.logger.error("media upstream request failed", {
        requestId: ctx.requestId,
        code: "UPSTREAM_ERROR",
      });
      throw new AppError("UPSTREAM_ERROR", "media upstream request failed");
    }
    const contentType = upstream.headers.get("content-type");
    // Cached only after a successful 2xx; a refused write still serves.
    await ctx.cache.write(verified.url, bytes, contentType);
    return serveBytes(bytes, contentType, verified.expiresAtMs, {
      ctx,
      startedAt,
      cache: "miss",
      upstreamStatus: upstream.status,
    });
  } finally {
    clearTimeout(timer);
  }
}

interface ServeInput {
  ctx: MediaContext;
  startedAt: number;
  cache: "hit" | "miss";
  upstreamStatus: number | null;
}

function serveBytes(
  body: Uint8Array,
  contentType: string | null,
  expiresAtMs: number,
  input: ServeInput,
): Response {
  const headers = new Headers();
  if (contentType !== null) {
    try {
      headers.set("content-type", contentType);
    } catch {
      // An unparsable upstream value must not fail the serve.
    }
  }
  headers.set("content-length", String(body.byteLength));
  const remainingSec = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
  headers.set("cache-control", `private, max-age=${remainingSec}`);
  headers.set("x-content-type-options", "nosniff");
  input.ctx.logger.info("media", {
    requestId: input.ctx.requestId,
    path: MEDIA_LOG_PATH,
    cache: input.cache,
    bytes: body.byteLength,
    upstreamStatus: input.upstreamStatus,
    durationMs: Date.now() - input.startedAt,
  });
  return new Response(body, { status: 200, headers });
}

/**
 * Minimal fetch headers. Notably no `x-api-key` (this is not the Didit
 * API) and no caller-controlled values: the signed URL alone authorizes
 * the fetch.
 */
function mediaUpstreamHeaders(): Headers {
  const headers = new Headers();
  headers.set("user-agent", RELAY_USER_AGENT);
  headers.set("accept-encoding", "identity");
  return headers;
}

/** Best-effort release of an upstream body we are mapping, not serving. */
async function cancelBody(upstream: Response): Promise<void> {
  try {
    await upstream.body?.cancel();
  } catch {
    // The connection is already going away; nothing left to free.
  }
}
