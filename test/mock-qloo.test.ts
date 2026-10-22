import { describe, expect, it } from "vitest";
import { MOCK_ENTITIES } from "../src/mock-data";
import { MockQlooClient } from "../src/mock-qloo";

const q = new MockQlooClient();

describe("mock fixtures", () => {
  it("has at least 30 entities across the required types with 3–6 tags each", () => {
    expect(MOCK_ENTITIES.length).toBeGreaterThanOrEqual(30);
    for (const t of ["book", "podcast", "tv_show", "movie", "videogame"]) {
      expect(MOCK_ENTITIES.some((e) => e.type === t)).toBe(true);
    }
    for (const e of MOCK_ENTITIES) {
      expect(e.tags.length, e.name).toBeGreaterThanOrEqual(3);
      expect(e.tags.length, e.name).toBeLessThanOrEqual(6);
      if (e.type === "book") expect(e.pageCount, e.name).toBeGreaterThan(0);
    }
    expect(new Set(MOCK_ENTITIES.map((e) => e.id)).size).toBe(MOCK_ENTITIES.length);
  });
});

describe("MockQlooClient.search", () => {
  it("matches names case-insensitively", async () => {
    const [r] = await q.search("spirited away");
    expect(r).toMatchObject({ id: "mock-movie-spirited-away", name: "Spirited Away", type: "movie", year: 2001 });
  });

  it("resolves Japanese aliases", async () => {
    expect((await q.search("千と千尋の神隠し"))[0].id).toBe("mock-movie-spirited-away");
    expect((await q.search("君の名は"))[0].id).toBe("mock-movie-your-name");
    expect((await q.search("ノルウェイの森"))[0].id).toBe("mock-book-norwegian-wood");
    expect((await q.search("ペルソナ５"))[0].id).toBe("mock-game-persona-5");
    expect((await q.search("ゼルダの伝説"))[0].id).toBe("mock-game-zelda-botw");
  });

  it("respects the type filter and returns [] for unknown queries", async () => {
    expect(await q.search("Spirited Away", ["book"])).toEqual([]);
    expect(await q.search("zzz no such title")).toEqual([]);
    expect(await q.search("   ")).toEqual([]);
    const books = await q.search("Howl's Moving Castle", ["book"]);
    expect(books.map((e) => e.type)).toEqual(["book"]);
  });

  it("ranks exact matches first", async () => {
    const res = await q.search("Harry Potter and the Sacred Text");
    expect(res[0].id).toBe("mock-podcast-hp-sacred-text");
  });
});

describe("MockQlooClient.insights", () => {
  const seeds = ["mock-movie-spirited-away", "mock-game-persona-5", "mock-book-norwegian-wood"];

  it("returns only the requested type, excludes seeds, affinity in (0,1], sorted", async () => {
    const res = await q.insights({ type: "book", entityIds: seeds, excludeIds: seeds, take: 15, explain: true });
    expect(res.length).toBeGreaterThan(5);
    expect(res.every((e) => e.type === "book")).toBe(true);
    expect(res.some((e) => seeds.includes(e.id))).toBe(false);
    for (const e of res) {
      expect(e.affinity).toBeGreaterThan(0);
      expect(e.affinity).toBeLessThanOrEqual(1);
    }
    expect(res[0].affinity).toBe(1);
    const aff = res.map((e) => e.affinity!);
    expect([...aff].sort((a, b) => b - a)).toEqual(aff);
    expect(res[0].explainability).toBeDefined();
    const contributors = (res[0].explainability as { entities: { entity_id: string }[] }).entities;
    expect(contributors.length).toBeGreaterThan(0);
    expect(contributors.every((c) => seeds.includes(c.entity_id))).toBe(true);
  });

  it("is deterministic", async () => {
    const p = { type: "podcast" as const, entityIds: seeds, excludeIds: seeds, take: 15 };
    expect(await q.insights(p)).toEqual(await q.insights(p));
  });

  it("requested tags boost matching entities", async () => {
    const base = await q.insights({ type: "podcast", entityIds: seeds, take: 15 });
    const boosted = await q.insights({
      type: "podcast",
      entityIds: seeds,
      tagIds: ["urn:tag:keyword:media:history"],
      take: 15,
    });
    const rank = (list: typeof base, id: string) => list.findIndex((e) => e.id === id);
    expect(rank(boosted, "mock-podcast-hardcore-history")).toBeLessThan(rank(base, "mock-podcast-hardcore-history"));
  });

  it("applies year filters and take", async () => {
    const res = await q.insights({ type: "book", entityIds: seeds, minYear: 2000, maxYear: 2015, take: 3 });
    expect(res.length).toBeLessThanOrEqual(3);
    expect(res.every((e) => e.year! >= 2000 && e.year! <= 2015)).toBe(true);
  });
});

describe("MockQlooClient tags", () => {
  it("entityTags aggregates seed tags by frequency", async () => {
    const tags = await q.entityTags(["mock-movie-spirited-away", "mock-movie-your-name"], 20);
    expect(tags[0].affinity).toBe(1);
    const names = tags.filter((t) => t.affinity === 1).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["Fantasy", "Japan", "Animation", "Coming Of Age"]));
    expect(tags.find((t) => t.name === "Romance")?.affinity).toBe(0.5);
    expect(await q.entityTags(["nope"])).toEqual([]);
  });

  it("searchTags does substring matching", async () => {
    expect((await q.searchTags("mystery", 3)).map((t) => t.id)).toEqual(["urn:tag:keyword:media:mystery"]);
    expect((await q.searchTags("coming of age"))[0].name).toBe("Coming Of Age");
    expect(await q.searchTags("zzzz")).toEqual([]);
  });
});
