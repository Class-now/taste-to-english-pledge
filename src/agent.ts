import { explainPick } from "./explain";
import type { Llm } from "./llm";
import { normalizeTitle } from "./mock-qloo";
import { levelPrompt, normalizePrompt, planPrompt, refinePrompt, type LevelCandidate } from "./prompts";
import type { QlooClient } from "./qloo";
import { FORMAT_TYPES, MIN_PICKS, selectPicks, type LevelEstimate } from "./select";
import {
  CEFR_LEVELS,
  ENTITY_TYPES,
  type Cefr,
  type Day,
  type EntityType,
  type Format,
  type Pick,
  type PlanInput,
  type PlanResult,
  type QlooEntity,
  type QlooTag,
  type TraceStep,
  type Vocab,
} from "./types";

export interface AgentDeps {
  qloo: QlooClient;
  llm: Llm;
  mode: "live" | "mock";
  now?: () => number;
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

const STEP_LABELS: Record<string, string> = {
  normalize: "Understanding your favourites",
  resolve: "Finding them in Qloo",
  profile: "Reading your taste profile",
  refine: "Applying your refinement",
  recommend: "Searching English works with Qloo",
  level: "Estimating English level",
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

function fallbackActivity(p: Pick, minutes: number): string {
  if (p.format === "read") return `Read about ${Math.max(2, Math.round(minutes / 3))} pages of "${p.name}"`;
  if (p.format === "listen") return `Listen to one episode of "${p.name}"`;
  return `Watch part of "${p.name}" with English subtitles`;
}

export async function runPlan(input: PlanInput, deps: AgentDeps): Promise<PlanResult> {
  const now = deps.now ?? (() => Date.now());
  const trace: TraceStep[] = [];
  const warnings: string[] = [];

  async function step<T>(id: string, fn: () => Promise<{ value: T; detail: string }>): Promise<T> {
    const start = now();
    const label = STEP_LABELS[id] ?? id;
    try {
      const { value, detail } = await fn();
      trace.push({ id, label, detail, ms: Math.round(now() - start) });
      return value;
    } catch (err) {
      // Only StepFailure messages are written for users; raw upstream errors stay in the logs.
      const message = err instanceof StepFailure ? err.message : FAILURE_MESSAGES[id];
      if (!(err instanceof StepFailure)) console.error(`step ${id} failed:`, err instanceof Error ? err.message : String(err));
      trace.push({ id, label, detail: `Failed: ${message}`, ms: Math.round(now() - start) });
      throw new AgentError(id, message, trace);
    }
  }

  // 1. normalize
  const normalized = await step("normalize", async () => {
    const items = input.favorites.map((f, index) => ({ index, title: f.title, ...(f.type ? { type: f.type } : {}) }));
    const out = await deps.llm.json<{ items?: unknown }>(normalizePrompt(items));
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
  const seeds = await step("resolve", async () => {
    const found: QlooEntity[] = [];
    const lines: string[] = [];
    for (const n of normalized) {
      const names = new Set([normalizeTitle(n.query), normalizeTitle(n.title)]);
      const exact = (results: QlooEntity[]) => results.find((r) => names.has(normalizeTitle(r.name)));
      // Search is fuzzy and the type may be a model guess, so unless the user chose the type, take an
      // exact name match from any pass before falling back to the top untyped hit.
      const typed = n.type ? await deps.qloo.search(n.query, [n.type], 5) : [];
      let hit = exact(typed) ?? (n.typeGiven ? typed[0] : undefined);
      let untyped: QlooEntity[] = [];
      if (!hit) {
        untyped = await deps.qloo.search(n.query, undefined, 5);
        hit = exact(untyped);
      }
      let byTitle: QlooEntity[] = [];
      if (!hit && n.query !== n.title) {
        byTitle = await deps.qloo.search(n.title, undefined, 5);
        hit = exact(byTitle);
      }
      hit ??= untyped[0] ?? typed[0] ?? byTitle[0];
      if (!hit) {
        warnings.push(`Couldn't find "${n.title}"`);
        lines.push(`"${n.title}" → not found`);
      } else if (!found.some((e) => e.id === hit.id)) {
        found.push(hit);
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
    const tags = (await deps.qloo.entityTags(seedIds, 20)).filter((t) => `${t.id} ${t.subtype ?? ""}`.includes(":media"));
    const value = [...tags].sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0)).slice(0, PROFILE_SIZE);
    return { value, detail: value.length ? value.map((t) => t.name).join(", ") : "No taste tags returned" };
  });

  // 3b. refine (optional)
  let tagIds: string[] = [];
  let avoidTags: string[] = [];
  let minYear: number | undefined;
  let maxYear: number | undefined;
  if (input.refine) {
    const refineText = input.refine;
    // Refining is optional: if it fails, keep going with the unrefined plan instead of losing it.
    await step("refine", async () => {
      const out = record(await deps.llm.json<unknown>(refinePrompt(refineText)));
      const add = asArray(out.addTags).filter(isString).map((t) => t.trim()).slice(0, 3);
      avoidTags = asArray(out.avoidTags).filter(isString).map((t) => t.trim().toLowerCase()).slice(0, 3);
      const year = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1800 && (v as number) <= 2100 ? (v as number) : undefined);
      minYear = year(out.minYear);
      maxYear = year(out.maxYear);
      if (minYear !== undefined && maxYear !== undefined && minYear > maxYear) [minYear, maxYear] = [maxYear, minYear];
      const resolved: QlooTag[] = [];
      for (const q of add) {
        // Semantic tag search can return place or brand tags; only media tags make sense as signals.
        const hit = (await deps.qloo.searchTags(q, 5)).find((t) => `${t.id} ${t.subtype ?? ""}`.includes(":media"));
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
          deps.qloo.insights({
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
      // Whole-word match so a short phrase like "war" doesn't also drop "software" or "award".
      const avoidPatterns = (refined ? avoidTags : []).map(
        (a) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
      );
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
    let found = await gather(true);
    let note = "";
    if (found.value.length === 0 && refining) {
      // The refinement filtered everything out; an unrefined plan beats no plan.
      found = await gather(false);
      warnings.push("Nothing matched your refinement, so these are the unrefined picks");
      note = " (refinement matched nothing; unrefined)";
    }
    warnings.push(...found.failed);
    if (found.value.length === 0) {
      throw new StepFailure("Qloo didn't return any English works for these favourites. Try adding another title.");
    }
    return { value: found.value, detail: `Found ${found.counts.join(", ")}${note}` };
  });

  // 5. level
  const picks = await step("level", async () => {
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
    const payload: LevelCandidate[] = capped.map((c) => ({
      id: c.id,
      title: c.name,
      type: c.type,
      ...(c.year ? { year: c.year } : {}),
      ...(c.description ? { description: clip(c.description, 200) } : {}),
      ...(c.pageCount ? { pageCount: c.pageCount } : {}),
    }));
    const rated = new Map<string, LevelEstimate>();
    const collect = (out: unknown) => {
      for (const raw of asArray(record(out).items)) {
        const r = record(raw);
        if (isString(r.id) && !rated.has(r.id) && payload.some((c) => c.id === r.id) && CEFR_LEVELS.includes(r.cefr as Cefr)) {
          rated.set(r.id, { id: r.id, cefr: r.cefr as Cefr, reason: clip(isString(r.reason) ? r.reason.trim() : "", 120) });
        }
      }
    };
    // Small batches keep each answer well inside the token limit; a failed batch keeps what others rated.
    let lastError: unknown;
    const rate = async (batch: LevelCandidate[]) => {
      for (let i = 0; i < batch.length; i += LEVEL_BATCH) {
        try {
          collect(await deps.llm.json<unknown>(levelPrompt(input.level, batch.slice(i, i + LEVEL_BATCH))));
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
    if (rated.size === 0 && lastError) throw lastError;
    const levels = [...rated.values()];
    const value = selectPicks(capped, levels, input.level, input.formats);
    if (value.length === 0) {
      throw new StepFailure("None of the matches fit your English level. Try a different level or more favourites.");
    }
    if (value.length < MIN_PICKS) warnings.push(`Only ${value.length} works matched your level closely`);
    const fits = (f: string) => value.filter((p) => p.fit === f).length;
    return {
      value,
      detail: `Rated ${levels.length} of ${capped.length} works; picked ${value.length} (${fits("match")} at your level, ${fits("stretch")} stretch, ${fits("easier")} easier)`,
    };
  });

  // 6. explain
  await step("explain", async () => {
    for (const p of picks) p.because = explainPick(p, seeds, profile);
    return { value: undefined, detail: picks.map((p) => `${p.name}: ${p.because}`).join("; ") };
  });

  // 7. plan + vocab
  const { plan, vocab } = await step("plan", async () => {
    const out = record(
      await deps.llm.json<unknown>(
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
      if (!isString(d.pickId) || !pickIds.has(d.pickId) || !isString(d.activity)) continue;
      // Day 1 must be the easiest pick: the vocabulary and the UI's "day 1" label refer to it.
      if (day === 1 && d.pickId !== picks[0].id) continue;
      byDay.set(day, { day, pickId: d.pickId, activity: clip(d.activity.trim(), 200), minutes: input.minutesPerDay });
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
      if (isString(v.term) && isString(v.ja) && isString(v.example) && vocab.length < 12) {
        vocab.push({ term: clip(v.term.trim(), 60), ja: clip(v.ja.trim(), 60), example: clip(v.example.trim(), 200) });
      }
    }
    if (vocab.length < 12) warnings.push(`Only ${vocab.length} starter words could be written this time`);
    const value = { plan: [...byDay.values()].sort((a, b) => a.day - b.day), vocab };
    const detail = `7 days of ${input.minutesPerDay} min, ${vocab.length} starter words${dropped ? ` (${dropped} day${dropped === 1 ? "" : "s"} filled in automatically)` : ""}`;
    return { value, detail };
  });

  return { mode: deps.mode, profile, picks, plan, vocab, trace, warnings };
}
