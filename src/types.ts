export const ENTITY_TYPES = ["book", "movie", "tv_show", "podcast", "videogame", "artist"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const CEFR_LEVELS = ["A2", "B1", "B2", "C1", "C2"] as const;
export type Cefr = (typeof CEFR_LEVELS)[number];

export const LEARNER_LEVELS = ["A2", "B1", "B2", "C1"] as const;
export type LearnerLevel = (typeof LEARNER_LEVELS)[number];

export const FORMATS = ["read", "listen", "watch"] as const;
export type Format = (typeof FORMATS)[number];

export const MINUTES_PER_DAY = [10, 20, 30, 45] as const;
export type MinutesPerDay = (typeof MINUTES_PER_DAY)[number];

export interface Favorite {
  title: string;
  type?: EntityType;
}

export interface PlanInput {
  favorites: Favorite[];
  level: LearnerLevel;
  minutesPerDay: MinutesPerDay;
  formats: Format[];
  refine?: string;
  /** Force the hand-written sample data even when a Qloo key is configured (demo button). */
  demo?: boolean;
}

export interface QlooTag {
  id: string;
  name: string;
  subtype?: string;
  affinity?: number;
}

export interface QlooEntity {
  id: string;
  name: string;
  type: EntityType;
  year?: number;
  description?: string;
  imageUrl?: string;
  popularity?: number;
  affinity?: number;
  tags: QlooTag[];
  disambiguation?: string;
  language?: string;
  pageCount?: number;
  explainability?: Record<string, unknown>;
}

/** Where a tool call was answered from. */
export type CallSource = "qloo" | "sample" | "workers-ai" | "rule-based";

/** One tool call the agent made inside a step (shown in the trace). Never contains the API key. */
export interface ToolCall {
  tool: "qloo.search" | "qloo.insights" | "qloo.tags" | "qloo.tag_search" | "llm";
  /** e.g. "GET /v2/insights" or "Workers AI · level". */
  endpoint: string;
  /** Human-readable arguments, e.g. "filter.type=urn:entity:book · 3 seeds · take 15". */
  summary: string;
  /** Number of results (entities, tags or rated items); undefined for failed calls. */
  results?: number;
  ms: number;
  cached: boolean;
  ok: boolean;
  source: CallSource;
}

export interface TraceStep {
  id: string;
  label: string;
  detail: string;
  ms: number;
  status?: "ok" | "failed" | "fallback";
  calls?: ToolCall[];
}

/** A favourite as Qloo resolved it. */
export interface Seed {
  id: string;
  name: string;
  type: EntityType;
  year?: number;
  imageUrl?: string;
  /** What the learner typed. */
  input: string;
}

/** Qloo evidence behind a pick, for the "Why this pick" panel. Derived from Qloo data only. */
export interface PickEvidence {
  /** Seeds named in Qloo explainability, strongest first; score 0–1 when Qloo gave one. */
  contributions: { seedId: string; name: string; score?: number }[];
  /** Tag names the pick shares with the favourites or the taste profile. */
  sharedTags: string[];
}

export type Fit = "match" | "easier" | "stretch";

export interface Pick extends QlooEntity {
  cefr: Cefr;
  levelReason: string;
  fit: Fit;
  because: string;
  format: Format;
  evidence?: PickEvidence;
}

export interface Day {
  day: number;
  pickId: string;
  activity: string;
  minutes: number;
}

export interface Vocab {
  term: string;
  ja: string;
  example: string;
}

export interface PlanResult {
  mode: "live" | "mock";
  seeds: Seed[];
  profile: QlooTag[];
  picks: Pick[];
  plan: Day[];
  vocab: Vocab[];
  trace: TraceStep[];
  warnings: string[];
}

/** Events streamed by `POST /api/plan` when the client sends `Accept: application/x-ndjson` (one JSON object per line). */
export type AgentEvent =
  | { type: "start"; mode: "live" | "mock"; steps: { id: string; label: string }[] }
  | { type: "step-start"; id: string; label: string }
  | { type: "call"; step: string; call: ToolCall }
  | { type: "step"; step: TraceStep }
  | { type: "result"; result: PlanResult }
  | { type: "error"; error: string; step?: string; trace: TraceStep[] };
