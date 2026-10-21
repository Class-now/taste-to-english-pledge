import { MockQlooClient } from "./mock-qloo";
import type { EntityType, QlooEntity, QlooTag } from "./types";

export interface InsightsParams {
  type: EntityType;
  entityIds: string[];
  tagIds?: string[];
  excludeIds?: string[];
  take?: number;
  minYear?: number;
  maxYear?: number;
  explain?: boolean;
}

export interface QlooClient {
  search(query: string, types?: EntityType[], take?: number): Promise<QlooEntity[]>;
  insights(p: InsightsParams): Promise<QlooEntity[]>;
  entityTags(entityIds: string[], take?: number): Promise<QlooTag[]>;
  searchTags(query: string, take?: number): Promise<QlooTag[]>;
}

export class QlooError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "QlooError";
  }
}

export const TYPE_URN: Record<EntityType, string> = {
  book: "urn:entity:book",
  movie: "urn:entity:movie",
  tv_show: "urn:entity:tv_show",
  podcast: "urn:entity:podcast",
  artist: "urn:entity:artist",
  videogame: "urn:entity:videogame",
};
const VIDEOGAME_FALLBACK_URN = "urn:entity:video_game";

const URN_TYPE: Record<string, EntityType> = {
  ...Object.fromEntries(Object.entries(TYPE_URN).map(([t, u]) => [u, t as EntityType])),
  [VIDEOGAME_FALLBACK_URN]: "videogame",
};

type Query = Record<string, string | number | boolean | string[] | undefined>;
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const REQUEST_TIMEOUT_MS = 10_000;
// Unfiltered tag queries also return style, audience and place tags; ask Qloo for media tags only.
const MEDIA_TAG_TYPES = "urn:tag:genre:media,urn:tag:keyword:media";

// ---- defensive parsing helpers ----

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function parseYear(props: Record<string, unknown>): number | undefined {
  const y = num(props.release_year) ?? num(props.publication_year);
  if (y !== undefined) return Math.trunc(y);
  const date = str(props.release_date) ?? str(props.publication_date);
  const m = date?.match(/^(\d{4})/);
  return m ? Number(m[1]) : undefined;
}

function entityType(raw: Record<string, unknown>, fallback?: EntityType): EntityType | undefined {
  const candidates: unknown[] = [raw.subtype, raw.type, ...(Array.isArray(raw.types) ? raw.types : [])];
  for (const c of candidates) {
    if (typeof c === "string" && URN_TYPE[c]) return URN_TYPE[c];
  }
  return fallback;
}

export function parseTag(raw: unknown): QlooTag | undefined {
  const r = rec(raw);
  if (!r) return undefined;
  const id = str(r.tag_id) ?? str(r.id) ?? str(r.tag_value);
  const name = str(r.name);
  if (!id || !name) return undefined;
  const tag: QlooTag = { id, name };
  const subtype = str(r.subtype) ?? str(r.type);
  if (subtype) tag.subtype = subtype;
  const affinity = num(rec(r.query)?.affinity) ?? num(r.affinity);
  if (affinity !== undefined) tag.affinity = affinity;
  return tag;
}

export function parseEntity(raw: unknown, fallbackType?: EntityType): QlooEntity | undefined {
  const r = rec(raw);
  if (!r) return undefined;
  const id = str(r.entity_id) ?? str(r.id);
  const name = str(r.name);
  const type = entityType(r, fallbackType);
  if (!id || !name || !type) return undefined;
  const props = rec(r.properties) ?? {};
  const query = rec(r.query);
  const e: QlooEntity = {
    id,
    name,
    type,
    tags: Array.isArray(r.tags) ? r.tags.map((t) => parseTag(t)).filter((t): t is QlooTag => !!t) : [],
  };
  const year = parseYear(props);
  if (year !== undefined) e.year = year;
  const description = str(props.description) ?? str(props.short_description);
  if (description) e.description = description;
  const imageUrl = str(rec(props.image)?.url);
  if (imageUrl) e.imageUrl = imageUrl;
  const popularity = num(r.popularity);
  if (popularity !== undefined) e.popularity = popularity;
  const affinity = num(r.affinity) ?? num(query?.affinity);
  if (affinity !== undefined) e.affinity = affinity;
  const disambiguation = str(r.disambiguation) ?? str(props.disambiguation);
  if (disambiguation) e.disambiguation = disambiguation;
  const language = str(props.language);
  if (language) e.language = language;
  const pageCount = num(props.page_count);
  if (pageCount !== undefined) e.pageCount = Math.trunc(pageCount);
  const explainability = rec(query?.explainability);
  if (explainability) e.explainability = explainability;
  return e;
}

export function parseErrorMessage(text: string, fallback: string): string {
  try {
    const body = rec(JSON.parse(text));
    const err = rec(body?.error);
    return str(err?.message) ?? str(err?.reason) ?? str(body?.message) ?? str(body?.reason) ?? fallback;
  } catch {
    return text.trim().slice(0, 200) || fallback;
  }
}

export interface HttpQlooOptions {
  retryDelayMs?: number;
}

export class HttpQlooClient implements QlooClient {
  private readonly fetchFn: FetchFn;
  private readonly retryDelayMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    fetchFn?: FetchFn,
    opts: HttpQlooOptions = {},
  ) {
    // Wrap the global so it is never invoked unbound (Workers reject that).
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
    this.retryDelayMs = opts.retryDelayMs ?? 500;
  }

  buildUrl(path: string, q: Query): string {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined || v === "") continue;
      if (Array.isArray(v)) {
        if (v.length === 0) continue;
        url.searchParams.set(k, v.join(","));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async get(path: string, q: Query): Promise<unknown> {
    const url = this.buildUrl(path, q);
    // A fresh timeout per attempt so a hung Qloo endpoint fails the step instead of stalling the request.
    const init = (): RequestInit => ({
      method: "GET",
      headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let res = await this.fetchFn(url, init());
    if (RETRYABLE.has(res.status)) {
      // Release the first connection; Workers caps concurrent outbound connections at 6.
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, this.retryDelayMs));
      res = await this.fetchFn(url, init());
    }
    const text = await res.text();
    if (!res.ok) {
      throw new QlooError(res.status, parseErrorMessage(text, res.statusText || `HTTP ${res.status}`));
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new QlooError(res.status, "Qloo returned invalid JSON");
    }
  }

  /** Runs a request; when it uses the videogame URN and gets 403, retries once with `video_game`. */
  private async getWithVideogameFallback(path: string, q: Query, usesVideogame: boolean): Promise<unknown> {
    try {
      return await this.get(path, q);
    } catch (err) {
      if (!(err instanceof QlooError) || err.status !== 403 || !usesVideogame) throw err;
      const swapped: Query = {};
      for (const [k, v] of Object.entries(q)) {
        const swap = (s: string) => (s === TYPE_URN.videogame ? VIDEOGAME_FALLBACK_URN : s);
        swapped[k] = Array.isArray(v) ? v.map(swap) : typeof v === "string" ? swap(v) : v;
      }
      return this.get(path, swapped);
    }
  }

  async search(query: string, types?: EntityType[], take = 5): Promise<QlooEntity[]> {
    const urns = (types ?? []).map((t) => TYPE_URN[t]);
    const body = rec(
      await this.getWithVideogameFallback("/search", { query, types: urns, take }, !!types?.includes("videogame")),
    );
    const results = Array.isArray(body?.results) ? body.results : [];
    return results.map((r) => parseEntity(r)).filter((e): e is QlooEntity => !!e);
  }

  async insights(p: InsightsParams): Promise<QlooEntity[]> {
    const q: Query = {
      "filter.type": TYPE_URN[p.type],
      "signal.interests.entities": p.entityIds,
      "signal.interests.tags": p.tagIds,
      "filter.exclude.entities": p.excludeIds,
      take: p.take,
      "feature.explainability": p.explain ? true : undefined,
    };
    const serverYears = p.type === "book" || p.type === "movie" || p.type === "tv_show";
    if (serverYears) {
      const field = p.type === "book" ? "publication_year" : "release_year";
      q[`filter.${field}.min`] = p.minYear;
      q[`filter.${field}.max`] = p.maxYear;
    }
    const body = rec(await this.getWithVideogameFallback("/v2/insights", q, p.type === "videogame"));
    const raw = rec(body?.results)?.entities;
    let entities = (Array.isArray(raw) ? raw : [])
      .map((r) => parseEntity(r, p.type))
      .filter((e): e is QlooEntity => !!e);
    if (!serverYears && (p.minYear !== undefined || p.maxYear !== undefined)) {
      entities = entities.filter(
        (e) =>
          e.year === undefined ||
          ((p.minYear === undefined || e.year >= p.minYear) && (p.maxYear === undefined || e.year <= p.maxYear)),
      );
    }
    return entities;
  }

  async entityTags(entityIds: string[], take = 20): Promise<QlooTag[]> {
    const body = rec(
      await this.get("/v2/insights", {
        "filter.type": "urn:tag",
        "signal.interests.entities": entityIds,
        "filter.tag.types": MEDIA_TAG_TYPES,
        take,
      }),
    );
    const raw = rec(body?.results)?.tags;
    return (Array.isArray(raw) ? raw : []).map((t) => parseTag(t)).filter((t): t is QlooTag => !!t);
  }

  async searchTags(query: string, take = 10): Promise<QlooTag[]> {
    const body = rec(
      await this.get("/v2/tags", {
        "filter.query": query,
        "feature.semantic_search": true,
        "filter.tag.types": MEDIA_TAG_TYPES,
        take,
      }),
    );
    const raw = rec(body?.results)?.tags;
    return (Array.isArray(raw) ? raw : []).map((t) => parseTag(t)).filter((t): t is QlooTag => !!t);
  }
}

export interface QlooEnv {
  QLOO_BASE_URL: string;
  QLOO_API_KEY?: string;
}

export function qlooMode(env: Partial<QlooEnv>): "live" | "mock" {
  return typeof env.QLOO_API_KEY === "string" && env.QLOO_API_KEY.trim() !== "" ? "live" : "mock";
}

export function createQlooClient(env: QlooEnv, fetchFn?: FetchFn): QlooClient {
  if (qlooMode(env) === "live") {
    return new HttpQlooClient(env.QLOO_BASE_URL || "https://hackathon.api.qloo.com", env.QLOO_API_KEY!.trim(), fetchFn);
  }
  return new MockQlooClient();
}
