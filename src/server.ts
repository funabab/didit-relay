/**
 * HTTP server: route table over `Bun.serve`, access logging and shutdown.
 *
 * `createApp` is pure construction: it parses the given env, records whether
 * the process is ready, and returns a `fetch` handler. It never exits, so
 * tests can build both ready and not-ready apps in-process.
 *
 * The boot block at the bottom runs only when this file is the entrypoint.
 * It exits non-zero with a single readable line when config is invalid.
 */
import { loadConfig, type Config } from "./config";
import { AppError, toErrorResponse } from "./http/errors";
import { drain } from "./lifecycle";
import { createLogger, registerSecret, type Logger } from "./logging/logger";
import { handleHealthz, handleReadyz } from "./routes/health";
import { handlePassthrough } from "./routes/passthrough";

export interface App {
  readonly fetch: (req: Request) => Promise<Response>;
  readonly logger: Logger;
  readonly isReady: boolean;
  readonly config: Config | null;
  readonly configError: string | null;
  /** Resolves when no request is in flight. Used by shutdown only. */
  readonly waitForIdle: () => Promise<void>;
}

export interface CreateAppOptions {
  logger?: Logger;
}

function pathnameOf(req: Request): string {
  try {
    // Pathname only: the query string is never logged or routed on, since
    // it may carry caller-supplied sensitive data.
    return new URL(req.url).pathname;
  } catch {
    return "(invalid-url)";
  }
}

// Inbound request IDs are caller-controlled, so only this safe shape is
// accepted; anything else is replaced with a generated UUID.
const INBOUND_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export function createApp(
  env: Record<string, string | undefined>,
  options?: CreateAppOptions,
): App {
  const result = loadConfig(env);
  const config = result.ok ? result.config : null;
  const configError = result.ok ? null : result.error;
  const isReady = result.ok;
  const logger = options?.logger ?? createLogger(result.ok ? { level: result.config.logLevel } : {});
  if (result.ok) {
    // Scrub the process's own key on every log line, even when no field of
    // the current call carries it (e.g. quoted inside an upstream error).
    registerSecret(result.config.diditApiKey);
  }

  let inFlight = 0;
  let notifyIdle: (() => void) | null = null;
  const waitForIdle = (): Promise<void> => {
    if (inFlight === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      notifyIdle = resolve;
    });
  };

  const fetch = async (req: Request): Promise<Response> => {
    inFlight += 1;
    const inbound = req.headers.get("x-request-id");
    let requestId: string;
    let requestIdSource: "inbound" | "generated";
    if (inbound !== null && INBOUND_REQUEST_ID.test(inbound)) {
      requestId = inbound;
      requestIdSource = "inbound";
    } else {
      requestId = crypto.randomUUID();
      requestIdSource = "generated";
      if (inbound !== null) {
        // Never log the rejected value: it is attacker-controlled free text.
        logger.debug("rejected inbound x-request-id", { requestId, requestIdSource });
      }
    }
    const startedAt = Date.now();
    const method = req.method;
    const path = pathnameOf(req);
    let status = 500;

    try {
      let res: Response;
      if (method === "GET" && path === "/healthz") {
        res = handleHealthz();
      } else if (method === "GET" && path === "/readyz") {
        res = handleReadyz(isReady, configError);
      } else if (path === "/v3" || path.startsWith("/v3/")) {
        res = handlePassthrough();
      } else {
        throw new AppError("NOT_FOUND", `no route for ${method} ${path}`);
      }
      res.headers.set("x-request-id", requestId);
      status = res.status;
      return res;
    } catch (err) {
      const res = toErrorResponse(err);
      res.headers.set("x-request-id", requestId);
      status = res.status;
      if (status >= 500) {
        logger.error("request failed", { requestId, err });
      }
      return res;
    } finally {
      const durationMs = Date.now() - startedAt;
      logger.info("request", { requestId, requestIdSource, method, path, status, durationMs });
      inFlight -= 1;
      if (inFlight === 0 && notifyIdle !== null) {
        const notify = notifyIdle;
        notifyIdle = null;
        notify();
      }
    }
  };

  return { fetch, logger, isReady, config, configError, waitForIdle };
}

// --- boot -----------------------------------------------------------------

if (import.meta.main) {
  const app = createApp(process.env);
  if (!app.isReady || app.config === null) {
    console.error(`didit-relay: invalid config: ${app.configError ?? "unknown error"}`);
    process.exit(1);
  }
  const config = app.config;
  const logger = app.logger;

  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: config.port,
    fetch: app.fetch,
  });
  logger.info("server started", { port: config.port, nodeEnv: config.nodeEnv });
  if (new URL(config.diditApiBase).protocol === "http:") {
    logger.warn(
      "DIDIT_API_BASE uses plaintext http (development); the API key will be sent unencrypted",
    );
  }

  let stopping = false;
  let forcing = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      // A second signal while draining forces immediate exit.
      if (!forcing) {
        forcing = true;
        logger.warn("shutdown forced", { signal });
      }
      process.exit(1);
      return;
    }
    stopping = true;
    void (async () => {
      logger.info("server stopping", { signal });
      const startedAt = Date.now();
      let outcome: "drained" | "timeout";
      try {
        outcome = await drain({
          timeoutMs: config.shutdownTimeoutMs,
          stop: (force) => server.stop(force),
          waitForIdle: app.waitForIdle,
        });
      } catch {
        try {
          server.stop(true);
        } catch {
          // Shutdown is best-effort; the process exits regardless.
        }
        outcome = "timeout";
      }
      const waitedMs = Date.now() - startedAt;
      logger.info("server stopped", { signal, outcome, waitedMs });
      process.exit(outcome === "drained" ? 0 : 1);
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
