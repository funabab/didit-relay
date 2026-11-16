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
import { createLogger, type Logger } from "./logging/logger";
import { handleHealthz, handleReadyz } from "./routes/health";
import { handlePassthrough } from "./routes/passthrough";

export interface App {
  readonly fetch: (req: Request) => Promise<Response>;
  readonly logger: Logger;
  readonly isReady: boolean;
  readonly config: Config | null;
  readonly configError: string | null;
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

export function createApp(
  env: Record<string, string | undefined>,
  options?: CreateAppOptions,
): App {
  const result = loadConfig(env);
  const config = result.ok ? result.config : null;
  const configError = result.ok ? null : result.error;
  const isReady = result.ok;
  const logger = options?.logger ?? createLogger(result.ok ? { level: result.config.logLevel } : {});

  const fetch = async (req: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
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
      logger.info("request", { requestId, method, path, status, durationMs });
    }
  };

  return { fetch, logger, isReady, config, configError };
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

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info("server stopping", { signal });
    try {
      server.stop(true);
    } catch {
      // Shutdown is best-effort; the process exits regardless.
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
