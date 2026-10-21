import type { Llm, LlmJsonOptions } from "../src/llm";
import { promptInput, promptKind, type LevelCandidate, type NormalizeItem, type PlanPromptInput } from "../src/prompts";

const ENGLISH_TITLES: Record<string, { query: string; typeGuess: string }> = {
  千と千尋の神隠し: { query: "Spirited Away", typeGuess: "movie" },
  ペルソナ5: { query: "Persona 5", typeGuess: "videogame" },
  ノルウェイの森: { query: "Norwegian Wood", typeGuess: "book" },
};

const LEVEL_BY_TYPE: Record<string, string> = { book: "B2", podcast: "B1", tv_show: "B1", movie: "A2" };

/** Deterministic stand-in for the LLM: answers each prompt kind from the prompt's own JSON payload. */
export class FakeLlm implements Llm {
  calls: { kind: string; opts: LlmJsonOptions }[] = [];

  constructor(private readonly overrides: Partial<Record<string, (opts: LlmJsonOptions) => unknown>> = {}) {}

  async json<T>(opts: LlmJsonOptions): Promise<T> {
    const kind = promptKind(opts.system) ?? "unknown";
    this.calls.push({ kind, opts });
    const override = this.overrides[kind];
    if (override) return override(opts) as T;
    switch (kind) {
      case "normalize": {
        const items = promptInput<NormalizeItem[]>(opts.user);
        return { items: items.map((i) => ENGLISH_TITLES[i.title] ?? { query: i.title, typeGuess: i.type ?? "book" }) } as T;
      }
      case "refine":
        return { addTags: ["mystery"], avoidTags: ["romance"] } as T;
      case "level": {
        const items = promptInput<LevelCandidate[]>(opts.user);
        // One C2 work per run to exercise the level filter.
        return {
          items: items.map((c, i) => ({ id: c.id, cefr: i === 0 ? "C2" : (LEVEL_BY_TYPE[c.type] ?? "B1"), reason: `Fake estimate for ${c.title}` })),
        } as T;
      }
      case "plan": {
        const input = promptInput<PlanPromptInput>(opts.user);
        return {
          days: Array.from({ length: 7 }, (_, i) => ({
            day: i + 1,
            pickId: input.picks[i % input.picks.length].id,
            activity: `Day ${i + 1} activity`,
            minutes: input.minutesPerDay,
          })),
          vocab: Array.from({ length: 12 }, (_, i) => ({ term: `word${i}`, ja: `単語${i}`, example: `Example ${i}.` })),
        } as T;
      }
      default:
        throw new Error(`FakeLlm: unknown prompt kind ${kind}`);
    }
  }
}
