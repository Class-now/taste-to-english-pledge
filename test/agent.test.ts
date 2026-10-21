import { describe, expect, it } from "vitest";
import { AgentError, runPlan } from "../src/agent";
import { MockQlooClient } from "../src/mock-qloo";
import type { InsightsParams } from "../src/qloo";
import { CEFR_LEVELS, type PlanInput } from "../src/types";
import { FakeLlm } from "./fake-llm";

const base: PlanInput = {
  favorites: [{ title: "千と千尋の神隠し" }, { title: "ペルソナ5" }, { title: "ノルウェイの森" }],
  level: "B1",
  minutesPerDay: 20,
  formats: ["read", "listen", "watch"],
};

class SpyQloo extends MockQlooClient {
  insightCalls: InsightsParams[] = [];
  override async insights(p: InsightsParams) {
    this.insightCalls.push(p);
    return super.insights(p);
  }
}

describe("runPlan", () => {
  it("runs the full pipeline with mock Qloo and a fake LLM", async () => {
    const qloo = new SpyQloo();
    const r = await runPlan(base, { qloo, llm: new FakeLlm(), mode: "mock" });

    expect(r.mode).toBe("mock");
    expect(r.trace.map((t) => t.id)).toEqual(["normalize", "resolve", "profile", "recommend", "level", "explain", "plan"]);
    for (const t of r.trace) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.detail.length).toBeGreaterThan(0);
      expect(t.ms).toBeGreaterThanOrEqual(0);
    }
    expect(r.trace[1].detail).toContain("Spirited Away");
    expect(r.warnings).toEqual([]);

    expect(r.profile.length).toBeGreaterThan(0);
    expect(r.profile.length).toBeLessThanOrEqual(8);

    expect(r.picks.length).toBeGreaterThanOrEqual(6);
    expect(r.picks.length).toBeLessThanOrEqual(9);
    const seedIds = ["mock-movie-spirited-away", "mock-game-persona-5", "mock-book-norwegian-wood"];
    for (const p of r.picks) {
      expect(seedIds).not.toContain(p.id);
      expect(p.because).toMatch(/\S/);
      expect(["B1", "B2", "A2"]).toContain(p.cefr);
      expect(p.language === undefined || p.language === "en").toBe(true);
    }
    for (const f of ["read", "listen", "watch"]) expect(r.picks.filter((p) => p.format === f).length).toBeGreaterThanOrEqual(2);
    const idx = r.picks.map((p) => CEFR_LEVELS.indexOf(p.cefr));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));

    expect(r.plan.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const pickIds = new Set(r.picks.map((p) => p.id));
    for (const d of r.plan) {
      expect(pickIds.has(d.pickId)).toBe(true);
      expect(d.minutes).toBe(20);
    }
    expect(r.vocab).toHaveLength(12);

    // insights called per media type, seeds excluded, explainability on.
    expect(qloo.insightCalls.map((c) => c.type).sort()).toEqual(["book", "movie", "podcast", "tv_show"]);
    for (const c of qloo.insightCalls) {
      expect(c.excludeIds).toEqual(seedIds);
      expect(c.explain).toBe(true);
      expect(c.take).toBe(15);
    }
  });

  it("only queries the selected formats", async () => {
    const qloo = new SpyQloo();
    const r = await runPlan({ ...base, formats: ["listen"] }, { qloo, llm: new FakeLlm(), mode: "mock" });
    expect(qloo.insightCalls.map((c) => c.type)).toEqual(["podcast"]);
    expect(r.picks.every((p) => p.format === "listen")).toBe(true);
  });

  it("applies the refine text as Qloo tag signals and avoid filters", async () => {
    const qloo = new SpyQloo();
    const llm = new FakeLlm();
    const r = await runPlan({ ...base, refine: "more mystery, less romance" }, { qloo, llm, mode: "mock" });

    expect(r.trace.map((t) => t.id)).toEqual(["normalize", "resolve", "profile", "refine", "recommend", "level", "explain", "plan"]);
    expect(r.trace[3].detail).toContain("mystery");
    expect(r.trace[3].detail).toContain("romance");
    for (const c of qloo.insightCalls) expect(c.tagIds).toEqual(["urn:tag:keyword:media:mystery"]);
    for (const p of r.picks) expect(p.tags.some((t) => t.name.toLowerCase().includes("romance"))).toBe(false);
    // Level runs in batches of 20 candidates.
    expect([...new Set(llm.calls.map((c) => c.kind))]).toEqual(["normalize", "refine", "level", "plan"]);
  });

  it("passes refine year filters to insights", async () => {
    const qloo = new SpyQloo();
    const llm = new FakeLlm({ refine: () => ({ addTags: [], avoidTags: [], minYear: 2000 }) });
    await runPlan({ ...base, refine: "newer stuff" }, { qloo, llm, mode: "mock" });
    for (const c of qloo.insightCalls) {
      expect(c.minYear).toBe(2000);
      expect(c.tagIds).toEqual([]);
    }
  });

  it("raises AgentError at resolve when nothing is found", async () => {
    const input: PlanInput = { ...base, favorites: [{ title: "zzqx unknown work" }] };
    const err = await runPlan(input, { qloo: new MockQlooClient(), llm: new FakeLlm(), mode: "mock" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.step).toBe("resolve");
    expect(err.message).toMatch(/couldn't find any of these titles/);
    expect(err.trace.map((t: { id: string }) => t.id)).toEqual(["normalize", "resolve"]);
  });

  it("warns about unresolved favourites and keeps going", async () => {
    const input: PlanInput = { ...base, favorites: [{ title: "Spirited Away" }, { title: "zzqx unknown work" }] };
    const r = await runPlan(input, { qloo: new MockQlooClient(), llm: new FakeLlm(), mode: "mock" });
    expect(r.warnings).toContain('Couldn\'t find "zzqx unknown work"');
    expect(r.picks.length).toBeGreaterThan(0);
  });

  it("falls back to an untyped search when the type guess is wrong", async () => {
    const llm = new FakeLlm({ normalize: () => ({ items: [{ query: "Persona 5", typeGuess: "book" }] }) });
    const r = await runPlan({ ...base, favorites: [{ title: "Persona 5" }] }, { qloo: new MockQlooClient(), llm, mode: "mock" });
    expect(r.trace[1].detail).toContain("Persona 5 (videogame");
  });

  it("prefers an exact name match over the top hit for a guessed type", async () => {
    const qloo = new (class extends MockQlooClient {
      override async search(q: string, types?: Parameters<MockQlooClient["search"]>[1], take?: number) {
        if (types?.length) return [{ id: "wrong", name: "Some Other Show", type: types[0], tags: [] }];
        return super.search(q, types, take);
      }
    })();
    const llm = new FakeLlm({ normalize: () => ({ items: [{ index: 0, query: "Spirited Away", typeGuess: "tv_show" }] }) });
    const r = await runPlan({ ...base, favorites: [{ title: "千と千尋の神隠し" }] }, { qloo, llm, mode: "mock" });
    expect(r.trace[1].detail).toContain("Spirited Away (movie");
  });

  it("keeps English books whose language has a region suffix", async () => {
    const qloo = new (class extends MockQlooClient {
      override async insights(p: InsightsParams) {
        return (await super.insights(p)).map((e) => (e.language === "en" ? { ...e, language: "en-US" } : e));
      }
    })();
    const r = await runPlan({ ...base, formats: ["read"] }, { qloo, llm: new FakeLlm(), mode: "mock" });
    expect(r.picks.length).toBeGreaterThan(0);
  });

  it("keeps the ratings from level batches that succeeded", async () => {
    let n = 0;
    const llm = new FakeLlm({
      level: (opts) => {
        if (n++ === 0) throw new Error("cut off");
        const items = JSON.parse(opts.user.slice(opts.user.indexOf("INPUT:") + 6)) as { id: string }[];
        return { items: items.map((c) => ({ id: c.id, cefr: "B1", reason: "fake" })) };
      },
    });
    const r = await runPlan(base, { qloo: new MockQlooClient(), llm, mode: "mock" });
    expect(r.picks.length).toBeGreaterThan(0);
  });

  it("ignores refine tags that are not media tags", async () => {
    const qloo = new (class extends SpyQloo {
      override async searchTags() {
        return [{ id: "urn:tag:category:place:mystery_spot", name: "Mystery Spot", subtype: "urn:tag:category:place" }];
      }
    })();
    const llm = new FakeLlm({ refine: () => ({ addTags: ["mystery"], avoidTags: [] }) });
    await runPlan({ ...base, refine: "more mystery" }, { qloo, llm, mode: "mock" });
    for (const c of qloo.insightCalls) expect(c.tagIds).toEqual([]);
  });

  it("respects a user-given type over the LLM guess", async () => {
    const llm = new FakeLlm({ normalize: () => ({ items: [{ query: "Howl's Moving Castle", typeGuess: "movie" }] }) });
    const r = await runPlan(
      { ...base, favorites: [{ title: "Howl's Moving Castle", type: "book" }] },
      { qloo: new MockQlooClient(), llm, mode: "mock" },
    );
    expect(r.trace[1].detail).toContain("(book");
  });

  it("wraps LLM failures in AgentError with the failing step and trace", async () => {
    const llm = new FakeLlm({
      plan: () => {
        throw new Error("model down");
      },
    });
    const err = await runPlan(base, { qloo: new MockQlooClient(), llm, mode: "mock" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.step).toBe("plan");
    expect(err.message).toBe("The AI couldn't write your plan. Please try again.");
    expect(err.trace.at(-1)).toMatchObject({ id: "plan", detail: `Failed: ${err.message}` });
    expect(JSON.stringify(err.trace)).not.toContain("model down");
  });

  it("keeps raw Qloo errors out of the user-facing message and trace", async () => {
    const qloo = new (class extends MockQlooClient {
      override async entityTags(): Promise<never> {
        throw new Error("Qloo 403: key quota exceeded for account 42");
      }
    })();
    const err = await runPlan(base, { qloo, llm: new FakeLlm(), mode: "mock" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.step).toBe("profile");
    expect(err.message).toBe("Qloo couldn't build your taste profile. Please try again.");
    expect(JSON.stringify(err.trace)).not.toContain("quota");
  });

  it("matches normalize rows by index, not position", async () => {
    const llm = new FakeLlm({
      normalize: () => ({
        items: [
          { index: 2, query: "Norwegian Wood", typeGuess: "book" },
          { index: 0, query: "Spirited Away", typeGuess: "movie" },
        ],
      }),
    });
    const r = await runPlan(base, { qloo: new MockQlooClient(), llm, mode: "mock" });
    expect(r.trace[0].detail).toContain('"千と千尋の神隠し" → "Spirited Away" (movie)');
    expect(r.trace[0].detail).toContain('"ノルウェイの森" → "Norwegian Wood" (book)');
    // The skipped favourite falls back to its own title with no type guess.
    expect(r.trace[0].detail).toContain('"ペルソナ5" → "ペルソナ5";');
  });

  it("re-asks the level step for candidates the model skipped", async () => {
    const asked = new Map<string, number>();
    const llm = new FakeLlm({
      level: (opts) => {
        const items = JSON.parse(opts.user.slice(opts.user.indexOf("INPUT:") + 6)) as { id: string; type: string }[];
        for (const c of items) asked.set(c.id, (asked.get(c.id) ?? 0) + 1);
        // The first answer per batch rates only one candidate; the follow-up rates the rest.
        const rows = items.map((c) => ({ id: c.id, cefr: "B1", reason: "fake" }));
        return { items: items.every((c) => asked.get(c.id) === 1) ? rows.slice(0, 1) : rows };
      },
    });
    const r = await runPlan(base, { qloo: new MockQlooClient(), llm, mode: "mock" });
    expect([...asked.values()].some((n) => n === 2)).toBe(true);
    expect(r.picks.length).toBeGreaterThanOrEqual(6);
    expect(r.warnings).toEqual([]);
  });

  it("warns when fewer than six picks fit the level", async () => {
    let rated = 0;
    const llm = new FakeLlm({
      level: (opts) => {
        const items = JSON.parse(opts.user.slice(opts.user.indexOf("INPUT:") + 6)) as { id: string }[];
        return { items: items.map((c) => ({ id: c.id, cefr: rated++ < 3 ? "B1" : "C2", reason: "fake" })) };
      },
    });
    const r = await runPlan(base, { qloo: new MockQlooClient(), llm, mode: "mock" });
    expect(r.picks).toHaveLength(3);
    expect(r.warnings).toContain("Only 3 works matched your level closely");
  });

  it("fails the level step when nothing fits the learner's level", async () => {
    const llm = new FakeLlm({
      level: (opts) => {
        const items = JSON.parse(opts.user.slice(opts.user.indexOf("INPUT:") + 6)) as { id: string }[];
        return { items: items.map((c) => ({ id: c.id, cefr: "C2", reason: "fake" })) };
      },
    });
    const err = await runPlan(base, { qloo: new MockQlooClient(), llm, mode: "mock" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.step).toBe("level");
    expect(err.message).toMatch(/None of the matches fit your English level/);
  });

  it("drops non-English candidates and keeps ones with no language", async () => {
    const entity = (id: string, language?: string) => ({ id, name: id, type: "podcast" as const, tags: [], affinity: 0.9, language });
    const qloo = new (class extends MockQlooClient {
      override async insights() {
        return [entity("ja-show", "ja"), entity("en-show", "en"), entity("unknown-show")];
      }
    })();
    const llm = new FakeLlm();
    const r = await runPlan({ ...base, formats: ["listen"] }, { qloo, llm, mode: "mock" });
    const levelCall = llm.calls.find((c) => c.kind === "level")!;
    expect(levelCall.opts.user).not.toContain("ja-show");
    expect(r.trace.find((t) => t.id === "recommend")!.detail).toBe("Found 2 podcasts");
  });

  it("keeps going when one media type fails and fails when all do", async () => {
    class Flaky extends MockQlooClient {
      constructor(private readonly failing: (type: string) => boolean) {
        super();
      }
      override async insights(p: InsightsParams) {
        if (this.failing(p.type)) throw new Error("Qloo 500");
        return super.insights(p);
      }
    }
    const r = await runPlan(base, { qloo: new Flaky((t) => t === "podcast"), llm: new FakeLlm(), mode: "mock" });
    expect(r.warnings).toContain("Qloo couldn't search podcasts this time");
    expect(r.picks.some((p) => p.format === "listen")).toBe(false);

    const err = await runPlan(base, { qloo: new Flaky(() => true), llm: new FakeLlm(), mode: "mock" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.step).toBe("recommend");
    expect(err.message).toBe("Qloo couldn't find recommendations. Please try again.");
  });

  it("matches avoid phrases as whole words", async () => {
    const tag = (name: string) => ({ id: `t-${name}`, name });
    const qloo = new (class extends MockQlooClient {
      override async insights() {
        return [
          { id: "war-show", name: "war-show", type: "podcast" as const, affinity: 0.9, tags: [tag("War")] },
          { id: "software-show", name: "software-show", type: "podcast" as const, affinity: 0.8, tags: [tag("Software")] },
        ];
      }
    })();
    const llm = new FakeLlm({
      refine: () => ({ addTags: [], avoidTags: ["war"] }),
      level: (opts) => {
        const items = JSON.parse(opts.user.slice(opts.user.indexOf("INPUT:") + 6)) as { id: string }[];
        return { items: items.map((c) => ({ id: c.id, cefr: "B1", reason: "fake" })) };
      },
    });
    const r = await runPlan({ ...base, formats: ["listen"], refine: "no war" }, { qloo, llm, mode: "mock" });
    expect(r.trace.find((t) => t.id === "recommend")!.detail).toBe("Found 1 podcast");
    expect(r.picks.map((p) => p.id)).toEqual(["software-show"]);
  });

  it("forces day 1 to the easiest pick and warns about short vocabulary", async () => {
    const llm = new FakeLlm({
      plan: (opts) => {
        const input = JSON.parse(opts.user.slice(opts.user.indexOf("INPUT:") + 6)) as { picks: { id: string }[] };
        return {
          days: [{ day: 1, pickId: input.picks[1].id, activity: "Start with the second pick", minutes: 20 }],
          vocab: [],
        };
      },
    });
    const r = await runPlan(base, { qloo: new MockQlooClient(), llm, mode: "mock" });
    expect(r.plan[0].pickId).toBe(r.picks[0].id);
    expect(r.plan[0].activity).not.toBe("Start with the second pick");
    expect(r.warnings).toContain("Only 0 starter words could be written this time");
  });

  it("drops invalid plan days and fills them in", async () => {
    const llm = new FakeLlm({
      plan: () => ({
        days: [
          { day: 1, pickId: "not-a-pick", activity: "x", minutes: 20 },
          { day: 9, pickId: "mock-podcast-the-moth", activity: "x", minutes: 20 },
        ],
        vocab: [{ term: "spirit", ja: "精霊", example: "A spirit appears." }],
      }),
    });
    const r = await runPlan(base, { qloo: new MockQlooClient(), llm, mode: "mock" });
    const pickIds = new Set(r.picks.map((p) => p.id));
    expect(r.plan.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(r.plan.every((d) => pickIds.has(d.pickId))).toBe(true);
    expect(r.plan[0].pickId).toBe(r.picks[0].id);
    expect(r.vocab).toHaveLength(1);
  });
});
