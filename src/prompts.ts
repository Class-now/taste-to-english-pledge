import { CEFR_LEVELS, ENTITY_TYPES } from "./types";
import type { LlmJsonOptions } from "./llm";

export type LlmPromptKind = "normalize" | "refine" | "level" | "plan";

/** Marker that precedes the JSON payload in every user prompt. */
export const INPUT_MARKER = "INPUT:";

const RULES = [
  "Write all output in English, except fields explicitly marked as Japanese.",
  "Never state facts about a title beyond the description you are given; if unsure, stay general.",
  "Reply with JSON only, matching the requested schema.",
].join("\n");

function system(kind: LlmPromptKind, body: string): string {
  return `[kind:${kind}]\n${body}\n\nRules:\n${RULES}`;
}

function user(intro: string, payload: unknown): string {
  return `${intro}\n\n${INPUT_MARKER}\n${JSON.stringify(payload)}`;
}

/** Read the `[kind:...]` tag back out of a system prompt (used by test fakes and logging). */
export function promptKind(systemPrompt: string): LlmPromptKind | undefined {
  return /^\[kind:(\w+)\]/.exec(systemPrompt)?.[1] as LlmPromptKind | undefined;
}

/** Parse the JSON payload back out of a user prompt. */
export function promptInput<T>(userPrompt: string): T {
  return JSON.parse(userPrompt.slice(userPrompt.indexOf(INPUT_MARKER) + INPUT_MARKER.length)) as T;
}

export interface NormalizeItem {
  index: number;
  title: string;
  type?: string;
}

export function normalizePrompt(items: NormalizeItem[]): LlmJsonOptions {
  return {
    system: system(
      "normalize",
      [
        "You turn a learner's favourite works (any language, often Japanese) into search queries for a media database.",
        "For each item return the official English title (or the original title if it has no English one) as `query`,",
        `and the most likely media type as \`typeGuess\`, one of: ${ENTITY_TYPES.join(", ")}.`,
        "Anime series are tv_show; anime films are movie; video games are videogame; novels and manga are book.",
        "If an item already has a `type`, use exactly that type.",
        "Return one result per input item, in the same order.",
      ].join("\n"),
    ),
    user: user("Favourite works:", items),
    schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              query: { type: "string" },
              typeGuess: { type: "string", enum: [...ENTITY_TYPES] },
            },
            required: ["query", "typeGuess"],
          },
        },
      },
      required: ["items"],
    },
    maxTokens: 512,
  };
}

export function refinePrompt(text: string): LlmJsonOptions {
  return {
    system: system(
      "refine",
      [
        "A learner wants to adjust their recommendations. Map their request to taste signals.",
        "`addTags`: up to 3 short English genre/theme phrases they want more of (e.g. \"mystery\").",
        "`avoidTags`: up to 3 short English genre/theme phrases they want less of (e.g. \"fantasy\").",
        "`minYear` / `maxYear`: only if they clearly ask for newer or older works; otherwise omit.",
      ].join("\n"),
    ),
    user: user("Request:", { text }),
    schema: {
      type: "object",
      properties: {
        addTags: { type: "array", items: { type: "string" } },
        avoidTags: { type: "array", items: { type: "string" } },
        minYear: { type: "integer" },
        maxYear: { type: "integer" },
      },
      required: ["addTags", "avoidTags"],
    },
    maxTokens: 256,
  };
}

export interface LevelCandidate {
  id: string;
  title: string;
  type: string;
  year?: number;
  description?: string;
  pageCount?: number;
}

export function levelPrompt(learnerLevel: string, candidates: LevelCandidate[]): LlmJsonOptions {
  return {
    system: system(
      "level",
      [
        "You estimate how hard the English in each work is for a learner, on the CEFR scale (A2, B1, B2, C1, C2).",
        "Consider vocabulary, sentence length, speech speed and target audience (children's/young-adult works are easier).",
        "These are honest estimates, not certainties. Give a one-line `reason` (max 120 characters) per work.",
        "Return one item per candidate, using the candidate's `id`.",
      ].join("\n"),
    ),
    user: user(`Learner level: ${learnerLevel}. Candidates:`, candidates),
    schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              cefr: { type: "string", enum: [...CEFR_LEVELS] },
              reason: { type: "string" },
            },
            required: ["id", "cefr", "reason"],
          },
        },
      },
      required: ["items"],
    },
    maxTokens: 3000,
  };
}

export interface PlanPromptInput {
  learnerLevel: string;
  minutesPerDay: number;
  picks: { id: string; title: string; type: string; format: string; cefr: string; pageCount?: number; description?: string }[];
}

export function planPrompt(input: PlanPromptInput): LlmJsonOptions {
  return {
    system: system(
      "plan",
      [
        "You write a 7-day English extensive reading/listening plan for a Japanese learner.",
        "`days`: exactly 7 items with `day` 1..7, a `pickId` from the picks, a concrete `activity` sized to the minutes per day",
        "(e.g. \"Read the first 10 pages\", \"Listen to one episode\", \"Watch one episode with English subtitles\"), and `minutes`.",
        "Start day 1 with the first pick (it is the easiest), and alternate formats across days.",
        "`vocab`: exactly 12 words or phrases likely to appear in the day-1 pick, each with `ja` (a short Japanese gloss, in Japanese)",
        "and a short, simple English `example` sentence. Do not quote the work itself.",
      ].join("\n"),
    ),
    user: user("Plan input:", input),
    schema: {
      type: "object",
      properties: {
        days: {
          type: "array",
          items: {
            type: "object",
            properties: {
              day: { type: "integer" },
              pickId: { type: "string" },
              activity: { type: "string" },
              minutes: { type: "integer" },
            },
            required: ["day", "pickId", "activity", "minutes"],
          },
        },
        vocab: {
          type: "array",
          items: {
            type: "object",
            properties: {
              term: { type: "string" },
              ja: { type: "string" },
              example: { type: "string" },
            },
            required: ["term", "ja", "example"],
          },
        },
      },
      required: ["days", "vocab"],
    },
    maxTokens: 2000,
  };
}
