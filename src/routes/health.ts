/**
 * Liveness and readiness probes.
 *
 * - `/healthz` is liveness: it never depends on config, so it stays 200
 *   even when the process is misconfigured.
 * - `/readyz` is readiness: 200 only when boot-time config was valid.
 *   The `reason` it returns on 503 comes from config validation, which by
 *   construction contains no secret values.
 */
export function handleHealthz(): Response {
  return Response.json({ status: "ok" }, { status: 200 });
}

export function handleReadyz(isReady: boolean, reason: string | null): Response {
  if (isReady) {
    return Response.json({ status: "ready" }, { status: 200 });
  }
  return Response.json(
    { status: "not_ready", reason: reason ?? "invalid configuration" },
    { status: 503 },
  );
}
