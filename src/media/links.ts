/**
 * Signed relay links for presigned biometric media.
 *
 * A link is `GET /m/{token}` with
 * `token = base64url(payloadJson) + "." + base64url(hmacSha256(signingKey, payloadJson))`
 * and `payloadJson = {"u":"<upstream url>","e":<unix ms expiry>}`.
 *
 * The token is the only authority: verification checks the signature with a
 * constant-time compare *before* parsing the payload, then requires an
 * http(s) URL on a configured media host and an expiry in the future. There
 * is no raw-URL parameter and no caller-supplied host anywhere on this path.
 *
 * The signing key is `MEDIA_SIGNING_SECRET` when set, otherwise derived
 * from `DIDIT_API_KEY` via HKDF-SHA256 with info `media-signing/v1`, so a
 * deployment that never sets the secret still signs with a key the caller
 * cannot reproduce.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** HKDF info string for the derived media signing key. Part of the format. */
export const MEDIA_SIGNING_INFO = "media-signing/v1";

const BASE64URL_PART = /^[A-Za-z0-9_-]+$/;
const HMAC_SHA256_BYTES = 32;

export type MediaTokenError = "malformed" | "bad-signature" | "bad-host" | "expired";

export type VerifyMediaTokenResult =
  | { ok: true; url: string; expiresAtMs: number }
  | { ok: false; reason: MediaTokenError };

export function deriveSigningKey(diditApiKey: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(diditApiKey, "utf8"),
      Buffer.alloc(0),
      MEDIA_SIGNING_INFO,
      HMAC_SHA256_BYTES,
    ),
  );
}

export function resolveSigningKey(config: {
  diditApiKey: string;
  mediaSigningSecret: string;
}): Buffer {
  if (config.mediaSigningSecret !== "") {
    return Buffer.from(config.mediaSigningSecret, "utf8");
  }
  return deriveSigningKey(config.diditApiKey);
}

/**
 * Mint a link token. Deterministic: the same URL and expiry always yield
 * the same bytes, so one response body repeats one token per URL.
 */
export function mintMediaToken(
  upstreamUrl: string,
  expiresAtMs: number,
  signingKey: Uint8Array,
): string {
  const payloadJson = JSON.stringify({ u: upstreamUrl, e: expiresAtMs });
  const payloadBytes = Buffer.from(payloadJson, "utf8");
  const signature = createHmac("sha256", signingKey).update(payloadBytes).digest();
  return `${payloadBytes.toString("base64url")}.${signature.toString("base64url")}`;
}

export function verifyMediaToken(
  token: string,
  signingKey: Uint8Array,
  mediaHosts: ReadonlySet<string>,
  nowMs: number,
): VerifyMediaTokenResult {
  const malformed = { ok: false, reason: "malformed" } as const;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) {
    return malformed;
  }
  const payloadPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  if (!BASE64URL_PART.test(payloadPart) || !BASE64URL_PART.test(sigPart)) {
    return malformed;
  }
  let payloadBytes: Buffer;
  let signature: Buffer;
  try {
    payloadBytes = Buffer.from(payloadPart, "base64url");
    signature = Buffer.from(sigPart, "base64url");
  } catch {
    return malformed;
  }
  if (payloadBytes.length === 0 || signature.length !== HMAC_SHA256_BYTES) {
    return malformed;
  }
  // The decoder is lenient (trailing bits, missing padding); only the
  // canonical spelling is accepted, so any single-character tampering
  // either changes the signed bytes or fails here.
  if (
    payloadBytes.toString("base64url") !== payloadPart ||
    signature.toString("base64url") !== sigPart
  ) {
    return malformed;
  }

  // Signature first, payload parsing only after it verifies.
  const expected = createHmac("sha256", signingKey).update(payloadBytes).digest();
  if (!timingSafeEqual(expected, signature)) {
    return { ok: false, reason: "bad-signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return malformed;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return malformed;
  }
  const { u, e } = parsed as Record<string, unknown>;
  if (typeof u !== "string" || typeof e !== "number" || !Number.isFinite(e)) {
    return malformed;
  }
  let hostname: string;
  let protocol: string;
  try {
    const url = new URL(u);
    hostname = url.hostname.toLowerCase();
    protocol = url.protocol;
  } catch {
    return malformed;
  }
  if ((protocol !== "http:" && protocol !== "https:") || !mediaHosts.has(hostname)) {
    return { ok: false, reason: "bad-host" };
  }
  if (e <= nowMs) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, url: u, expiresAtMs: e };
}
