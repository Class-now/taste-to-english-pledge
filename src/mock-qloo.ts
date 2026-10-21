import { MOCK_ENTITIES, MOCK_TAGS, type MockEntity } from "./mock-data";
import type { InsightsParams, QlooClient } from "./qloo";
import type { EntityType, QlooEntity, QlooTag } from "./types";

/** Lowercase, width-fold (NFKC) and drop punctuation/spaces so "ペルソナ５" matches "ペルソナ5". */
export function normalizeTitle(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function toEntity(m: MockEntity): QlooEntity {
  const e: QlooEntity = {
    id: m.id,
    name: m.name,
    type: m.type,
    year: m.year,
    description: m.description,
    popularity: m.popularity,
    tags: m.tags.map((k) => ({ ...MOCK_TAGS[k] })),
  };
  if (m.language) e.language = m.language;
  if (m.pageCount !== undefined) e.pageCount = m.pageCount;
  if (m.disambiguation) e.disambiguation = m.disambiguation;
  return e;
}

function tagIdsOf(m: MockEntity): string[] {
  return m.tags.map((k) => MOCK_TAGS[k].id);
}

/** Deterministic, offline stand-in for the Qloo API, backed by hand-written fixtures. */
export class MockQlooClient implements QlooClient {
  constructor(private readonly entities: MockEntity[] = MOCK_ENTITIES) {}

  async search(query: string, types?: EntityType[], take = 5): Promise<QlooEntity[]> {
    const q = normalizeTitle(query);
    if (!q) return [];
    const scored: { m: MockEntity; score: number }[] = [];
    for (const m of this.entities) {
      if (types && types.length > 0 && !types.includes(m.type)) continue;
      let score = 0;
      for (const name of [m.name, ...(m.aliases ?? [])]) {
        const n = normalizeTitle(name);
        if (n === q) score = Math.max(score, 2);
        else if (q.length >= 2 && (n.includes(q) || q.includes(n))) score = Math.max(score, 1);
      }
      if (score > 0) scored.push({ m, score });
    }
    scored.sort((a, b) => b.score - a.score || b.m.popularity - a.m.popularity || a.m.id.localeCompare(b.m.id));
    return scored.slice(0, take).map(({ m }) => toEntity(m));
  }

  async insights(p: InsightsParams): Promise<QlooEntity[]> {
    const seeds = this.entities.filter((m) => p.entityIds.includes(m.id));
    // Weight of each tag: how many seeds carry it, plus 2 for each explicitly requested tag.
    const weight = new Map<string, number>();
    for (const s of seeds) for (const id of tagIdsOf(s)) weight.set(id, (weight.get(id) ?? 0) + 1);
    for (const id of p.tagIds ?? []) weight.set(id, (weight.get(id) ?? 0) + 2);

    const exclude = new Set([...(p.excludeIds ?? [])]);
    const candidates = this.entities.filter(
      (m) =>
        m.type === p.type &&
        !exclude.has(m.id) &&
        (p.minYear === undefined || m.year >= p.minYear) &&
        (p.maxYear === undefined || m.year <= p.maxYear),
    );
    const scored = candidates.map((m) => ({
      m,
      score: tagIdsOf(m).reduce((sum, id) => sum + (weight.get(id) ?? 0), 0),
    }));
    const max = Math.max(0, ...scored.map((s) => s.score));
    scored.sort((a, b) => b.score - a.score || b.m.popularity - a.m.popularity || a.m.id.localeCompare(b.m.id));

    return scored.slice(0, p.take ?? 20).map(({ m, score }) => {
      const e = toEntity(m);
      e.affinity = round3((score + 1) / (max + 1));
      if (p.explain) {
        const own = new Set(tagIdsOf(m));
        const contributors = seeds
          .map((s) => ({ entity_id: s.id, score: round3(tagIdsOf(s).filter((id) => own.has(id)).length / own.size) }))
          .filter((c) => c.score > 0)
          .sort((a, b) => b.score - a.score || a.entity_id.localeCompare(b.entity_id));
        e.explainability = { entities: contributors };
      }
      return e;
    });
  }

  async entityTags(entityIds: string[], take = 20): Promise<QlooTag[]> {
    const seeds = this.entities.filter((m) => entityIds.includes(m.id));
    if (seeds.length === 0) return [];
    const counts = new Map<string, { tag: QlooTag; n: number }>();
    for (const s of seeds) {
      for (const k of s.tags) {
        const t = MOCK_TAGS[k];
        const c = counts.get(t.id) ?? { tag: t, n: 0 };
        c.n += 1;
        counts.set(t.id, c);
      }
    }
    return [...counts.values()]
      .sort((a, b) => b.n - a.n || a.tag.name.localeCompare(b.tag.name))
      .slice(0, take)
      .map(({ tag, n }) => ({ ...tag, affinity: round3(n / seeds.length) }));
  }

  async searchTags(query: string, take = 10): Promise<QlooTag[]> {
    const q = query.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!q) return [];
    return Object.values(MOCK_TAGS)
      .filter((t) => t.id.toLowerCase().includes(q) || t.name.toLowerCase().replace(/\s+/g, "_").includes(q))
      .slice(0, take)
      .map((t) => ({ ...t }));
  }
}
