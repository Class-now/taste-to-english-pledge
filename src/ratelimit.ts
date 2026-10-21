import { defaultCache } from "./cache";

export const PLANS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
}

/**
 * Best-effort per-IP hourly counter on the Cache API (per data centre, not globally exact).
 * If the cache is unavailable the request is allowed.
 */
export async function checkRateLimit(
  ip: string,
  opts: { cache?: Cache; limit?: number; now?: number } = {},
): Promise<RateLimitResult> {
  const limit = opts.limit ?? PLANS_PER_HOUR;
  const cache = opts.cache ?? defaultCache();
  if (!cache) return { allowed: true, count: 0, limit };
  const hour = Math.floor((opts.now ?? Date.now()) / HOUR_MS);
  const key = `https://ratelimit.local/${encodeURIComponent(ip || "unknown")}/${hour}`;
  let count = 0;
  try {
    const hit = await cache.match(key);
    if (hit) count = Number(await hit.text()) || 0;
  } catch {
    return { allowed: true, count: 0, limit };
  }
  if (count >= limit) return { allowed: false, count, limit };
  count += 1;
  try {
    await cache.put(key, new Response(String(count), { headers: { "cache-control": "max-age=3600" } }));
  } catch {
    // best effort
  }
  return { allowed: true, count, limit };
}
