import { defaultCache } from "./cache";

// Generous enough for a judge who refines and retries a few times; shared venue IPs count together.
export const PLANS_PER_HOUR = 30;
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
  const key = `https://ratelimit.local/${encodeURIComponent(clientKey(ip))}/${hour}`;
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

/** IPv4 as is; IPv6 by its /64 prefix, since one host can rotate through a whole /64. */
export function clientKey(ip: string): string {
  const v = (ip || "unknown").trim().toLowerCase();
  if (!v.includes(":")) return v;
  const [head, tail = ""] = v.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = v.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Clears this isolate's in-memory counts (tests). */
export function resetRateLimits(): void {
  isolateCounts.clear();
}
