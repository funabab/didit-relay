/**
 * Environment parsing and validation. Runs once at boot; the process refuses
 * to start when the result is invalid.
 *
 * Rules:
 * - `DIDIT_API_KEY` is required and must be non-empty.
 * - `DIDIT_API_BASE` must be https unless `NODE_ENV` is `development` or
 *   `test`, and must never carry userinfo or a query string.
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
  /** Budget for `GET`/`HEAD` upstream calls (reads). */
  upstreamTimeoutMs: number;
  /** Budget for `POST`/`PATCH`/`DELETE` upstream calls (writes). */
  upstreamWriteTimeoutMs: number;
  upstreamMaxBodyBytes: number;
  mediaCacheDir: string;
  /** Lowercased hostnames whose URLs are rewritten to relay media links. Empty disables rewriting. */
  diditMediaHosts: string[];
  /** Absolute origin the bank uses for media links. Empty disables rewriting. */
  publicMediaBase: string;
  /** Lifetime of a relay media link, in milliseconds. */
  mediaLinkTtlMs: number;
  /** When false, media is streamed upstream on every request and never cached. */
  mediaCacheEnabled: boolean;
  /** Explicit media signing secret. Empty derives the key from `DIDIT_API_KEY`. */
  mediaSigningSecret: string;
  /** Upper bound on bytes held under the media cache directory. */
  mediaCacheMaxBytes: number;
  logLevel: LogLevel;
  nodeEnv: string;
  shutdownTimeoutMs: number;
}

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

const DEFAULT_PORT = 8080;
const DEFAULT_DIDIT_API_BASE = "https://verification.didit.me";
// Measured 2026-11-18 against the live sandbox API: eight
// POST /v3/session/ creates with a real portrait took 2036 1426 1406 2024
// 1494 2229 1287 1440 ms (min 1287, median ~1470, max 2229), and a
// GET .../decision/ read took ~300 ms. The write budget is >2x the
// observed create max; the read budget is 5x the observed read, so a hung
// read hands the customer to OTP in about a second instead of holding
// the mandate screen.
const DEFAULT_UPSTREAM_TIMEOUT_MS = 1500;
const DEFAULT_UPSTREAM_WRITE_TIMEOUT_MS = 5000;
const DEFAULT_UPSTREAM_MAX_BODY_BYTES = 8388608;
const DEFAULT_MEDIA_CACHE_DIR = "./.cache/media";
// Upstream presigned media URLs are believed to live ~1h (unobserved as
// yet); relay links last 30 minutes to leave margin. See README "Media".
const DEFAULT_MEDIA_LINK_TTL_MS = 1800000;
const DEFAULT_MEDIA_CACHE_ENABLED = true;
const DEFAULT_MEDIA_CACHE_MAX_BYTES = 268435456;
const DEFAULT_LOG_LEVEL: LogLevel = "info";
const DEFAULT_NODE_ENV = "development";
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;

const VALID_LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

// Bare hostnames only: no scheme, port, path, userinfo or whitespace.
// Covers DNS names, `localhost` and IPv4 literals (tests use 127.0.0.1).
const HOSTNAME_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const HOSTNAME_PATTERN = new RegExp(`^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})*$`);

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

  // Parsed before DIDIT_API_BASE: the http(s) check depends on it.
  let nodeEnv = DEFAULT_NODE_ENV;
  const rawNodeEnv = env["NODE_ENV"];
  if (!blank(rawNodeEnv)) {
    nodeEnv = rawNodeEnv?.trim() as string;
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
    if (url.username !== "" || url.password !== "" || url.search !== "") {
      return fail(env, "DIDIT_API_BASE must not contain credentials or query.");
    }
    if (url.protocol === "http:" && nodeEnv !== "development" && nodeEnv !== "test") {
      return fail(
        env,
        "DIDIT_API_BASE must use https (http: is only allowed when NODE_ENV is development or test).",
      );
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

  let upstreamWriteTimeoutMs = DEFAULT_UPSTREAM_WRITE_TIMEOUT_MS;
  const rawWriteTimeout = env["UPSTREAM_WRITE_TIMEOUT_MS"];
  if (!blank(rawWriteTimeout)) {
    const parsed = Number(rawWriteTimeout?.trim());
    if (!Number.isInteger(parsed) || parsed < 1) {
      return fail(env, "UPSTREAM_WRITE_TIMEOUT_MS must be a positive integer in milliseconds.");
    }
    upstreamWriteTimeoutMs = parsed;
  }

  let upstreamMaxBodyBytes = DEFAULT_UPSTREAM_MAX_BODY_BYTES;
  const rawMaxBody = env["UPSTREAM_MAX_BODY_BYTES"];
  if (!blank(rawMaxBody)) {
    const parsed = Number(rawMaxBody?.trim());
    if (!Number.isInteger(parsed) || parsed < 1) {
      return fail(env, "UPSTREAM_MAX_BODY_BYTES must be a positive integer in bytes.");
    }
    upstreamMaxBodyBytes = parsed;
  }

  let mediaCacheDir = DEFAULT_MEDIA_CACHE_DIR;
  const rawCacheDir = env["MEDIA_CACHE_DIR"];
  if (!blank(rawCacheDir)) {
    mediaCacheDir = rawCacheDir?.trim() as string;
  }

  let diditMediaHosts: string[] = [];
  const rawMediaHosts = env["DIDIT_MEDIA_HOSTS"];
  if (!blank(rawMediaHosts)) {
    const entries = (rawMediaHosts as string)
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const seen = new Set<string>();
    const hosts: string[] = [];
    let valid = entries.length > 0;
    for (const entry of entries) {
      if (entry.length > 253 || !HOSTNAME_PATTERN.test(entry)) {
        valid = false;
        break;
      }
      const lower = entry.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        hosts.push(lower);
      }
    }
    if (!valid) {
      return fail(env, "DIDIT_MEDIA_HOSTS must be a comma-separated list of hostnames.");
    }
    diditMediaHosts = hosts;
  }

  let publicMediaBase = "";
  const rawMediaBase = env["PUBLIC_MEDIA_BASE"];
  if (!blank(rawMediaBase)) {
    const trimmed = rawMediaBase?.trim() as string;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return fail(env, "PUBLIC_MEDIA_BASE must be a valid absolute http(s) origin.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return fail(env, "PUBLIC_MEDIA_BASE must be a valid absolute http(s) origin.");
    }
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      return fail(env, "PUBLIC_MEDIA_BASE must not contain credentials, query or fragment.");
    }
    if (url.pathname !== "" && url.pathname !== "/") {
      return fail(env, "PUBLIC_MEDIA_BASE must be a valid absolute http(s) origin.");
    }
    if (url.protocol === "http:" && nodeEnv !== "development" && nodeEnv !== "test") {
      return fail(
        env,
        "PUBLIC_MEDIA_BASE must use https (http: is only allowed when NODE_ENV is development or test).",
      );
    }
    publicMediaBase = trimmed.replace(/\/+$/, "");
  }

  let mediaLinkTtlMs = DEFAULT_MEDIA_LINK_TTL_MS;
  const rawLinkTtl = env["MEDIA_LINK_TTL_MS"];
  if (!blank(rawLinkTtl)) {
    const parsed = Number(rawLinkTtl?.trim());
    if (!Number.isInteger(parsed) || parsed < 1) {
      return fail(env, "MEDIA_LINK_TTL_MS must be a positive integer in milliseconds.");
    }
    mediaLinkTtlMs = parsed;
  }

  let mediaCacheEnabled = DEFAULT_MEDIA_CACHE_ENABLED;
  const rawCacheEnabled = env["MEDIA_CACHE_ENABLED"];
  if (!blank(rawCacheEnabled)) {
    const normalized = rawCacheEnabled?.trim().toLowerCase() as string;
    if (normalized !== "true" && normalized !== "false") {
      return fail(env, "MEDIA_CACHE_ENABLED must be either true or false.");
    }
    mediaCacheEnabled = normalized === "true";
  }

  let mediaSigningSecret = "";
  const rawSigningSecret = env["MEDIA_SIGNING_SECRET"];
  if (!blank(rawSigningSecret)) {
    mediaSigningSecret = rawSigningSecret?.trim() as string;
  }

  let mediaCacheMaxBytes = DEFAULT_MEDIA_CACHE_MAX_BYTES;
  const rawCacheMax = env["MEDIA_CACHE_MAX_BYTES"];
  if (!blank(rawCacheMax)) {
    const parsed = Number(rawCacheMax?.trim());
    if (!Number.isInteger(parsed) || parsed < 1) {
      return fail(env, "MEDIA_CACHE_MAX_BYTES must be a positive integer in bytes.");
    }
    mediaCacheMaxBytes = parsed;
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

  let shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const rawShutdownTimeout = env["SHUTDOWN_TIMEOUT_MS"];
  if (!blank(rawShutdownTimeout)) {
    const parsed = Number(rawShutdownTimeout?.trim());
    if (!Number.isInteger(parsed) || parsed < 1) {
      return fail(env, "SHUTDOWN_TIMEOUT_MS must be a positive integer in milliseconds.");
    }
    shutdownTimeoutMs = parsed;
  }

  return {
    ok: true,
    config: {
      port,
      diditApiKey: (rawKey as string).trim(),
      diditApiBase,
      upstreamTimeoutMs,
      upstreamWriteTimeoutMs,
      upstreamMaxBodyBytes,
      mediaCacheDir,
      diditMediaHosts,
      publicMediaBase,
      mediaLinkTtlMs,
      mediaCacheEnabled,
      mediaSigningSecret,
      mediaCacheMaxBytes,
      logLevel,
      nodeEnv,
      shutdownTimeoutMs,
    },
  };
}
