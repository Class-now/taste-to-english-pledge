import { describe, expect, it } from "vitest";
import { CachedQlooClient } from "../src/cache";
import { MockQlooClient } from "../src/mock-qloo";
import { checkRateLimit } from "../src/ratelimit";
import { MemoryCache } from "./memory-cache";

class CountingQloo extends MockQlooClient {
  calls = 0;
  override async search(...args: Parameters<MockQlooClient["search"]>) {
    this.calls++;
    return super.search(...args);
  }
}

describe("CachedQlooClient", () => {
  it("serves repeat calls from the cache with a 24h TTL", async () => {
    const cache = new MemoryCache();
    const inner = new CountingQloo();
    const c = new CachedQlooClient(inner, cache as unknown as Cache, "live");
    const a = await c.search("Spirited Away", ["movie"], 5);
    const b = await c.search("Spirited Away", ["movie"], 5);
    expect(b).toEqual(a);
    expect(inner.calls).toBe(1);
    const [key, entry] = [...cache.store.entries()][0];
    expect(key).toBe("https://qloo-cache.local/live/search?query=Spirited+Away&take=5&types=movie");
    expect(new Headers(entry.headers).get("cache-control")).toContain("max-age=86400");
  });

  it("does not cache failures and works without a cache", async () => {
    const cache = new MemoryCache();
    let n = 0;
    const failing = new (class extends MockQlooClient {
      override async searchTags(): Promise<never> {
        n++;
        throw new Error("boom");
      }
    })();
    const c = new CachedQlooClient(failing, cache as unknown as Cache);
    await expect(c.searchTags("mystery")).rejects.toThrow("boom");
    await expect(c.searchTags("mystery")).rejects.toThrow("boom");
    expect(n).toBe(2);
    expect(cache.store.size).toBe(0);
    expect(await new CachedQlooClient(new MockQlooClient(), undefined).searchTags("myst")).not.toHaveLength(0);
  });

  it("does not cache empty results", async () => {
    const cache = new MemoryCache();
    const inner = new CountingQloo();
    const c = new CachedQlooClient(inner, cache as unknown as Cache, "v1-live");
    expect(await c.search("zzqx unknown work")).toEqual([]);
    expect(await c.search("zzqx unknown work")).toEqual([]);
    expect(inner.calls).toBe(2);
    expect(cache.store.size).toBe(0);
  });

  it("falls through to the inner client when the cache throws", async () => {
    const broken = {
      match: async () => {
        throw new Error("read failed");
      },
      put: async () => {
        throw new Error("write failed");
      },
    } as unknown as Cache;
    const inner = new CountingQloo();
    const res = await new CachedQlooClient(inner, broken, "v1-live").search("Spirited Away", ["movie"], 5);
    expect(res[0].name).toBe("Spirited Away");
    expect(inner.calls).toBe(1);
  });
});

describe("checkRateLimit", () => {
  it("allows the limit per hour per IP and resets next hour", async () => {
    const cache = new MemoryCache() as unknown as Cache;
    const memory = new Map<string, number>();
    const now = Date.UTC(2026, 9, 21, 10, 5);
    for (let i = 1; i <= 3; i++) expect(await checkRateLimit("1.2.3.4", { cache, memory, limit: 3, now })).toMatchObject({ allowed: true, count: i });
    expect((await checkRateLimit("1.2.3.4", { cache, memory, limit: 3, now })).allowed).toBe(false);
    expect((await checkRateLimit("5.6.7.8", { cache, memory, limit: 3, now })).allowed).toBe(true);
    expect((await checkRateLimit("1.2.3.4", { cache, memory, limit: 3, now: now + 3600_000 })).allowed).toBe(true);
  });

  it("still limits with the in-memory count when the Cache API stores nothing (workers.dev)", async () => {
    const noop = { match: async () => undefined, put: async () => {} } as unknown as Cache;
    const memory = new Map<string, number>();
    const now = Date.UTC(2026, 9, 21, 10, 5);
    for (let i = 0; i < 2; i++) expect((await checkRateLimit("1.2.3.4", { cache: noop, memory, limit: 2, now })).allowed).toBe(true);
    expect((await checkRateLimit("1.2.3.4", { cache: noop, memory, limit: 2, now })).allowed).toBe(false);
    for (let i = 0; i < 2; i++) expect((await checkRateLimit("5.6.7.8", { cache: undefined, memory, limit: 2, now })).allowed).toBe(true);
    expect((await checkRateLimit("5.6.7.8", { cache: undefined, memory, limit: 2, now })).allowed).toBe(false);
  });
});
