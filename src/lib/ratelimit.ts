import { timingSafeEqual } from "node:crypto";

/**
 * Sliding-window rate limiting, in memory.
 *
 * In memory is correct here, not a shortcut: the app runs as one systemd
 * process on one droplet, so there is no second instance to share state with.
 * If that ever changes this is the file that becomes wrong.
 *
 * What it protects: /api/lookup and /api/extract spend Tavily and Gemini quota
 * on every call, and /api/rates accepts writes — all reachable by anyone who
 * finds the endpoint. None of this had any limit at all.
 */
const hits = new Map<string, number[]>();

/** Keys tracked before old ones are evicted — a bound, not a target. */
const MAX_KEYS = 5000;

export function allow(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  if (hits.size > MAX_KEYS) {
    // Evict anything whose window has fully passed; a burst of spoofed IPs
    // must not grow this map without bound.
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= windowMs)) hits.delete(k);
    }
    if (hits.size > MAX_KEYS) hits.clear();
  }
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

/**
 * The caller's address as Caddy reports it. The first x-forwarded-for entry is
 * what the proxy saw on the wire; "unknown" lumps direct hits together, which
 * for a limiter is the conservative direction.
 */
export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/**
 * Does the request carry the admin secret? Constant-time compare, and a server
 * with no secret configured admits nobody rather than everybody.
 */
export function hasAdminSecret(request: Request): "ok" | "unconfigured" | "denied" {
  const secret = process.env.CARPARK_ADMIN_SECRET?.trim();
  if (!secret) return "unconfigured";
  const given = request.headers.get("x-admin-secret") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "denied";
}

/** Test helper — a limiter with state is a limiter tests must reset. */
export function clearRateLimits(): void {
  hits.clear();
}
