import { wasCached } from "./cache";
import { explainPick, pickEvidence } from "./explain";
import type { Llm, LlmJsonOptions } from "./llm";
import { normalizeTitle } from "./mock-qloo";
import { levelPrompt, normalizePrompt, planPrompt, promptInput, promptKind, refinePrompt, type LevelCandidate } from "./prompts";
import { TYPE_URN, type InsightsParams, type QlooClient } from "./qloo";
import { FORMAT_TYPES, MIN_PER_FORMAT, MIN_PICKS, formatOf, selectPicks, type LevelEstimate } from "./select";
import {
  CEFR_LEVELS,
  ENTITY_TYPES,
  type AgentEvent,
  type Cefr,
  type Day,
  type EntityType,
  type Format,
  type Pick,
  type PlanInput,
  type PlanResult,
  type QlooEntity,
  type QlooTag,
  type Seed,
  type ToolCall,
  type TraceStep,
  type Vocab,
} from "./types";

export interface AgentDeps {
  qloo: QlooClient;
  llm: Llm;
  mode: "live" | "mock";
  now?: () => number;
  /** Receives trace events as they happen (streaming endpoint). Must not throw. */
  onEvent?: (e: AgentEvent) => void;
}

export class AgentError extends Error {
  constructor(
    public readonly step: string,
    message: string,
    public readonly trace: TraceStep[],
  ) {
    super(message);
    this.name = "AgentError";
  }
}

const PROFILE_SIZE = 8;
const MAX_LEVEL_CANDIDATES = 40;
const LEVEL_BATCH = 20;
// "en", "en-US", "eng", "English (US)" etc.
const ENGLISH = /^(en|eng|english)\b/i;

export const STEP_LABELS: Record<string, string> = {
  normalize: "Understanding your favourites",
  resolve: "Finding them in Qloo",
  profile: "Reading your taste profile",
  refine: "Applying your refinement",
  recommend: "Searching English works with Qloo",
  level: "Estimating English level",
  review: "Checking the plan and filling gaps",
  explain: "Explaining each match",
  plan: "Writing your 7-day plan",
};

const FAILURE_MESSAGES: Record<string, string> = {
  normalize: "The AI couldn't read your favourites. Please try again.",
  resolve: "Qloo search failed. Please try again.",
  profile: "Qloo couldn't build your taste profile. Please try again.",
  refine: "We couldn't apply your refinement. Try different wording.",
  recommend: "Qloo couldn't find recommendations. Please try again.",
  level: "The AI couldn't estimate English levels. Please try again.",
  review: "We couldn't check the plan. Please try again.",
  explain: "We couldn't explain the matches. Please try again.",
  plan: "The AI couldn't write your plan. Please try again.",
};

/** Thrown inside a step to fail it with a specific user-facing message. */
class StepFailure extends Error {}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function toEntityType(v: unknown): EntityType | undefined {
  return ENTITY_TYPES.includes(v as EntityType) ? (v as EntityType) : undefined;
}

function describe(e: QlooEntity): string {
  return `${e.name} (${e.type.replace("_", " ")}${e.year ? `, ${e.year}` : ""})`;
}

function isEnglishOrUnknown(e: QlooEntity): boolean {
  return !e.language || ENGLISH.test(e.language.trim());
}

const FORMAT_VERB: Record<Format, string> = { read: "to read", listen: "to listen to", watch: "to watch" };
const TYPE_PLURAL: Record<EntityType, string> = {
  book: "books",
  movie: "films",
  tv_show: "TV shows",
  podcast: "podcasts",
  videogame: "games",
  artist: "artists",
};
const typePlural = (t: EntityType) => TYPE_PLURAL[t];

/** Whole-word, case-insensitive patterns so a short phrase like "war" doesn't also drop "software" or "award". */
function avoidRegexes(phrases: string[]): RegExp[] {
  return phrases.map((a) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
}

/** Model-written text is shown to learners; links in it could only come from injected input, so drop them. */
export function stripUrls(s: string): string {
  return s
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const short = (id: string) => (id.length > 14 ? `${id.slice(0, 8)}…` : id);

function insightsSummary(p: InsightsParams): string {
  const parts = [`filter.type=${TYPE_URN[p.type]}`, `signal.interests.entities=${p.entityIds.map(short).join(",")}`];
  if (p.tagIds?.length) parts.push(`signal.interests.tags=${p.tagIds.map((t) => t.split(":").pop()).join(",")}`);
  if (p.excludeIds?.length) parts.push(`filter.exclude.entities=${p.excludeIds.length} ids`);
  if (p.minYear !== undefined || p.maxYear !== undefined) parts.push(`years ${p.minYear ?? "any"}–${p.maxYear ?? "any"}`);
  if (p.explain) parts.push("feature.explainability=true");
  parts.push(`take=${p.take ?? 20}`);
  return parts.join(" · ");
}

/** Wraps a Qloo client so each call is reported (endpoint, readable params, count, time, cache hit). No key or URL. */
function traceQloo(inner: QlooClient, mode: "live" | "mock", onCall: (c: ToolCall) => void, now: () => number): QlooClient {
  const source = mode === "live" ? "qloo" : "sample";
  async function run<T extends unknown[]>(tool: ToolCall["tool"], endpoint: string, summary: string, fn: () => Promise<T>): Promise<T> {
    const start = now();
    try {
      const value = await fn();
      onCall({ tool, endpoint, summary, results: value.length, ms: Math.round(now() - start), cached: wasCached(value), ok: true, source });
      return value;
    } catch (err) {
      onCall({ tool, endpoint, summary, ms: Math.round(now() - start), cached: false, ok: false, source });
      throw err;
    }
  }
  return {
    search: (query, types, take) =>
      run(
        "qloo.search",
        "GET /search",
        [`query="${clip(query, 60)}"`, ...(types?.length ? [`types=${types.map((t) => TYPE_URN[t]).join(",")}`] : []), `take=${take ?? 5}`].join(" · "),
        () => inner.search(query, types, take),
      ),
    insights: (p) => run("qloo.insights", "GET /v2/insights", insightsSummary(p), () => inner.insights(p)),
    entityTags: (ids, take) =>
      run(
        "qloo.tags",
        "GET /v2/insights",
        `filter.type=urn:tag · signal.interests.entities=${ids.map(short).join(",")} · take=${take ?? 20}`,
        () => inner.entityTags(ids, take),
      ),
    searchTags: (query, take) =>
      run("qloo.tag_search", "GET /v2/tags", `filter.query="${clip(query, 40)}" · feature.semantic_search=true · take=${take ?? 10}`, () =>
        inner.searchTags(query, take),
      ),
  };
}

const LLM_WHAT: Record<string, (input: unknown) => string> = {
  normalize: (i) => `${asArray(i).length} title${asArray(i).length === 1 ? "" : "s"} → search queries`,
  refine: () => "your wording → tag phrases and years",
  level: (i) => `CEFR estimate for ${asArray(i).length} works`,
  plan: (i) => `7-day plan + 12 words from ${asArray(record(i).picks).length} picks`,
};

/** Wraps the LLM so each call is reported with who answered it (Workers AI or the rule-based fallback). */
function traceLlm(inner: Llm, onCall: (c: ToolCall) => void, now: () => number): Llm {
  return {
    async json<T>(opts: LlmJsonOptions): Promise<T> {
      const kind = promptKind(opts.system) ?? "llm";
      let summary = kind;
      try {
        summary = LLM_WHAT[kind]?.(promptInput<unknown>(opts.user)) ?? kind;
      } catch {
        // the summary is cosmetic
      }
      const start = now();
      try {
        const out = await inner.json<T>(opts);
        const source = inner.lastSource ?? "workers-ai";
        const o = record(out);
        const results = asArray(o.items).length || asArray(o.days).length || undefined;
        onCall({
          tool: "llm",
          endpoint: source === "workers-ai" ? `Workers AI · ${kind}` : `Rule-based fallback · ${kind}`,
          summary,
          ...(results !== undefined ? { results } : {}),
          ms: Math.round(now() - start),
          cached: false,
          ok: true,
          source,
        });
        return out;
      } catch (err) {
        onCall({ tool: "llm", endpoint: `Workers AI · ${kind}`, summary, ms: Math.round(now() - start), cached: false, ok: false, source: "workers-ai" });
        throw err;
      }
    },
  };
}

function fallbackActivity(p: Pick, minutes: number): string {
  if (p.format === "read") return `Read about ${Math.max(2, Math.round(minutes / 3))} pages of "${p.name}"`;
  if (p.format === "listen") return `Listen to one episode of "${p.name}"`;
  return `Watch part of "${p.name}" with English subtitles`;
}

export async function runPlan(input: PlanInput, deps: AgentDeps): Promise<PlanResult> {
  const now = deps.now ?? (() => Date.now());
  const trace: TraceStep[] = [];
  const warnings: string[] = [];

  const emit = (e: AgentEvent) => {
    try {
      deps.onEvent?.(e);
    } catch {
      // A broken listener (e.g. a closed stream) must never break the plan.
    }
  };
  let currentStep = "";
  let calls: ToolCall[] = [];
  const onCall = (call: ToolCall) => {
    calls.push(call);
    emit({ type: "call", step: currentStep, call });
  };
  const qloo = traceQloo(deps.qloo, deps.mode, onCall, now);
  const llm = traceLlm(deps.llm, onCall, now);

  const planned = ["normalize", "resolve", "profile", ...(input.refine ? ["refine"] : []), "recommend", "level", "review", "explain", "plan"];
  emit({ type: "start", mode: deps.mode, steps: planned.map((id) => ({ id, label: STEP_LABELS[id] ?? id })) });

  async function step<T>(id: string, fn: () => Promise<{ value: T; detail: string }>): Promise<T> {
    const start = now();
    const label = STEP_LABELS[id] ?? id;
    currentStep = id;
    calls = [];
    emit({ type: "step-start", id, label });
    const finish = (detail: string, status: TraceStep["status"]) => {
      const done: TraceStep = { id, label, detail, ms: Math.round(now() - start), status, ...(calls.length ? { calls } : {}) };
      trace.push(done);
      emit({ type: "step", step: done });
    };
    try {
      const { value, detail } = await fn();
      finish(detail, calls.some((c) => c.source === "rule-based") ? "fallback" : "ok");
      return value;
    } catch (err) {
      // Only StepFailure messages are written for users; raw upstream errors stay in the logs.
      const message = err instanceof StepFailure ? err.message : FAILURE_MESSAGES[id];
      if (!(err instanceof StepFailure)) console.error(`step ${id} failed:`, err instanceof Error ? err.message : String(err));
      finish(`Failed: ${message}`, "failed");
      throw new AgentError(id, message, trace);
    }
  }

  // 1. normalize
  const normalized = await step("normalize", async () => {
    const items = input.favorites.map((f, index) => ({ index, title: f.title, ...(f.type ? { type: f.type } : {}) }));
    const out = await llm.json<{ items?: unknown }>(normalizePrompt(items));
    // Match rows by the echoed index so a skipped or reordered row can't shift later favourites.
    const rows = new Map<number, Record<string, unknown>>();
    for (const raw of asArray(record(out).items)) {
      const r = record(raw);
      if (Number.isInteger(r.index) && !rows.has(r.index as number)) rows.set(r.index as number, r);
    }
    // A model that numbers rows from 1 would otherwise give every favourite its predecessor's query.
    const n = input.favorites.length;
    const oneBased = !rows.has(0) && rows.has(n) && [...rows.keys()].every((k) => k >= 1 && k <= n);
    const value = input.favorites.map((f, i) => {
      const row = rows.get(oneBased ? i + 1 : i) ?? {};
      return {
        title: f.title,
        query: isString(row.query) ? row.query.trim() : f.title,
        type: f.type ?? toEntityType(row.typeGuess),
        typeGiven: !!f.type,
      };
    });
    return {
      value,
      detail: value.map((v) => `"${v.title}" → "${v.query}"${v.type ? ` (${v.type.replace("_", " ")})` : ""}`).join("; "),
    };
  });

  // 2. resolve
  const resolvedSeeds: Seed[] = [];
  const seeds = await step("resolve", async () => {
    const found: QlooEntity[] = [];
    const lines: string[] = [];
    for (const n of normalized) {
      const names = new Set([normalizeTitle(n.query), normalizeTitle(n.title)]);
      const exact = (results: QlooEntity[]) => results.find((r) => names.has(normalizeTitle(r.name)));
      // Search is fuzzy and the type may be a model guess, so unless the user chose the type, take an
      // exact name match from any pass before falling back to the top untyped hit.
      const typed = n.type ? await qloo.search(n.query, [n.type], 5) : [];
      let hit = exact(typed) ?? (n.typeGiven ? typed[0] : undefined);
      let untyped: QlooEntity[] = [];
      if (!hit) {
        untyped = await qloo.search(n.query, undefined, 5);
        hit = exact(untyped);
      }
      let byTitle: QlooEntity[] = [];
      if (!hit && n.query !== n.title) {
        byTitle = await qloo.search(n.title, undefined, 5);
        hit = exact(byTitle);
      }
      hit ??= untyped[0] ?? typed[0] ?? byTitle[0];
      if (!hit) {
        warnings.push(`Couldn't find "${n.title}"`);
        lines.push(`"${n.title}" → not found`);
      } else if (!found.some((e) => e.id === hit.id)) {
        found.push(hit);
        resolvedSeeds.push({
          id: hit.id,
          name: hit.name,
          type: hit.type,
          input: n.title,
          ...(hit.year ? { year: hit.year } : {}),
          ...(hit.imageUrl ? { imageUrl: hit.imageUrl } : {}),
        });
        lines.push(`"${n.title}" → ${describe(hit)}`);
      }
    }
    if (found.length === 0) {
      throw new StepFailure("We couldn't find any of these titles. Try the official English or Japanese title.");
    }
    return { value: found, detail: lines.join("; ") };
  });
  const seedIds = seeds.map((s) => s.id);

  // 3. profile
  const profile = await step("profile", async () => {
    // Without a tag-type filter Qloo can return style or place tags; keep media tags like refine does.
    const tags = (await qloo.entityTags(seedIds, 20)).filter((t) => `${t.id} ${t.subtype ?? ""}`.includes(":media"));
    const value = [...tags].sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0)).slice(0, PROFILE_SIZE);
    return { value, detail: value.length ? value.map((t) => t.name).join(", ") : "No taste tags returned" };
  });

  // 3b. refine (optional)
  let tagIds: string[] = [];
  let avoidTags: string[] = [];
  let minYear: number | undefined;
  let maxYear: number | undefined;
  // Whether the refined Qloo query is what produced the candidates (it can fall back to unrefined).
  let refinedApplied = false;
  if (input.refine) {
    const refineText = input.refine;
    // Refining is optional: if it fails, keep going with the unrefined plan instead of losing it.
    await step("refine", async () => {
      const out = record(await llm.json<unknown>(refinePrompt(refineText)));
      const add = asArray(out.addTags).filter(isString).map((t) => t.trim()).slice(0, 3);
      avoidTags = asArray(out.avoidTags).filter(isString).map((t) => t.trim().toLowerCase()).slice(0, 3);
      const year = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1800 && (v as number) <= 2100 ? (v as number) : undefined);
      minYear = year(out.minYear);
      maxYear = year(out.maxYear);
      if (minYear !== undefined && maxYear !== undefined && minYear > maxYear) [minYear, maxYear] = [maxYear, minYear];
      const resolved: QlooTag[] = [];
      for (const q of add) {
        // Semantic tag search can return place or brand tags; only media tags make sense as signals.
        const hit = (await qloo.searchTags(q, 5)).find((t) => `${t.id} ${t.subtype ?? ""}`.includes(":media"));
        if (hit && !resolved.some((t) => t.id === hit.id)) resolved.push(hit);
      }
      tagIds = resolved.map((t) => t.id);
      const parts = [
        `more: ${add.length ? add.map((a) => `"${a}"`).join(", ") : "—"}${resolved.length ? ` → Qloo tags ${resolved.map((t) => t.name).join(", ")}` : ""}`,
        `less: ${avoidTags.length ? avoidTags.map((a) => `"${a}"`).join(", ") : "—"}`,
      ];
      if (minYear || maxYear) parts.push(`years: ${minYear ?? "any"}–${maxYear ?? "any"}`);
      return { value: undefined, detail: parts.join("; ") };
    }).catch(() => {
      tagIds = [];
      avoidTags = [];
      minYear = maxYear = undefined;
      warnings.push("Couldn't apply your refinement this time, so these are the unrefined picks");
    });
  }

  // 4. recommend
  const candidates = await step("recommend", async () => {
    const types = [...new Set(input.formats.flatMap((f: Format) => FORMAT_TYPES[f]))];
    const gather = async (refined: boolean) => {
      const settled = await Promise.allSettled(
        types.map((type) =>
          qloo.insights({
            type,
            entityIds: seedIds,
            tagIds: refined ? tagIds : [],
            excludeIds: seedIds,
            take: 15,
            minYear: refined ? minYear : undefined,
            maxYear: refined ? maxYear : undefined,
            explain: true,
          }),
        ),
      );
      const failures = settled.filter((s) => s.status === "rejected");
      if (failures.length === settled.length) {
        const reason = (failures[0] as PromiseRejectedResult).reason;
        throw reason instanceof Error ? reason : new Error(String(reason));
      }
      const avoidPatterns = refined ? avoidRegexes(avoidTags) : [];
      const seen = new Set(seedIds);
      const value: QlooEntity[] = [];
      const counts: string[] = [];
      const failed: string[] = [];
      settled.forEach((s, i) => {
        if (s.status === "rejected") {
          failed.push(`Qloo couldn't search ${types[i].replace("_", " ")}s this time`);
          return;
        }
        const kept = s.value.filter(
          (e) =>
            !seen.has(e.id) &&
            isEnglishOrUnknown(e) &&
            !e.tags.some((t) => avoidPatterns.some((re) => re.test(t.name))),
        );
        for (const e of kept) seen.add(e.id);
        value.push(...kept);
        counts.push(`${kept.length} ${types[i].replace("_", " ")}${kept.length === 1 ? "" : "s"}`);
      });
      return { value, counts, failed };
    };
    const refining = tagIds.length > 0 || avoidTags.length > 0 || minYear !== undefined || maxYear !== undefined;
    // When refining, a rejected refined query falls back like an empty one: an unrefined plan beats no plan.
    let found = refining
      ? await gather(true).catch((err) => {
          console.error("refined recommend failed:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
          return null;
        })
      : await gather(false);
    let note = "";
    if (refining && (!found || found.value.length === 0)) {
      const rejected = !found;
      found = await gather(false);
      if (rejected) {
        warnings.push("Couldn't apply your refinement this time, so these are the unrefined picks");
        note = " (refinement failed; unrefined)";
      } else {
        warnings.push("Nothing matched your refinement, so these are the unrefined picks");
        note = " (refinement matched nothing; unrefined)";
      }
    }
    if (!found) throw new Error("unreachable: recommend has no result");
    refinedApplied = refining && !note;
    warnings.push(...found.failed);
    if (found.value.length === 0) {
      throw new StepFailure("Qloo didn't return any English works for these favourites. Try adding another title.");
    }
    return { value: found.value, detail: `Found ${found.counts.join(", ")}${note}` };
  });

  const toLevelCandidate = (c: QlooEntity): LevelCandidate => ({
    id: c.id,
    title: c.name,
    type: c.type,
    ...(c.year ? { year: c.year } : {}),
    ...(c.description ? { description: clip(c.description, 200) } : {}),
    ...(c.pageCount ? { pageCount: c.pageCount } : {}),
  });

  /** Rates works into `rated` in small batches; returns the last error (a failed batch keeps the others). */
  async function rateLevels(works: QlooEntity[], rated: Map<string, LevelEstimate>): Promise<unknown> {
    const payload = works.map(toLevelCandidate);
    const ids = new Set(payload.map((c) => c.id));
    let lastError: unknown;
    const collect = (out: unknown) => {
      for (const raw of asArray(record(out).items)) {
        const r = record(raw);
        if (isString(r.id) && !rated.has(r.id) && ids.has(r.id) && CEFR_LEVELS.includes(r.cefr as Cefr)) {
          rated.set(r.id, { id: r.id, cefr: r.cefr as Cefr, reason: clip(stripUrls(isString(r.reason) ? r.reason.trim() : ""), 120) });
        }
      }
    };
    // Small batches keep each answer well inside the token limit.
    const rate = async (batch: LevelCandidate[]) => {
      for (let i = 0; i < batch.length; i += LEVEL_BATCH) {
        try {
          collect(await llm.json<unknown>(levelPrompt(input.level, batch.slice(i, i + LEVEL_BATCH))));
        } catch (err) {
          lastError = err;
          console.error("level batch failed:", err instanceof Error ? err.message : String(err));
        }
      }
    };
    await rate(payload);
    // Models sometimes stop after a few items; ask once more for the ones they skipped.
    const missing = payload.filter((c) => !rated.has(c.id));
    if (missing.length > 0) await rate(missing);
    return lastError;
  }

  // 5. level
  const levelled = await step("level", async () => {
    // Interleave types so the 40-candidate cap keeps every format represented.
    const queues = new Map<EntityType, QlooEntity[]>();
    for (const c of candidates) queues.set(c.type, [...(queues.get(c.type) ?? []), c]);
    const capped: QlooEntity[] = [];
    while (capped.length < MAX_LEVEL_CANDIDATES && [...queues.values()].some((q) => q.length)) {
      for (const q of queues.values()) {
        const next = q.shift();
        if (next && capped.length < MAX_LEVEL_CANDIDATES) capped.push(next);
      }
    }
    const rated = new Map<string, LevelEstimate>();
    const lastError = await rateLevels(capped, rated);
    if (rated.size === 0 && lastError) throw lastError;
    const picks = selectPicks(capped, [...rated.values()], input.level, input.formats);
    const within = [...rated.values()].filter((l) => Math.abs(CEFR_LEVELS.indexOf(l.cefr) - CEFR_LEVELS.indexOf(input.level)) <= 1).length;
    return {
      value: { pool: capped, rated, picks },
      detail: `Rated ${rated.size} of ${capped.length} works; ${within} are within one level of ${input.level}`,
    };
  });

  // 5b. review: the agent checks its own selection against the request and widens the search once if needed.
  const picks = await step("review", async () => {
    let { pool, picks } = levelled;
    const { rated } = levelled;
    const countBy = (ps: Pick[]) => new Map(input.formats.map((f) => [f, ps.filter((p) => p.format === f).length]));
    const coverage = (m: Map<Format, number>) => input.formats.map((f) => `${m.get(f)} ${FORMAT_VERB[f]}`).join(", ");
    const before = countBy(picks);
    const short = input.formats.filter((f) => (before.get(f) ?? 0) < MIN_PER_FORMAT);
    let detail: string;
    if (short.length === 0 && picks.length >= MIN_PICKS) {
      detail = `Checked: ${coverage(before)} at or near ${input.level}. Every format is covered, so no extra search is needed`;
    } else {
      const why = short.length
        ? short.map((f) => `only ${before.get(f)} ${FORMAT_VERB[f]}`).join(", ")
        : `only ${picks.length} picks in total`;
      const targets = short.length ? short : input.formats;
      const types = [...new Set(targets.flatMap((f) => FORMAT_TYPES[f]))];
      // A different signal than the first search: the learner's taste-profile tags on top of the favourites.
      const profileTags = profile.slice(0, 3);
      const signalTags = [...new Set([...(refinedApplied ? tagIds : []), ...profileTags.map((t) => t.id)])];
      const avoid = refinedApplied ? avoidRegexes(avoidTags) : [];
      const seen = new Set([...seedIds, ...candidates.map((c) => c.id)]);
      const action = `asked Qloo again for ${types.map(typePlural).join(" and ")}${profileTags.length ? ` with your taste tags ${profileTags.map((t) => t.name).join(", ")} as extra signals` : ""}`;
      try {
        const settled = await Promise.allSettled(
          types.map((type) =>
            qloo.insights({
              type,
              entityIds: seedIds,
              tagIds: signalTags,
              excludeIds: [...seen],
              take: 15,
              minYear: refinedApplied ? minYear : undefined,
              maxYear: refinedApplied ? maxYear : undefined,
              explain: true,
            }),
          ),
        );
        const fresh: QlooEntity[] = [];
        for (const r of settled) {
          if (r.status !== "fulfilled") continue;
          for (const e of r.value) {
            if (seen.has(e.id) || !isEnglishOrUnknown(e) || e.tags.some((t) => avoid.some((re) => re.test(t.name)))) continue;
            seen.add(e.id);
            fresh.push(e);
          }
        }
        if (settled.every((r) => r.status === "rejected")) {
          detail = `Noticed ${why} for ${input.level}; ${action}, but Qloo didn't answer, so the plan keeps the earlier picks`;
        } else if (fresh.length === 0) {
          detail = `Noticed ${why} for ${input.level}; ${action}, but there were no new English works`;
        } else {
          const extra = fresh.slice(0, LEVEL_BATCH);
          await rateLevels(extra, rated);
          pool = [...pool, ...extra];
          const beforeIds = new Set(picks.map((p) => p.id));
          picks = selectPicks(pool, [...rated.values()], input.level, input.formats);
          const added = picks.filter((p) => !beforeIds.has(p.id)).length;
          detail = `Noticed ${why} for ${input.level}; ${action} → ${fresh.length} new works, ${added} added. Now ${coverage(countBy(picks))}`;
        }
      } catch (err) {
        console.error("review widen failed:", err instanceof Error ? err.message : String(err));
        detail = `Noticed ${why} for ${input.level}; tried to widen the search but it failed, so the plan keeps the earlier picks`;
      }
    }
    if (picks.length === 0) {
      throw new StepFailure("None of the matches fit your English level. Try a different level or more favourites.");
    }
    if (picks.length < MIN_PICKS) warnings.push(`Only ${picks.length} works matched your level closely`);
    for (const f of input.formats) {
      if (!picks.some((p) => p.format === f)) warnings.push(`Nothing ${FORMAT_VERB[f]} matched your level this time`);
    }
    return { value: picks, detail };
  });

  // 6. explain
  await step("explain", async () => {
    for (const p of picks) {
      p.because = explainPick(p, seeds, profile);
      p.evidence = pickEvidence(p, seeds, profile);
    }
    const viaExplain = picks.filter((p) => (p.evidence?.contributions.length ?? 0) > 0).length;
    const viaTags = picks.filter((p) => !p.evidence?.contributions.length && (p.evidence?.sharedTags.length ?? 0) > 0).length;
    const parts = [`${viaExplain} named a favourite in Qloo explainability`];
    if (viaTags) parts.push(`${viaTags} share taste tags with your favourites`);
    if (picks.length - viaExplain - viaTags) parts.push(`${picks.length - viaExplain - viaTags} rely on the affinity score`);
    return { value: undefined, detail: `${picks.length} picks: ${parts.join(", ")}. Every "because" line comes from Qloo data, not the AI` };
  });

  // 7. plan + vocab
  const { plan, vocab } = await step("plan", async () => {
    const out = record(
      await llm.json<unknown>(
        planPrompt({
          learnerLevel: input.level,
          minutesPerDay: input.minutesPerDay,
          picks: picks.map((p) => ({
            id: p.id,
            title: p.name,
            type: p.type,
            format: p.format,
            cefr: p.cefr,
            ...(p.pageCount ? { pageCount: p.pageCount } : {}),
            ...(p.description ? { description: clip(p.description, 200) } : {}),
          })),
        }),
      ),
    );
    const pickIds = new Set(picks.map((p) => p.id));
    const byDay = new Map<number, Day>();
    for (const raw of asArray(out.days)) {
      const d = record(raw);
      const day = d.day as number;
      if (!Number.isInteger(day) || day < 1 || day > 7 || byDay.has(day)) continue;
      const activity = isString(d.activity) ? clip(stripUrls(d.activity.trim()), 200) : "";
      if (!isString(d.pickId) || !pickIds.has(d.pickId) || !activity) continue;
      // Day 1 must be the easiest pick: the vocabulary and the UI's "day 1" label refer to it.
      if (day === 1 && d.pickId !== picks[0].id) continue;
      byDay.set(day, { day, pickId: d.pickId, activity, minutes: input.minutesPerDay });
    }
    const dropped = 7 - byDay.size;
    for (let day = 1; day <= 7; day++) {
      if (byDay.has(day)) continue;
      const p = picks[(day - 1) % picks.length];
      byDay.set(day, { day, pickId: p.id, activity: fallbackActivity(p, input.minutesPerDay), minutes: input.minutesPerDay });
    }
    const vocab: Vocab[] = [];
    for (const raw of asArray(out.vocab)) {
      const v = record(raw);
      if (!isString(v.term) || !isString(v.ja) || !isString(v.example) || vocab.length >= 12) continue;
      const item = { term: clip(stripUrls(v.term.trim()), 60), ja: clip(stripUrls(v.ja.trim()), 60), example: clip(stripUrls(v.example.trim()), 200) };
      if (item.term && item.ja && item.example) vocab.push(item);
    }
    if (vocab.length < 12) warnings.push(`Only ${vocab.length} starter words could be written this time`);
    const value = { plan: [...byDay.values()].sort((a, b) => a.day - b.day), vocab };
    const detail = `7 days of ${input.minutesPerDay} min, ${vocab.length} starter words${dropped ? ` (${dropped} day${dropped === 1 ? "" : "s"} filled in automatically)` : ""}`;
    return { value, detail };
  });

  if (trace.some((t) => t.status === "fallback")) {
    warnings.push("The AI model was unavailable for part of this run, so some levels, the plan or the word list come from simple rules and are rough");
  }
  return { mode: deps.mode, seeds: resolvedSeeds, profile, picks, plan, vocab, trace, warnings };
}
