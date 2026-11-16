import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const KEY: Record<string, string | undefined> = {
  DIDIT_API_KEY: "test-placeholder-key",
};

describe("config", () => {
  test("applies defaults when only the key is set", () => {
    const result = loadConfig({ ...KEY });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config).toEqual({
      port: 8080,
      diditApiKey: "test-placeholder-key",
      diditApiBase: "https://verification.didit.me",
      upstreamTimeoutMs: 1200,
      mediaCacheDir: "./.cache/media",
      logLevel: "info",
      nodeEnv: "development",
      shutdownTimeoutMs: 10000,
    });
  });

  test("accepts valid overrides", () => {
    const result = loadConfig({
      ...KEY,
      PORT: "9000",
      DIDIT_API_BASE: "http://localhost:9999",
      UPSTREAM_TIMEOUT_MS: "5000",
      MEDIA_CACHE_DIR: "/tmp/media",
      LOG_LEVEL: "debug",
      NODE_ENV: "development",
      SHUTDOWN_TIMEOUT_MS: "3000",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.port).toBe(9000);
    expect(result.config.logLevel).toBe("debug");
    expect(result.config.upstreamTimeoutMs).toBe(5000);
    expect(result.config.shutdownTimeoutMs).toBe(3000);
  });

  test("missing key fails with a single line that states presence, not value", () => {
    const result = loadConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("DIDIT_API_KEY");
    expect(result.error).toContain("present: false");
    expect(result.error).not.toContain("\n");
  });

  test("malformed PORT fails and reports the key as present", () => {
    for (const port of ["abc", "0", "70000", "3.5"]) {
      const result = loadConfig({ ...KEY, PORT: port });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("PORT");
        expect(result.error).toContain("present: true");
        expect(result.error).not.toContain("test-placeholder-key");
      }
    }
  });

  test("malformed base, timeout and level values fail without leaking values", () => {
    const badEnvs: Record<string, string | undefined>[] = [
      { ...KEY, DIDIT_API_BASE: "not a url" },
      { ...KEY, DIDIT_API_BASE: "ftp://example.invalid" },
      { ...KEY, UPSTREAM_TIMEOUT_MS: "0" },
      { ...KEY, UPSTREAM_TIMEOUT_MS: "-5" },
      { ...KEY, LOG_LEVEL: "verbose" },
    ];
    for (const env of badEnvs) {
      const result = loadConfig(env);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain("\n");
        expect(result.error).not.toContain("test-placeholder-key");
      }
    }
  });

  test("empty optionals fall back to defaults", () => {
    const result = loadConfig({ ...KEY, PORT: "", LOG_LEVEL: "  " });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.port).toBe(8080);
    expect(result.config.logLevel).toBe("info");
  });

  test("http base is rejected outside development and test", () => {
    for (const nodeEnv of ["production", "staging"]) {
      const result = loadConfig({
        ...KEY,
        DIDIT_API_BASE: "http://localhost:9999",
        NODE_ENV: nodeEnv,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(
          "DIDIT_API_BASE must use https (http: is only allowed when NODE_ENV is development or test).",
        );
      }
    }
  });

  test("http base is accepted in development and test", () => {
    for (const nodeEnv of ["development", "test"]) {
      const result = loadConfig({
        ...KEY,
        DIDIT_API_BASE: "http://localhost:9999",
        NODE_ENV: nodeEnv,
      });
      expect(result.ok).toBe(true);
    }
  });

  test("base with credentials or query is rejected outright", () => {
    for (const base of ["https://user:pass@host", "https://host?x=1"]) {
      const result = loadConfig({ ...KEY, DIDIT_API_BASE: base });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("DIDIT_API_BASE must not contain credentials or query");
      }
    }
  });

  test("malformed SHUTDOWN_TIMEOUT_MS fails without leaking values", () => {
    for (const value of ["0", "-1", "abc"]) {
      const result = loadConfig({ ...KEY, SHUTDOWN_TIMEOUT_MS: value });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("SHUTDOWN_TIMEOUT_MS");
        expect(result.error).not.toContain("test-placeholder-key");
      }
    }
  });
});
