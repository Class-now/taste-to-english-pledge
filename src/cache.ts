import type { InsightsParams, QlooClient } from "./qloo";
import type { EntityType, QlooEntity, QlooTag } from "./types";

const DAY_SECONDS = 24 * 60 * 60;
const CACHE_ORIGIN = "https://qloo-cache.local";
const MEMORY_MAX_ENTRIES = 300;
const isolateEntries = new Map<string, { body: string; expires: number }>();
// Results served from a cache, so the agent trace can label them without widening the QlooClient interface.
const cachedResults = new WeakSet<object>();

/** True when `value` was returned from the cache rather than a fresh upstream call. */
export function wasCached(value: unknown): boolean {
  return typeof value === "object" && value !== null && cachedResults.has(value);
}

function markCached<T>(value: T): T {
  if (typeof value === "object" && value !== null) cachedResults.add(value);
  return value;
}

/** `caches.default` when the Cache API exists (Workers), else undefined (e.g. plain Node). */
export function defaultCache(): Cache | undefined {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}

/**
 * Caches successful, non-empty Qloo results for 24h, keyed by a URL built from the call and its parameters.
 * Bump the namespace version when the parsed entity shape changes so stale entries are not served.
 * The API key is never part of the key or the stored body. Cache failures fall through to the inner client.
 * A per-isolate in-memory Map sits in front of the Cache API, which stores nothing on *.workers.dev.
 */
export class CachedQlooClient implements QlooClient {
  constructor(
    private readonly inner: QlooClient,
    private readonly cache: Cache | undefined = defaultCache(),
    private readonly namespace = "v1",
    private readonly ttlSeconds = DAY_SECONDS,
    private readonly memory = isolateEntries,
    private readonly now: () => number = Date.now,
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
    const key = this.cacheKey(method, args);
    const mem = this.memory.get(key);
    if (mem && mem.expires > this.now()) return markCached(JSON.parse(mem.body) as T);
    if (mem) this.memory.delete(key);
    if (!this.cache) return this.remember(key, await run());
    try {
      const hit = await this.cache.match(key);
      if (hit) return markCached(this.remember(key, (await hit.json()) as T));
    } catch {
      // best effort: a broken cache read is a miss
    }
    const value = this.remember(key, await run());
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

  /** Stores a copy in the isolate Map (bounded; cleared when full) and returns the value. */
  private remember<T>(key: string, value: T): T {
    // An empty list is often a transient upstream glitch; don't pin it for a day.
    if (Array.isArray(value) && value.length === 0) return value;
    if (!this.memory.has(key) && this.memory.size >= MEMORY_MAX_ENTRIES) this.memory.clear();
    this.memory.set(key, { body: JSON.stringify(value), expires: this.now() + this.ttlSeconds * 1000 });
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

/** Clears this isolate's in-memory Qloo results (tests). */
export function resetMemoryCache(): void {
  isolateEntries.clear();
}
