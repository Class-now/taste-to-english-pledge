import type { InsightsParams, QlooClient } from "./qloo";
import type { EntityType, QlooEntity, QlooTag } from "./types";

const DAY_SECONDS = 24 * 60 * 60;
const CACHE_ORIGIN = "https://qloo-cache.local";

/** `caches.default` when the Cache API exists (Workers), else undefined (e.g. plain Node). */
export function defaultCache(): Cache | undefined {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}

/**
 * Caches successful, non-empty Qloo results for 24h, keyed by a URL built from the call and its parameters.
 * Bump the namespace version when the parsed entity shape changes so stale entries are not served.
 * The API key is never part of the key or the stored body. Cache failures fall through to the inner client.
 */
export class CachedQlooClient implements QlooClient {
  constructor(
    private readonly inner: QlooClient,
    private readonly cache: Cache | undefined = defaultCache(),
    private readonly namespace = "v1",
    private readonly ttlSeconds = DAY_SECONDS,
  ) {}

  cacheKey(method: string, args: Record<string, unknown>): string {
    const url = new URL(`/${this.namespace}/${method}`, CACHE_ORIGIN);
    for (const k of Object.keys(args).sort()) {
      const v = args[k];
      if (v === undefined) continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    return url.toString();
  }

  private async cached<T>(method: string, args: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
    if (!this.cache) return run();
    const key = this.cacheKey(method, args);
    try {
      const hit = await this.cache.match(key);
      if (hit) return (await hit.json()) as T;
    } catch {
      // best effort: a broken cache read is a miss
    }
    const value = await run();
    // An empty list is often a transient upstream glitch; don't pin it for a day.
    if (Array.isArray(value) && value.length === 0) return value;
    try {
      await this.cache.put(
        key,
        new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json", "cache-control": `public, max-age=${this.ttlSeconds}` },
        }),
      );
    } catch {
      // best effort: never fail a request because the cache write failed
    }
    return value;
  }

  search(query: string, types?: EntityType[], take?: number): Promise<QlooEntity[]> {
    return this.cached("search", { query, types, take }, () => this.inner.search(query, types, take));
  }

  insights(p: InsightsParams): Promise<QlooEntity[]> {
    return this.cached("insights", { ...p }, () => this.inner.insights(p));
  }

  entityTags(entityIds: string[], take?: number): Promise<QlooTag[]> {
    return this.cached("entityTags", { entityIds, take }, () => this.inner.entityTags(entityIds, take));
  }

  searchTags(query: string, take?: number): Promise<QlooTag[]> {
    return this.cached("searchTags", { query, take }, () => this.inner.searchTags(query, take));
  }
}
