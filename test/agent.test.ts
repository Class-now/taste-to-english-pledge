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
    expect(llm.calls.map((c) => c.kind)).toEqual(["normalize", "refine", "level", "plan"]);
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
    expect(err.trace.at(-1)).toMatchObject({ id: "plan", detail: "Failed: model down" });
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
