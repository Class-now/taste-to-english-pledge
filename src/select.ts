import { CEFR_LEVELS, type Cefr, type EntityType, type Fit, type Format, type LearnerLevel, type Pick, type QlooEntity } from "./types";

export const FORMAT_TYPES: Record<Format, EntityType[]> = {
  read: ["book"],
  listen: ["podcast"],
  watch: ["tv_show", "movie"],
};

export function formatOf(type: EntityType): Format | undefined {
  return (Object.keys(FORMAT_TYPES) as Format[]).find((f) => FORMAT_TYPES[f].includes(type));
}

export interface LevelEstimate {
  id: string;
  cefr: Cefr;
  reason: string;
}

export const MIN_PICKS = 6;
export const MAX_PICKS = 9;
export const MIN_PER_FORMAT = 2;

const FIT_PRIORITY: Record<Fit, number> = { match: 0, stretch: 1, easier: 2 };

const cefrIndex = (c: Cefr) => CEFR_LEVELS.indexOf(c);
const byPriority = (a: Pick, b: Pick) =>
  FIT_PRIORITY[a.fit] - FIT_PRIORITY[b.fit] || (b.affinity ?? 0) - (a.affinity ?? 0) || a.id.localeCompare(b.id);

/**
 * Choose 6–9 picks within one CEFR level of the learner: matches first, then stretches, then easier ones,
 * at least 2 per selected format when available. Returned easiest first, then by affinity. `because` is left empty.
 */
export function selectPicks(
  candidates: QlooEntity[],
  levels: LevelEstimate[],
  learnerLevel: LearnerLevel,
  formats: Format[],
): Pick[] {
  const levelById = new Map(levels.map((l) => [l.id, l]));
  const learner = cefrIndex(learnerLevel);
  const seen = new Set<string>();
  const pool: Pick[] = [];

  for (const c of candidates) {
    const level = levelById.get(c.id);
    const format = formatOf(c.type);
    if (!level || !format || !formats.includes(format) || seen.has(c.id)) continue;
    const diff = cefrIndex(level.cefr) - learner;
    if (Math.abs(diff) > 1) continue;
    seen.add(c.id);
    pool.push({
      ...c,
      cefr: level.cefr,
      levelReason: level.reason,
      fit: diff === 0 ? "match" : diff > 0 ? "stretch" : "easier",
      because: "",
      format,
    });
  }

  const byFormat = new Map(formats.map((f) => [f, pool.filter((p) => p.format === f).sort(byPriority)]));
  const chosen: Pick[] = [];
  // Round-robin across formats until each has its minimum (or runs out).
  for (let round = 0; round < MIN_PER_FORMAT; round++) {
    for (const f of formats) {
      const next = byFormat.get(f)?.shift();
      if (next && chosen.length < MAX_PICKS) chosen.push(next);
    }
  }
  // Fill the rest by overall priority.
  const rest = [...byFormat.values()].flat().sort(byPriority);
  for (const p of rest) {
    if (chosen.length >= MAX_PICKS) break;
    chosen.push(p);
  }

  return chosen.sort(
    (a, b) => cefrIndex(a.cefr) - cefrIndex(b.cefr) || (b.affinity ?? 0) - (a.affinity ?? 0) || a.id.localeCompare(b.id),
  );
}
