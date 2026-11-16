/**
 * Structured JSON logger with recursive redaction.
 *
 * Each call writes one JSON line to stdout with `level`, `time`, `msg`,
 * plus caller-supplied fields (conventionally including `requestId`).
 *
 * Redaction: any object key matching the pattern below (case-insensitive)
 * has its value replaced with `[REDACTED]`. Matching is by substring, so
 * `apiKey`, `x-api-key` and `authToken` all match.
 *
 * Guarantees:
 * - redaction recurses through nested objects and arrays;
 * - `Error` values are serialised as `{ name, message, stack, cause, ... }`
 *   with `message`/`stack` content-scrubbed, not just key-matched;
 * - circular references serialise as `"[Circular]"` instead of throwing;
 * - strings longer than 2048 characters are truncated;
 * - the logger never throws: sanitisation and sink failures are swallowed.
 *
 * Callers must never pass request or response bodies to the logger.
 * Access logs carry method, path, status, duration and requestId only.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type LogSink = (line: string) => void;

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
}

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

// Any key matching this pattern (case-insensitive) is redacted.
const SENSITIVE_PATTERN =
  "api[_-]?key|authorization|portrait|selfie|image|document|token|secret|password|cookie";
const SENSITIVE_KEY = new RegExp(SENSITIVE_PATTERN, "i");
const SENSITIVE_WORD = new RegExp(SENSITIVE_PATTERN, "gi");
const KEY_VALUE_PAIR = new RegExp(
  `"?((?:${SENSITIVE_PATTERN}))"?\\s*[:=]\\s*"?([^"\\s,}&;)]+)"?`,
  "gi",
);

const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";
const UNSERIALIZABLE = "[Unserializable]";
const MAX_STRING_LENGTH = 2048;
const TRUNCATION_SUFFIX = "...[truncated]";
// Values shorter than this are never treated as known secrets, so a short
// redacted value cannot blank out unrelated log text.
const MIN_SECRET_LENGTH = 4;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function levelFromEnv(env: Record<string, string | undefined>): LogLevel {
  const raw = (env["LOG_LEVEL"] ?? "").trim().toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  return "info";
}

function truncate(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }
  return value.slice(0, MAX_STRING_LENGTH) + TRUNCATION_SUFFIX;
}

/** Replace every occurrence of each known secret with `[REDACTED]`. */
function replaceSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

/**
 * Scrub free-text error content. Besides known secrets, redact
 * `key=value` / `key: value` pairs whose key is sensitive, then any
 * remaining sensitive word, so a secret embedded in a message or stack
 * trace cannot slip through in an unfamiliar format.
 */
function scrubErrorText(text: string, secrets: string[]): string {
  const withoutSecrets = replaceSecrets(text, secrets);
  const withoutPairs = withoutSecrets.replace(KEY_VALUE_PAIR, REDACTED);
  const withoutWords = withoutPairs.replace(SENSITIVE_WORD, REDACTED);
  return truncate(withoutWords);
}

/**
 * Pre-pass: collect string values stored under sensitive keys so their
 * occurrences inside error messages and stack traces can be scrubbed even
 * when they appear without the key name next to them.
 */
function collectSecrets(
  value: unknown,
  secrets: string[],
  seen: Set<object>,
): void {
  if (typeof value === "string") {
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  try {
    if (value instanceof Error) {
      const fields = value as unknown as Record<string, unknown>;
      for (const key of Object.keys(value)) {
        collectValueUnderKey(key, fields[key], secrets, seen);
      }
      if ("cause" in value) {
        collectSecrets((value as { cause?: unknown }).cause, secrets, seen);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        collectSecrets(item, secrets, seen);
      }
      return;
    }
    for (const key of Object.keys(value)) {
      collectValueUnderKey(key, (value as Record<string, unknown>)[key], secrets, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function collectValueUnderKey(
  key: string,
  value: unknown,
  secrets: string[],
  seen: Set<object>,
): void {
  if (typeof value === "string") {
    if (SENSITIVE_KEY.test(key) && value.length >= MIN_SECRET_LENGTH) {
      secrets.push(value);
    }
    return;
  }
  collectSecrets(value, secrets, seen);
}

function sanitize(value: unknown, ancestors: Set<object>, secrets: string[]): unknown {
  if (typeof value === "string") {
    return truncate(replaceSecrets(value, secrets));
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return truncate(value.toString());
  }

  if (ancestors.has(value)) {
    return CIRCULAR;
  }
  ancestors.add(value);
  try {
    if (value instanceof Error) {
      return sanitizeError(value, ancestors, secrets);
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item, ancestors, secrets));
    }
    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") {
      try {
        return sanitize(
          (toJson as () => unknown).call(value),
          ancestors,
          secrets,
        );
      } catch {
        return UNSERIALIZABLE;
      }
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = sanitize(
          (value as Record<string, unknown>)[key],
          ancestors,
          secrets,
        );
      }
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function sanitizeError(
  err: Error,
  ancestors: Set<object>,
  secrets: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: scrubErrorText(String(err.name), secrets),
    message: scrubErrorText(err.message, secrets),
  };
  if (typeof err.stack === "string") {
    out["stack"] = scrubErrorText(err.stack, secrets);
  }
  const ownFields = err as unknown as Record<string, unknown>;
  for (const key of Object.keys(err)) {
    if (key === "name" || key === "message" || key === "stack" || key === "cause") {
      continue;
    }
    if (SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = sanitize(ownFields[key], ancestors, secrets);
    }
  }
  if ("cause" in err) {
    out["cause"] = sanitize((err as { cause?: unknown }).cause, ancestors, secrets);
  }
  return out;
}

function defaultSink(line: string): void {
  process.stdout.write(line + "\n");
}

export function createLogger(options?: LoggerOptions): Logger {
  const level = options?.level ?? levelFromEnv(process.env);
  const sink = options?.sink ?? defaultSink;

  function write(
    entryLevel: LogLevel,
    msg: string,
    fields: LogFields | undefined,
    bindings: LogFields,
  ): void {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) {
      return;
    }
    try {
      const secrets: string[] = [];
      try {
        collectSecrets(fields, secrets, new Set());
        collectSecrets(bindings, secrets, new Set());
      } catch {
        // Secret collection is best-effort; sanitising still runs below.
      }
      const record = sanitize(
        { level: entryLevel, time: new Date().toISOString(), msg, ...bindings, ...fields },
        new Set(),
        secrets,
      );
      const line = JSON.stringify(record);
      try {
        sink(line);
      } catch {
        // A failed log write must never take down a request.
      }
    } catch {
      // The logger never throws.
    }
  }

  function makeLogger(bindings: LogFields): Logger {
    return {
      level,
      debug: (msg: string, fields?: LogFields) => write("debug", msg, fields, bindings),
      info: (msg: string, fields?: LogFields) => write("info", msg, fields, bindings),
      warn: (msg: string, fields?: LogFields) => write("warn", msg, fields, bindings),
      error: (msg: string, fields?: LogFields) => write("error", msg, fields, bindings),
      child: (more: LogFields) => makeLogger({ ...bindings, ...more }),
    };
  }

  return makeLogger({});
}

/** Process-wide logger. Level comes from `LOG_LEVEL`, default `info`. */
export const logger: Logger = createLogger();
