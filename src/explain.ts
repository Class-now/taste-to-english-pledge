import type { QlooEntity, QlooTag } from "./types";

const SCORE_KEYS = ["score", "affinity", "weight", "value"];

/**
 * Seed ids mentioned anywhere in `value` (as a string value or as an object key), each with the
 * score found beside it (0 when none). The key layout of Qloo explainability is unconfirmed.
 */
function contributors(value: unknown, seedIds: Set<string>, out = new Map<string, number>()): Map<string, number> {
  const add = (id: string, score: number) => out.set(id, Math.max(out.get(id) ?? 0, score));
  if (typeof value === "string") {
    if (seedIds.has(value)) add(value, 0);
  } else if (Array.isArray(value)) {
    for (const v of value) contributors(v, seedIds, out);
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const scoreKey = SCORE_KEYS.find((k) => typeof obj[k] === "number");
    const score = scoreKey ? (obj[scoreKey] as number) : 0;
    for (const [k, v] of Object.entries(obj)) {
      if (seedIds.has(k)) add(k, typeof v === "number" ? v : 0);
      if (typeof v === "string" && seedIds.has(v)) add(v, score);
      else contributors(v, seedIds, out);
    }
  }
  return out;
}

const tagKey = (t: QlooTag) => t.name.trim().toLowerCase();

function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The "because" line for a pick, derived only from Qloo data:
 * 1. the top seed named in the pick's explainability, 2. the seed with the most shared tags,
 * 3. tags shared with the taste profile, 4. the affinity score.
 */
export function explainPick(pick: QlooEntity, seeds: QlooEntity[], profile: QlooTag[] = []): string {
  const seedById = new Map(seeds.map((s) => [s.id, s]));
  let top: { id: string; score: number } | undefined;
  for (const [id, score] of contributors(pick.explainability, new Set(seedById.keys()))) {
    if (!top || score > top.score) top = { id, score };
  }
  if (top) return `Because you like ${seedById.get(top.id)!.name}`;

  const pickTags = new Map<string, QlooTag>();
  for (const t of pick.tags) {
    pickTags.set(t.id, t);
    pickTags.set(tagKey(t), t);
  }
  let best: { seed: QlooEntity; shared: string[] } | undefined;
  for (const seed of seeds) {
    const shared: string[] = [];
    for (const t of seed.tags) {
      const match = pickTags.get(t.id) ?? pickTags.get(tagKey(t));
      const name = match ? tagKey(match) : undefined;
      if (name && !shared.includes(name)) shared.push(name);
    }
    if (shared.length > 0 && (!best || shared.length > best.shared.length)) best = { seed, shared };
  }
  if (best) return `Shares ${joinNames(best.shared.slice(0, 2))} with ${best.seed.name}`;

  // Seeds from /search may carry no tags; the profile tags still come from the same seeds.
  const profileShared = [...new Set(profile.map((t) => pickTags.get(t.id) ?? pickTags.get(tagKey(t))).filter((t) => !!t).map((t) => tagKey(t!)))];
  if (profileShared.length > 0) return `Matches your taste for ${joinNames(profileShared.slice(0, 2))}`;

  if (pick.affinity !== undefined) return `Strong taste match (${Math.round(pick.affinity * 100)}%)`;
  return "Recommended by Qloo for your taste";
}
