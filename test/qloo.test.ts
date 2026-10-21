import { describe, expect, it } from "vitest";
import { MockQlooClient } from "../src/mock-qloo";
import { createQlooClient, HttpQlooClient, QlooError, qlooMode } from "../src/qloo";

// Inline sample payloads shaped like docs/qloo-api-notes.md (synthetic values, not Qloo data).
const SEARCH_BODY = {
  success: true,
  results: [
    {
      name: "Spirited Away",
      entity_id: "E-SPIRITED",
      types: ["urn:entity:movie"],
      popularity: 0.99,
      properties: { release_year: 2001, description: "A girl in a spirit world.", image: { url: "https://img/x.jpg" } },
    },
    { name: "No id here", types: ["urn:entity:movie"] },
  ],
};

const INSIGHTS_BODY = {
  success: true,
  results: {
    entities: [
      {
        name: "A Book",
        entity_id: "B1",
        type: "urn:entity",
        subtype: "urn:entity:book",
        popularity: 0.8,
        properties: {
          short_description: "Short.",
          publication_year: 2010,
          language: "en",
          page_count: 320,
          image: { url: "https://img/b1.jpg" },
        },
        tags: [{ id: "urn:tag:genre:media:fantasy", name: "Fantasy", type: "urn:tag:genre:media" }],
        query: { affinity: 0.93, explainability: { "signal.interests.entities": [{ entity_id: "SEED", score: 0.7 }] } },
        disambiguation: "2010, Some Author",
      },
      {
        name: "Top-level affinity",
        entity_id: "B2",
        subtype: "urn:entity:book",
        affinity: 0.5,
        properties: { publication_date: "1999-05-01" },
      },
    ],
  },
};

const TAGS_BODY = {
  success: true,
  results: {
    tags: [
      {
        tag_id: "urn:tag:keyword:media:coming_of_age",
        name: "Coming Of Age",
        subtype: "urn:tag:keyword:media",
        query: { affinity: 0.99 },
      },
      { id: "urn:tag:genre:media:mystery", name: "Mystery", type: "urn:tag:genre:media", query: {} },
    ],
  },
};

interface Call {
  url: URL;
  init?: RequestInit;
}

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = async (input: string, init?: RequestInit) => {
    calls.push({ url: new URL(input), init });
    const r = responses[Math.min(i++, responses.length - 1)];
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status, headers: { "content-type": "text/plain" } });
  };
  return { fn, calls };
}

const BASE = "https://hackathon.api.qloo.com";
const client = (responses: Array<{ status: number; body: unknown }>) => {
  const f = fakeFetch(responses);
  return { c: new HttpQlooClient(BASE, "test-key", f.fn, { retryDelayMs: 0 }), calls: f.calls };
};
const header = (call: Call, name: string) => new Headers(call.init?.headers).get(name);

describe("HttpQlooClient", () => {
  it("search builds URL, sends X-Api-Key and parses a flat results array", async () => {
    const { c, calls } = client([{ status: 200, body: SEARCH_BODY }]);
    const res = await c.search("Spirited Away", ["movie", "tv_show"], 5);
    expect(calls).toHaveLength(1);
    const u = calls[0].url;
    expect(u.origin + u.pathname).toBe(`${BASE}/search`);
    expect(u.searchParams.get("query")).toBe("Spirited Away");
    expect(u.searchParams.get("types")).toBe("urn:entity:movie,urn:entity:tv_show");
    expect(u.searchParams.get("take")).toBe("5");
    expect(u.searchParams.has("X-Api-Key")).toBe(false);
    expect(calls[0].init?.method).toBe("GET");
    expect(header(calls[0], "X-Api-Key")).toBe("test-key");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(res).toEqual([
      {
        id: "E-SPIRITED",
        name: "Spirited Away",
        type: "movie",
        year: 2001,
        description: "A girl in a spirit world.",
        imageUrl: "https://img/x.jpg",
        popularity: 0.99,
        tags: [],
      },
    ]);
  });

  it("insights sends comma-joined arrays, explainability and book year filters", async () => {
    const { c, calls } = client([{ status: 200, body: INSIGHTS_BODY }]);
    const res = await c.insights({
      type: "book",
      entityIds: ["S1", "S2"],
      tagIds: ["urn:tag:a", "urn:tag:b"],
      excludeIds: ["S1", "S2"],
      take: 15,
      minYear: 1990,
      maxYear: 2020,
      explain: true,
    });
    const p = calls[0].url.searchParams;
    expect(calls[0].url.pathname).toBe("/v2/insights");
    expect(p.get("filter.type")).toBe("urn:entity:book");
    expect(p.get("signal.interests.entities")).toBe("S1,S2");
    expect(p.get("signal.interests.tags")).toBe("urn:tag:a,urn:tag:b");
    expect(p.get("filter.exclude.entities")).toBe("S1,S2");
    expect(p.get("take")).toBe("15");
    expect(p.get("feature.explainability")).toBe("true");
    expect(p.get("filter.publication_year.min")).toBe("1990");
    expect(p.get("filter.publication_year.max")).toBe("2020");
    expect(p.has("filter.release_year.min")).toBe(false);

    expect(res[0]).toEqual({
      id: "B1",
      name: "A Book",
      type: "book",
      year: 2010,
      description: "Short.",
      imageUrl: "https://img/b1.jpg",
      popularity: 0.8,
      affinity: 0.93,
      tags: [{ id: "urn:tag:genre:media:fantasy", name: "Fantasy", subtype: "urn:tag:genre:media" }],
      disambiguation: "2010, Some Author",
      language: "en",
      pageCount: 320,
      explainability: { "signal.interests.entities": [{ entity_id: "SEED", score: 0.7 }] },
    });
    expect(res[1]).toMatchObject({ id: "B2", affinity: 0.5, year: 1999, type: "book", tags: [] });
  });

  it("insights uses release_year for movies and omits empty optional params", async () => {
    const { c, calls } = client([{ status: 200, body: { results: { entities: [] } } }]);
    await c.insights({ type: "movie", entityIds: ["S1"], minYear: 2000 });
    const p = calls[0].url.searchParams;
    expect(p.get("filter.release_year.min")).toBe("2000");
    expect(p.has("filter.release_year.max")).toBe(false);
    expect(p.has("signal.interests.tags")).toBe(false);
    expect(p.has("feature.explainability")).toBe(false);
  });

  it("insights filters podcast years client-side", async () => {
    const body = {
      results: {
        entities: [
          { name: "Old", entity_id: "P1", subtype: "urn:entity:podcast", properties: { release_date: "2005-01-01" } },
          { name: "New", entity_id: "P2", subtype: "urn:entity:podcast", properties: { release_year: 2020 } },
          { name: "Unknown", entity_id: "P3", subtype: "urn:entity:podcast" },
        ],
      },
    };
    const { c, calls } = client([{ status: 200, body }]);
    const res = await c.insights({ type: "podcast", entityIds: ["S1"], minYear: 2010 });
    expect(calls[0].url.searchParams.has("filter.release_year.min")).toBe(false);
    expect(res.map((e) => e.id)).toEqual(["P2", "P3"]);
  });

  it("entityTags and searchTags parse results.tags", async () => {
    const { c, calls } = client([
      { status: 200, body: TAGS_BODY },
      { status: 200, body: TAGS_BODY },
    ]);
    const tags = await c.entityTags(["S1", "S2"], 20);
    const p = calls[0].url.searchParams;
    expect(p.get("filter.type")).toBe("urn:tag");
    expect(p.get("signal.interests.entities")).toBe("S1,S2");
    expect(p.get("take")).toBe("20");
    expect(p.get("filter.tag.types")).toBe("urn:tag:genre:media,urn:tag:keyword:media");
    expect(tags).toEqual([
      { id: "urn:tag:keyword:media:coming_of_age", name: "Coming Of Age", subtype: "urn:tag:keyword:media", affinity: 0.99 },
      { id: "urn:tag:genre:media:mystery", name: "Mystery", subtype: "urn:tag:genre:media" },
    ]);

    await c.searchTags("mystery", 3);
    const q = calls[1].url.searchParams;
    expect(calls[1].url.pathname).toBe("/v2/tags");
    expect(q.get("filter.query")).toBe("mystery");
    expect(q.get("feature.semantic_search")).toBe("true");
    expect(q.get("take")).toBe("3");
    expect(q.get("filter.tag.types")).toBe("urn:tag:genre:media,urn:tag:keyword:media");
  });

  it("throws QlooError with nested or flat error messages", async () => {
    const nested = client([
      { status: 401, body: { error: { reason: "No API key found in request", message: "Unauthorized", code: 401 } } },
    ]);
    await expect(nested.c.search("x")).rejects.toMatchObject({ name: "QlooError", status: 401, message: "Unauthorized" });

    const flat = client([{ status: 404, body: { code: 404, reason: "nope", message: "No path matching request" } }]);
    const err = await flat.c.searchTags("x").catch((e) => e);
    expect(err).toBeInstanceOf(QlooError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("No path matching request");

    const plain = client([{ status: 400, body: "bad things" }]);
    await expect(plain.c.searchTags("x")).rejects.toMatchObject({ status: 400, message: "bad things" });
  });

  it("retries once on 429/5xx, then succeeds or throws", async () => {
    const ok = client([
      { status: 429, body: { message: "slow down" } },
      { status: 200, body: SEARCH_BODY },
    ]);
    expect(await ok.c.search("Spirited Away")).toHaveLength(1);
    expect(ok.calls).toHaveLength(2);

    const bad = client([
      { status: 503, body: { message: "down" } },
      { status: 503, body: { message: "still down" } },
    ]);
    await expect(bad.c.search("x")).rejects.toMatchObject({ status: 503, message: "still down" });
    expect(bad.calls).toHaveLength(2);

    const noRetry = client([{ status: 400, body: { message: "bad" } }]);
    await expect(noRetry.c.search("x")).rejects.toBeInstanceOf(QlooError);
    expect(noRetry.calls).toHaveLength(1);
  });

  it("falls back to urn:entity:video_game on 403 for videogame insights", async () => {
    const { c, calls } = client([
      { status: 403, body: { error: { message: "You do not have permission to access urn:entity:videogame" } } },
      {
        status: 200,
        body: { results: { entities: [{ name: "Game", entity_id: "G1", subtype: "urn:entity:video_game" }] } },
      },
    ]);
    const res = await c.insights({ type: "videogame", entityIds: ["S1"] });
    expect(calls).toHaveLength(2);
    expect(calls[0].url.searchParams.get("filter.type")).toBe("urn:entity:videogame");
    expect(calls[1].url.searchParams.get("filter.type")).toBe("urn:entity:video_game");
    expect(res).toEqual([{ id: "G1", name: "Game", type: "videogame", tags: [] }]);
  });

  it("falls back to video_game on 403 for search types too, but not for other types", async () => {
    const s = client([
      { status: 403, body: { message: "forbidden" } },
      { status: 200, body: { results: [] } },
    ]);
    await s.c.search("Persona 5", ["videogame", "movie"]);
    expect(s.calls[1].url.searchParams.get("types")).toBe("urn:entity:video_game,urn:entity:movie");

    const m = client([{ status: 403, body: { message: "forbidden" } }]);
    await expect(m.c.insights({ type: "movie", entityIds: ["S1"] })).rejects.toMatchObject({ status: 403 });
    expect(m.calls).toHaveLength(1);
  });
});

describe("createQlooClient / qlooMode", () => {
  it("uses HTTP only when a non-empty key is present", () => {
    expect(qlooMode({})).toBe("mock");
    expect(qlooMode({ QLOO_API_KEY: "  " })).toBe("mock");
    expect(qlooMode({ QLOO_API_KEY: "k" })).toBe("live");
    expect(createQlooClient({ QLOO_BASE_URL: BASE })).toBeInstanceOf(MockQlooClient);
    expect(createQlooClient({ QLOO_BASE_URL: BASE, QLOO_API_KEY: "k" })).toBeInstanceOf(HttpQlooClient);
  });
});
