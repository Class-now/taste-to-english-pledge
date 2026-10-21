import type { QlooEntity, QlooTag } from "./types";

/** Every string found anywhere inside `value`, in document order. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

const tagKey = (t: QlooTag) => t.name.trim().toLowerCase();

function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The "because" line for a pick, derived only from Qloo data:
 * 1. a seed named in the pick's explainability, 2. the seed with the most shared tags, 3. the affinity score.
 */
export function explainPick(pick: QlooEntity, seeds: QlooEntity[]): string {
  const seedById = new Map(seeds.map((s) => [s.id, s]));
  for (const s of strings(pick.explainability)) {
    const seed = seedById.get(s);
    if (seed) return `Because you like ${seed.name}`;
  }

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

  if (pick.affinity !== undefined) return `Strong taste match (${Math.round(pick.affinity * 100)}%)`;
  return "Recommended by Qloo for your taste";
}
