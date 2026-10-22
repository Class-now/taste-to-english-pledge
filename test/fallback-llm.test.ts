import { describe, expect, it } from "vitest";
import { RuleBasedLlm, estimateLevel, parseRefine } from "../src/fallback-llm";
import { ResilientLlm, type Llm } from "../src/llm";
import { levelPrompt, normalizePrompt, planPrompt, refinePrompt } from "../src/prompts";

const rules = new RuleBasedLlm();

describe("RuleBasedLlm", () => {
  it("maps known Japanese titles and keeps unknown ones as typed", async () => {
    const out = await rules.json<{ items: { index: number; query: string; typeGuess: string }[] }>(
      normalizePrompt([{ index: 0, title: "千と千尋の神隠し" }, { index: 1, title: "Some Unknown Novel", type: "book" }]),
    );
    expect(out.items).toEqual([
      { index: 0, query: "Spirited Away", typeGuess: "movie" },
      { index: 1, query: "Some Unknown Novel", typeGuess: "book" },
    ]);
  });

  it("reads more/less phrases and years from a refine request", async () => {
    expect(await rules.json(refinePrompt("less fantasy, more mystery after 2010"))).toEqual({
      addTags: ["mystery"],
      avoidTags: ["fantasy"],
      minYear: 2010,
    });
  });

  it("estimates levels from type, audience and length", () => {
    expect(estimateLevel({ id: "a", title: "X", type: "book", description: "A picture book for children", pageCount: 40 }).cefr).toBe("A2");
    expect(estimateLevel({ id: "b", title: "Y", type: "book", pageCount: 600 }).cefr).toBe("C1");
    expect(estimateLevel({ id: "c", title: "Z", type: "podcast", description: "World history in depth" }).cefr).toBe("C1");
    expect(estimateLevel({ id: "d", title: "W", type: "movie" }).reason).toMatch(/^Rule-based estimate/);
  });

  it("rates every candidate and writes 7 days starting with the first pick plus 12 words", async () => {
    const lv = await rules.json<{ items: { id: string }[] }>(levelPrompt("B1", [{ id: "1", title: "a", type: "book" }, { id: "2", title: "b", type: "podcast" }]));
    expect(lv.items.map((i) => i.id)).toEqual(["1", "2"]);
    const picks = [
      { id: "p1", title: "One", type: "podcast", format: "listen", cefr: "B1" },
      { id: "b1", title: "Two", type: "book", format: "read", cefr: "B1" },
      { id: "t1", title: "Three", type: "tv_show", format: "watch", cefr: "B2" },
    ];
    const plan = await rules.json<{ days: { day: number; pickId: string; activity: string }[]; vocab: unknown[] }>(
      planPrompt({ learnerLevel: "B1", minutesPerDay: 20, picks }),
    );
    expect(plan.days.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(plan.days[0].pickId).toBe("p1");
    expect(new Set(plan.days.slice(0, 3).map((d) => d.pickId)).size).toBe(3);
    expect(plan.vocab).toHaveLength(12);
  });
});

describe("ResilientLlm", () => {
  it("uses the primary when it works and the fallback when it throws, then stops waiting on a broken primary", async () => {
    let calls = 0;
    let broken = false;
    const primary: Llm & { lastSource: "workers-ai" } = {
      lastSource: "workers-ai",
      async json<T>() {
        calls++;
        if (broken) throw new Error("down");
        return { items: [] } as T;
      },
    };
    const llm = new ResilientLlm(primary, rules);
    await llm.json(refinePrompt("more mystery"));
    expect(llm.lastSource).toBe("workers-ai");
    broken = true;
    expect(await llm.json(refinePrompt("more mystery"))).toEqual({ addTags: ["mystery"], avoidTags: [] });
    expect(llm.lastSource).toBe("rule-based");
    await llm.json(refinePrompt("more mystery"));
    await llm.json(refinePrompt("more mystery"));
    expect(calls).toBe(3);
  });
});

describe("parseRefine", () => {
  it.each([
    ["less fantasy, more mystery", ["mystery"], ["fantasy"]],
    ["more mystery?", ["mystery"], []],
    ["nothing scary, more comedy", ["comedy"], ["scary"]],
    ["I don't want horror", [], ["horror"]],
    ["more mystery and horror", ["mystery", "horror"], []],
    ["not in English", [], []],
    ["more science fiction after 2010, please", ["science fiction"], []],
    ["shorter books", [], []],
  ])("%s", (text, add, avoid) => {
    expect(parseRefine(text)).toEqual({ addTags: add, avoidTags: avoid });
  });
});
