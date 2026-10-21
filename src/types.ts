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

export interface TraceStep {
  id: string;
  label: string;
  detail: string;
  ms: number;
}

export type Fit = "match" | "easier" | "stretch";

export interface Pick extends QlooEntity {
  cefr: Cefr;
  levelReason: string;
  fit: Fit;
  because: string;
  format: Format;
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
  profile: QlooTag[];
  picks: Pick[];
  plan: Day[];
  vocab: Vocab[];
  trace: TraceStep[];
  warnings: string[];
}
