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
      upstreamTimeoutMs: 1500,
      upstreamWriteTimeoutMs: 5000,
      upstreamMaxBodyBytes: 8388608,
      mediaCacheDir: "./.cache/media",
      diditMediaHosts: [],
      publicMediaBase: "",
      mediaLinkTtlMs: 1800000,
      mediaCacheEnabled: true,
      mediaSigningSecret: "",
      mediaCacheMaxBytes: 268435456,
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
      UPSTREAM_WRITE_TIMEOUT_MS: "7000",
      UPSTREAM_MAX_BODY_BYTES: "1024",
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
    expect(result.config.upstreamWriteTimeoutMs).toBe(7000);
    expect(result.config.upstreamMaxBodyBytes).toBe(1024);
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

  test("malformed UPSTREAM_MAX_BODY_BYTES fails without leaking values", () => {
    for (const value of ["0", "-1", "abc", "1.5"]) {
      const result = loadConfig({ ...KEY, UPSTREAM_MAX_BODY_BYTES: value });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("UPSTREAM_MAX_BODY_BYTES");
        expect(result.error).not.toContain("test-placeholder-key");
      }
    }
  });

  test("blank UPSTREAM_MAX_BODY_BYTES falls back to the default", () => {
    const result = loadConfig({ ...KEY, UPSTREAM_MAX_BODY_BYTES: "  " });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.upstreamMaxBodyBytes).toBe(8388608);
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

  test("malformed UPSTREAM_WRITE_TIMEOUT_MS refuses boot without leaking values", () => {
    for (const value of ["0", "-1", "1.5", "abc"]) {
      const result = loadConfig({ ...KEY, UPSTREAM_WRITE_TIMEOUT_MS: value });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("UPSTREAM_WRITE_TIMEOUT_MS");
        expect(result.error).not.toContain("test-placeholder-key");
      }
    }
  });

  test("blank UPSTREAM_WRITE_TIMEOUT_MS falls back to the default", () => {
    const result = loadConfig({ ...KEY, UPSTREAM_WRITE_TIMEOUT_MS: "  " });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.upstreamWriteTimeoutMs).toBe(5000);
  });

  test("parses media overrides, normalising hosts and the base", () => {
    const result = loadConfig({
      ...KEY,
      DIDIT_MEDIA_HOSTS: "Media.Example.com, 127.0.0.1 ,media.example.com",
      PUBLIC_MEDIA_BASE: "https://assets.bank.example/",
      MEDIA_LINK_TTL_MS: "60000",
      MEDIA_CACHE_ENABLED: "FALSE",
      MEDIA_SIGNING_SECRET: "media-test-secret-PLACEHOLDER",
      MEDIA_CACHE_MAX_BYTES: "1024",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.diditMediaHosts).toEqual(["media.example.com", "127.0.0.1"]);
    expect(result.config.publicMediaBase).toBe("https://assets.bank.example");
    expect(result.config.mediaLinkTtlMs).toBe(60000);
    expect(result.config.mediaCacheEnabled).toBe(false);
    expect(result.config.mediaSigningSecret).toBe("media-test-secret-PLACEHOLDER");
    expect(result.config.mediaCacheMaxBytes).toBe(1024);
  });

  test("empty media hosts or base still boots (rewriting inert, not invalid)", () => {
    for (const env of [
      { ...KEY, PUBLIC_MEDIA_BASE: "https://assets.bank.example" },
      { ...KEY, DIDIT_MEDIA_HOSTS: "media.example.com" },
    ]) {
      const result = loadConfig(env);
      expect(result.ok).toBe(true);
    }
  });

  test("blank media optionals fall back to defaults", () => {
    const result = loadConfig({
      ...KEY,
      DIDIT_MEDIA_HOSTS: "  ",
      PUBLIC_MEDIA_BASE: "",
      MEDIA_LINK_TTL_MS: "",
      MEDIA_CACHE_ENABLED: "  ",
      MEDIA_SIGNING_SECRET: "",
      MEDIA_CACHE_MAX_BYTES: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.diditMediaHosts).toEqual([]);
    expect(result.config.publicMediaBase).toBe("");
    expect(result.config.mediaLinkTtlMs).toBe(1800000);
    expect(result.config.mediaCacheEnabled).toBe(true);
    expect(result.config.mediaSigningSecret).toBe("");
    expect(result.config.mediaCacheMaxBytes).toBe(268435456);
  });

  test("malformed DIDIT_MEDIA_HOSTS refuses boot without leaking values", () => {
    for (const value of [
      ",,,",
      "not a host!",
      "https://media.example.com",
      "media.example.com/path",
      "media.example.com:8080",
      "user@media.example.com",
      "bad..host",
      "-leading.example.com",
    ]) {
      const result = loadConfig({ ...KEY, DIDIT_MEDIA_HOSTS: value });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("DIDIT_MEDIA_HOSTS");
        expect(result.error).toContain("present: true");
        expect(result.error).not.toContain("\n");
        expect(result.error).not.toContain("test-placeholder-key");
      }
    }
  });

  test("malformed PUBLIC_MEDIA_BASE refuses boot without leaking values", () => {
    for (const value of [
      "not a url",
      "ftp://assets.bank.example",
      "https://assets.bank.example/media",
      "https://assets.bank.example?x=1",
      "https://user:pass@assets.bank.example",
      "https://assets.bank.example#frag",
    ]) {
      const result = loadConfig({ ...KEY, PUBLIC_MEDIA_BASE: value });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("PUBLIC_MEDIA_BASE");
        expect(result.error).not.toContain("\n");
        expect(result.error).not.toContain("test-placeholder-key");
      }
    }
  });

  test("http PUBLIC_MEDIA_BASE follows the same dev/test rule as the API base", () => {
    for (const nodeEnv of ["production", "staging"]) {
      const result = loadConfig({
        ...KEY,
        PUBLIC_MEDIA_BASE: "http://assets.internal:8080",
        NODE_ENV: nodeEnv,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("PUBLIC_MEDIA_BASE must use https");
      }
    }
    for (const nodeEnv of ["development", "test"]) {
      const result = loadConfig({
        ...KEY,
        PUBLIC_MEDIA_BASE: "http://assets.internal:8080",
        NODE_ENV: nodeEnv,
      });
      expect(result.ok).toBe(true);
    }
  });

  test("malformed media ttl, toggle and cache cap refuse boot", () => {
    const cases: [string, string][] = [
      ["MEDIA_LINK_TTL_MS", "0"],
      ["MEDIA_LINK_TTL_MS", "-1"],
      ["MEDIA_LINK_TTL_MS", "1.5"],
      ["MEDIA_LINK_TTL_MS", "abc"],
      ["MEDIA_CACHE_ENABLED", "yes"],
      ["MEDIA_CACHE_ENABLED", "1"],
      ["MEDIA_CACHE_ENABLED", "off"],
      ["MEDIA_CACHE_MAX_BYTES", "0"],
      ["MEDIA_CACHE_MAX_BYTES", "-5"],
      ["MEDIA_CACHE_MAX_BYTES", "abc"],
    ];
    for (const [key, value] of cases) {
      const result = loadConfig({ ...KEY, [key]: value });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(key);
        expect(result.error).not.toContain("\n");
        expect(result.error).not.toContain("test-placeholder-key");
      }
    }
  });
});
