/**
 * Environment parsing and validation. Runs once at boot; the process refuses
 * to start when the result is invalid.
 *
 * Rules:
 * - `DIDIT_API_KEY` is required and must be non-empty.
 * - Every other key has a default and is validated only when set to a
 *   non-empty value. Empty/unset optionals silently take the default.
 * - Failure messages never include any env value. They state only whether
 *   `DIDIT_API_KEY` is present, so operators can tell "key missing" apart
 *   from "key present but something else invalid".
 */
import type { LogLevel } from "./logging/logger";

export interface Config {
  port: number;
  diditApiKey: string;
  diditApiBase: string;
  upstreamTimeoutMs: number;
  mediaCacheDir: string;
  logLevel: LogLevel;
  nodeEnv: string;
}

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

const DEFAULT_PORT = 8080;
const DEFAULT_DIDIT_API_BASE = "https://verification.didit.me";
const DEFAULT_UPSTREAM_TIMEOUT_MS = 1200;
const DEFAULT_MEDIA_CACHE_DIR = "./.cache/media";
const DEFAULT_LOG_LEVEL: LogLevel = "info";
const DEFAULT_NODE_ENV = "development";

const VALID_LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

type Env = Record<string, string | undefined>;

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function keyPresent(env: Env): boolean {
  return !blank(env["DIDIT_API_KEY"]);
}

/** Single-line failure detail with the key-presence marker, no values. */
function fail(env: Env, reason: string): ConfigResult {
  return {
    ok: false,
    error: `${reason} (DIDIT_API_KEY present: ${keyPresent(env) ? "true" : "false"})`,
  };
}

export function loadConfig(env: Env): ConfigResult {
  const rawKey = env["DIDIT_API_KEY"];
  if (blank(rawKey)) {
    return fail(env, "DIDIT_API_KEY is required but missing or empty.");
  }

  let port = DEFAULT_PORT;
  const rawPort = env["PORT"];
  if (!blank(rawPort)) {
    const parsed = Number(rawPort?.trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return fail(env, "PORT must be an integer between 1 and 65535.");
    }
    port = parsed;
  }

  let diditApiBase = DEFAULT_DIDIT_API_BASE;
  const rawBase = env["DIDIT_API_BASE"];
  if (!blank(rawBase)) {
    const trimmed = rawBase?.trim() as string;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return fail(env, "DIDIT_API_BASE must be a valid http(s) URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return fail(env, "DIDIT_API_BASE must be a valid http(s) URL.");
    }
    diditApiBase = trimmed;
  }

  let upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS;
  const rawTimeout = env["UPSTREAM_TIMEOUT_MS"];
  if (!blank(rawTimeout)) {
    const parsed = Number(rawTimeout?.trim());
    if (!Number.isInteger(parsed) || parsed < 1) {
      return fail(env, "UPSTREAM_TIMEOUT_MS must be a positive integer in milliseconds.");
    }
    upstreamTimeoutMs = parsed;
  }

  let mediaCacheDir = DEFAULT_MEDIA_CACHE_DIR;
  const rawCacheDir = env["MEDIA_CACHE_DIR"];
  if (!blank(rawCacheDir)) {
    mediaCacheDir = rawCacheDir?.trim() as string;
  }

  let logLevel = DEFAULT_LOG_LEVEL;
  const rawLevel = env["LOG_LEVEL"];
  if (!blank(rawLevel)) {
    const normalized = rawLevel?.trim().toLowerCase() as string;
    if (!(VALID_LOG_LEVELS as readonly string[]).includes(normalized)) {
      return fail(
        env,
        "LOG_LEVEL must be one of debug, info, warn, error.",
      );
    }
    logLevel = normalized as LogLevel;
  }

  let nodeEnv = DEFAULT_NODE_ENV;
  const rawNodeEnv = env["NODE_ENV"];
  if (!blank(rawNodeEnv)) {
    nodeEnv = rawNodeEnv?.trim() as string;
  }

  return {
    ok: true,
    config: {
      port,
      diditApiKey: (rawKey as string).trim(),
      diditApiBase,
      upstreamTimeoutMs,
      mediaCacheDir,
      logLevel,
      nodeEnv,
    },
  };
}
