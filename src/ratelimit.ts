import { defaultCache } from "./cache";

export const PLANS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
const MEMORY_MAX_KEYS = 10_000;
const isolateCounts = new Map<string, number>();

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
}

/**
 * Best-effort per-IP hourly counter: an in-memory Map per isolate plus the Cache API (per data centre,
 * not globally exact). The Map still limits on *.workers.dev, where Cache API writes are no-ops.
 */
export async function checkRateLimit(
  ip: string,
  opts: { cache?: Cache; memory?: Map<string, number>; limit?: number; now?: number } = {},
): Promise<RateLimitResult> {
  const limit = opts.limit ?? PLANS_PER_HOUR;
  const cache = "cache" in opts ? opts.cache : defaultCache();
  const memory = opts.memory ?? isolateCounts;
  const hour = Math.floor((opts.now ?? Date.now()) / HOUR_MS);
  const key = `https://ratelimit.local/${encodeURIComponent(ip || "unknown")}/${hour}`;
  let count = memory.get(key) ?? 0;
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) count = Math.max(count, Number(await hit.text()) || 0);
    } catch {
      // best effort: the in-memory count still applies
    }
  }
  if (count >= limit) return { allowed: false, count, limit };
  count += 1;
  if (!memory.has(key) && memory.size >= MEMORY_MAX_KEYS) memory.clear();
  memory.set(key, count);
  if (cache) {
    try {
      await cache.put(key, new Response(String(count), { headers: { "cache-control": "max-age=3600" } }));
    } catch {
      // best effort
    }
  }
  return { allowed: true, count, limit };
}

/** Clears this isolate's in-memory counts (tests). */
export function resetRateLimits(): void {
  isolateCounts.clear();
}
