import type { Llm, LlmJsonOptions, LlmSource } from "./llm";
import { MOCK_ENTITIES } from "./mock-data";
import { normalizeTitle } from "./mock-qloo";
import { promptInput, promptKind, type LevelCandidate, type NormalizeItem, type PlanPromptInput } from "./prompts";
import { CEFR_LEVELS, ENTITY_TYPES, type Cefr } from "./types";

// Deterministic, rule-based answers for every prompt kind. Used when Workers AI is unavailable
// (local dev without a Cloudflare login, an outage, or an unusable answer) so the plan still completes.
// It never proposes titles: it only reshapes what the prompt already contains.

const ALIASES = new Map<string, { query: string; type: string }>();
for (const m of MOCK_ENTITIES) {
  for (const a of [m.name, ...(m.aliases ?? [])]) ALIASES.set(normalizeTitle(a), { query: m.name, type: m.type });
}

const BASE_LEVEL: Record<string, Cefr> = { book: "B2", podcast: "B2", tv_show: "B1", movie: "B1", videogame: "B1", artist: "B1" };
const EASIER = /\b(child|children|kids?|young|picture book|family|animated|animation|fairy|fable)\b/i;
const HARDER = /\b(history|philosoph\w*|science|economics|politic\w*|literary|classic|war)\b/i;

function shift(level: Cefr, by: number): Cefr {
  const i = Math.min(CEFR_LEVELS.length - 1, Math.max(0, CEFR_LEVELS.indexOf(level) + by));
  return CEFR_LEVELS[i];
}

export function estimateLevel(c: LevelCandidate): { cefr: Cefr; reason: string } {
  let level = BASE_LEVEL[c.type] ?? "B1";
  const text = `${c.title} ${c.description ?? ""}`;
  const why: string[] = [];
  if (EASIER.test(text)) {
    level = shift(level, -1);
    why.push("aimed at a younger or general audience");
  } else if (HARDER.test(text)) {
    level = shift(level, 1);
    why.push("topic uses specialised vocabulary");
  }
  if (c.pageCount !== undefined && c.type === "book") {
    if (c.pageCount < 200) {
      level = shift(level, -1);
      why.push(`short (${c.pageCount} pages)`);
    } else if (c.pageCount > 450) {
      level = shift(level, 1);
      why.push(`long (${c.pageCount} pages)`);
    }
  }
  if (c.type === "podcast" && why.length === 0) why.push("unscripted speech at natural speed");
  if ((c.type === "movie" || c.type === "tv_show") && why.length === 0) why.push("subtitles and visuals support the dialogue");
  return { cefr: level, reason: `Rule-based estimate: ${why.join(", ") || `typical for a ${c.type.replace("_", " ")}`}` };
}

const WORDS: Record<string, [string, string, string][]> = {
  read: [
    ["chapter", "章", "I read one chapter before bed."],
    ["character", "登場人物", "The main character is very brave."],
    ["plot", "筋書き", "The plot gets exciting in the middle."],
    ["setting", "舞台・設定", "The setting is a small town by the sea."],
    ["narrator", "語り手", "The narrator tells the story in the past tense."],
    ["describe", "描写する", "The writer describes the forest in detail."],
    ["suddenly", "突然", "Suddenly, the door opened."],
    ["whisper", "ささやく", "She whispered the answer to her friend."],
    ["realize", "気づく", "He realized he was lost."],
    ["journey", "旅", "Their journey takes many days."],
    ["memory", "記憶・思い出", "This song brings back a happy memory."],
    ["at first", "最初は", "At first, I didn't like the story."],
  ],
  listen: [
    ["episode", "（番組の）回", "This episode is about space."],
    ["host", "司会者", "The host asks good questions."],
    ["guest", "ゲスト", "Today's guest is a scientist."],
    ["topic", "話題", "The topic changes every week."],
    ["explain", "説明する", "She explains the idea slowly."],
    ["you know", "ほら・えーと（つなぎ言葉）", "It was, you know, really strange."],
    ["actually", "実は", "Actually, I have never been there."],
    ["figure out", "理解する・解き明かす", "They try to figure out what happened."],
    ["by the way", "ところで", "By the way, did you finish the book?"],
    ["interview", "インタビュー", "The interview lasts thirty minutes."],
    ["background", "背景", "First, let's hear some background."],
    ["I mean", "つまり", "It was hard. I mean, really hard."],
  ],
  watch: [
    ["scene", "場面", "This scene always makes me laugh."],
    ["subtitles", "字幕", "I watch with English subtitles."],
    ["season", "シーズン", "The second season is even better."],
    ["villain", "悪役", "The villain wants to rule the city."],
    ["hang on", "ちょっと待って", "Hang on, I'll be right back."],
    ["come on", "さあ・いいかげんにして", "Come on, we're going to be late!"],
    ["trust", "信頼する", "You can trust me."],
    ["deal", "取引・約束", "Okay, it's a deal."],
    ["get it", "わかる", "Oh, now I get it."],
    ["mess", "めちゃくちゃな状態", "The room is a complete mess."],
    ["no way", "まさか・絶対いや", "No way! That's amazing."],
    ["figure out", "解決する・わかる", "We need to figure this out together."],
  ],
};

function activity(p: PlanPromptInput["picks"][number], minutes: number, day: number): string {
  if (p.format === "read") {
    const pages = Math.max(2, Math.round(minutes / 3));
    return day === 1 ? `Read the first ${pages} pages of "${p.title}" without a dictionary` : `Read about ${pages} more pages of "${p.title}"`;
  }
  if (p.format === "listen") return minutes >= 30 ? `Listen to one episode of "${p.title}" and note 3 new words` : `Listen to the first ${minutes} minutes of an episode of "${p.title}"`;
  return minutes >= 30 ? `Watch one episode of "${p.title}" with English subtitles` : `Watch ${minutes} minutes of "${p.title}" with English subtitles`;
}

const PHRASE = /\b(?:more|less|fewer|no|without|avoid|not)\s+([a-z][a-z -]{1,30}?)(?=[,.;!]|\s+(?:and|but|please|after|before|since|from|than|newer|older)\b|$)/gi;

export class RuleBasedLlm implements Llm {
  readonly lastSource: LlmSource = "rule-based";

  async json<T>(opts: LlmJsonOptions): Promise<T> {
    const kind = promptKind(opts.system);
    switch (kind) {
      case "normalize": {
        const items = promptInput<NormalizeItem[]>(opts.user);
        return {
          items: items.map((i) => {
            const known = ALIASES.get(normalizeTitle(i.title));
            const type = i.type ?? known?.type ?? "book";
            return { index: i.index, query: known?.query ?? i.title, typeGuess: ENTITY_TYPES.includes(type as never) ? type : "book" };
          }),
        } as T;
      }
      case "refine": {
        const { text } = promptInput<{ text: string }>(opts.user);
        const addTags: string[] = [];
        const avoidTags: string[] = [];
        for (const m of text.matchAll(PHRASE)) {
          const phrase = m[1].trim().toLowerCase();
          (/^more$/i.test(m[0].split(/\s/)[0]) ? addTags : avoidTags).push(phrase);
        }
        const out: Record<string, unknown> = { addTags: addTags.slice(0, 3), avoidTags: avoidTags.slice(0, 3) };
        const after = /\b(?:after|since|newer than)\s+((?:18|19|20)\d\d)\b/i.exec(text);
        const before = /\b(?:before|older than)\s+((?:18|19|20)\d\d)\b/i.exec(text);
        if (after) out.minYear = Number(after[1]);
        if (before) out.maxYear = Number(before[1]);
        if (/\b(newer|recent|modern)\b/i.test(text) && !after) out.minYear = 2010;
        return out as T;
      }
      case "level": {
        const items = promptInput<LevelCandidate[]>(opts.user);
        return { items: items.map((c) => ({ id: c.id, ...estimateLevel(c) })) } as T;
      }
      case "plan": {
        const input = promptInput<PlanPromptInput>(opts.user);
        // Day 1 is the first (easiest) pick; then rotate so formats alternate where possible.
        const order = [input.picks[0], ...input.picks.slice(1).sort((a, b) => a.format.localeCompare(b.format))];
        const rotated: typeof order = [];
        const queues = new Map<string, typeof order>();
        for (const p of order.slice(1)) queues.set(p.format, [...(queues.get(p.format) ?? []), p]);
        rotated.push(order[0]);
        while ([...queues.values()].some((q) => q.length)) for (const q of queues.values()) if (q.length) rotated.push(q.shift()!);
        const days = Array.from({ length: 7 }, (_, i) => {
          const p = rotated[i % rotated.length];
          return { day: i + 1, pickId: p.id, activity: activity(p, input.minutesPerDay, i + 1), minutes: input.minutesPerDay };
        });
        const vocab = (WORDS[input.picks[0].format] ?? WORDS.read).map(([term, ja, example]) => ({ term, ja, example }));
        return { days, vocab } as T;
      }
      default:
        throw new Error(`RuleBasedLlm: unknown prompt kind ${kind ?? "(none)"}`);
    }
  }
}
