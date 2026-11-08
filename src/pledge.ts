// The study pledge: a learner turns a 7-day plan into a promise backed by a PayPal authorization.
// Each day the AI tutor quizzes them on what they read/heard and grades the answers. At the end the
// settlement agent voids the hold (all days done) or captures the missed days' share for a cause.

import type { Llm, LlmSource } from "./llm";
import {
  cleanGrade,
  gradePrompt,
  quizPrompt,
  ruleSettle,
  settlePrompt,
  validQuestions,
  type Grade,
  type QuizQuestion,
  type SettleDecision,
  type SettleInput,
} from "./pledge-ai";
import { PayPalError, usd, type PayPalCall, type PayPalClient } from "./paypal";

export const PLEDGE_DAYS = 7;
export const PER_DAY_OPTIONS = [1, 2] as const;
export const CAUSE = "a children's literacy charity (sandbox)";
export const MAX_ATTEMPTS = 2;

export type DayStatus = "locked" | "open" | "passed" | "failed" | "missed";

export interface PledgeDay {
  day: number;
  title: string;
  format: string;
  activity: string;
  minutes: number;
  description?: string;
  status: DayStatus;
  attempts: number;
  quiz?: QuizQuestion[];
  quizSource?: LlmSource;
  answers?: string[];
  grade?: Grade & { source: LlmSource };
}

export interface LedgerEntry {
  at: string;
  /** Who acted: the learner, the AI tutor, the settlement agent, the policy guardrail, or PayPal. */
  actor: "learner" | "tutor" | "agent" | "guardrail" | "paypal";
  text: string;
  calls?: PayPalCall[];
}

export type PledgeStatus = "awaiting_approval" | "active" | "settled" | "cancelled" | "error";

export interface Pledge {
  id: string;
  createdAt: string;
  level: string;
  perDayUsd: number;
  pledgeUsd: number;
  cause: string;
  paypalMode: "sandbox" | "simulated";
  status: PledgeStatus;
  orderId?: string;
  approveUrl?: string;
  authorizationId?: string;
  authorizationExpires?: string;
  days: PledgeDay[];
  ledger: LedgerEntry[];
  settlement?: {
    decision: SettleDecision;
    source: LlmSource;
    overridden: boolean;
    capturedUsd: number;
    releasedUsd: number;
    captureId?: string;
    paypalStatus: string;
  };
}

export class PledgeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "PledgeError";
  }
}

// ---------- storage ----------

export interface PledgeStore {
  get(id: string): Promise<Pledge | null>;
  put(p: Pledge): Promise<void>;
}

const TTL_SECONDS = 60 * 60 * 24 * 45;

export class KvPledgeStore implements PledgeStore {
  constructor(private readonly kv: KVNamespace) {}
  async get(id: string) {
    return (await this.kv.get<Pledge>(`pledge:${id}`, "json")) ?? null;
  }
  async put(p: Pledge) {
    await this.kv.put(`pledge:${p.id}`, JSON.stringify(p), { expirationTtl: TTL_SECONDS });
  }
}

export class MemoryPledgeStore implements PledgeStore {
  readonly map = new Map<string, string>();
  async get(id: string) {
    const v = this.map.get(id);
    return v ? (JSON.parse(v) as Pledge) : null;
  }
  async put(p: Pledge) {
    this.map.set(p.id, JSON.stringify(p));
  }
}

// ---------- helpers ----------

export interface PledgeDeps {
  store: PledgeStore;
  paypal: PayPalClient;
  llm: Llm;
  now?: () => Date;
  newId?: () => string;
}

function nowIso(deps: PledgeDeps) {
  return (deps.now?.() ?? new Date()).toISOString();
}

function log(p: Pledge, deps: PledgeDeps, actor: LedgerEntry["actor"], text: string, calls?: PayPalCall[]) {
  const e: LedgerEntry = { at: nowIso(deps), actor, text };
  if (calls && calls.length) e.calls = calls;
  p.ledger.push(e);
}

/** PayPal calls made since `from` (the client keeps a running list). */
function callsSince(deps: PledgeDeps, from: number): PayPalCall[] {
  return deps.paypal.calls.slice(from);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function ledgerOf(p: Pledge) {
  const completed = p.days.filter((d) => d.status === "passed").length;
  const missed = p.days.length - completed;
  return { completed, missed, owedUsd: round2(missed * p.perDayUsd) };
}

async function load(deps: PledgeDeps, id: string): Promise<Pledge> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new PledgeError("Pledge not found", 404);
  const p = await deps.store.get(id);
  if (!p) throw new PledgeError("Pledge not found", 404);
  return p;
}

function dayOf(p: Pledge, n: number): PledgeDay {
  const d = p.days.find((x) => x.day === n);
  if (!d) throw new PledgeError("No such day", 404);
  return d;
}

function requireActive(p: Pledge) {
  if (p.status === "awaiting_approval") throw new PledgeError("Approve the PayPal hold first.", 409);
  if (p.status !== "active") throw new PledgeError("This pledge is already closed.", 409);
}

/** Opens the next locked day once the current one is finished (hackathon build: no 24-hour wait). */
function unlockNext(p: Pledge) {
  if (p.days.some((d) => d.status === "open")) return;
  const next = p.days.find((d) => d.status === "locked");
  if (next) next.status = "open";
}

function publicError(err: unknown): string {
  if (err instanceof PayPalError) return `${err.message}${err.debugId ? ` (debug id ${err.debugId})` : ""}`;
  return "unexpected error";
}

// ---------- input ----------

export interface CreatePledgeInput {
  level: string;
  perDayUsd: number;
  /** "paypal" = approve the hold in PayPal Checkout; "test-card" = sandbox test card, no buyer login. */
  funding: "paypal" | "test-card";
  days: { day: number; title: string; format: string; activity: string; minutes: number; description?: string }[];
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function parseCreateInput(body: unknown): CreatePledgeInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const perDayUsd = Number(b.perDayUsd);
  if (!PER_DAY_OPTIONS.includes(perDayUsd as 1 | 2)) throw new PledgeError("perDayUsd must be 1 or 2.");
  if (!Array.isArray(b.days) || b.days.length !== PLEDGE_DAYS) throw new PledgeError(`A pledge needs a ${PLEDGE_DAYS}-day plan.`);
  const days = b.days.map((raw, i) => {
    const d = (raw ?? {}) as Record<string, unknown>;
    const title = str(d.title, 120);
    const activity = str(d.activity, 300);
    if (!title || !activity) throw new PledgeError(`Day ${i + 1} needs a title and an activity.`);
    const format = ["read", "listen", "watch"].includes(String(d.format)) ? String(d.format) : "read";
    const minutes = Math.max(5, Math.min(90, Math.round(Number(d.minutes) || 20)));
    const out: CreatePledgeInput["days"][number] = { day: i + 1, title, format, activity, minutes };
    const description = str(d.description, 500);
    if (description) out.description = description;
    return out;
  });
  const level = ["A2", "B1", "B2", "C1"].includes(String(b.level)) ? String(b.level) : "B1";
  const funding = b.funding === "test-card" ? "test-card" : "paypal";
  return { level, perDayUsd, funding, days };
}

// ---------- actions ----------

export async function createPledge(input: CreatePledgeInput, origin: string, deps: PledgeDeps): Promise<Pledge> {
  const id = deps.newId?.() ?? crypto.randomUUID();
  const pledgeUsd = round2(input.perDayUsd * PLEDGE_DAYS);
  const p: Pledge = {
    id,
    createdAt: nowIso(deps),
    level: input.level,
    perDayUsd: input.perDayUsd,
    pledgeUsd,
    cause: CAUSE,
    paypalMode: deps.paypal.mode,
    status: "awaiting_approval",
    days: input.days.map((d) => ({ ...d, status: "locked" as DayStatus, attempts: 0 })),
    ledger: [],
  };
  log(p, deps, "learner", `Pledged $${pledgeUsd.toFixed(2)} ($${input.perDayUsd.toFixed(2)} per day) on a ${PLEDGE_DAYS}-day plan.`);
  const from = deps.paypal.calls.length;
  if (input.funding === "test-card") {
    try {
      const auth = await deps.paypal.createCardAuthorization({
        amount: usd(pledgeUsd),
        description: `7-day English study pledge: $${input.perDayUsd} per missed day goes to charity`,
        customId: id,
        requestId: `create-${id}`,
      });
      p.orderId = auth.orderId;
      p.authorizationId = auth.authorizationId;
      p.authorizationExpires = auth.expiresAt;
      p.status = "active";
      p.days[0].status = "open";
      log(
        p,
        deps,
        "paypal",
        `Order ${auth.orderId} (intent AUTHORIZE, sandbox test card) → hold placed: authorization ${auth.authorizationId} for $${auth.amount.value} (${auth.status}). No money has moved.`,
        callsSince(deps, from),
      );
    } catch (err) {
      console.error("card authorization failed:", err);
      p.status = "error";
      log(p, deps, "paypal", `Could not place the hold: ${publicError(err)}`, callsSince(deps, from));
    }
    await deps.store.put(p);
    return p;
  }
  try {
    const order = await deps.paypal.createAuthorizeOrder({
      amount: usd(pledgeUsd),
      description: `7-day English study pledge: $${input.perDayUsd} per missed day goes to charity`,
      customId: id,
      returnUrl: `${origin}/api/pledges/${id}/return`,
      cancelUrl: `${origin}/api/pledges/${id}/cancel`,
      requestId: `create-${id}`,
    });
    p.orderId = order.orderId;
    p.approveUrl = order.approveUrl;
    log(p, deps, "paypal", `Order ${order.orderId} created with intent AUTHORIZE (${order.status}). Waiting for the learner to approve the hold.`, callsSince(deps, from));
  } catch (err) {
    console.error("create order failed:", err);
    p.status = "error";
    log(p, deps, "paypal", `Could not create the PayPal order: ${publicError(err)}`, callsSince(deps, from));
  }
  await deps.store.put(p);
  return p;
}

/** PayPal sends the learner back here after they approve; we authorize the order (the money is held, not taken). */
export async function completeApproval(id: string, token: string | null, deps: PledgeDeps): Promise<Pledge> {
  const p = await load(deps, id);
  if (p.status !== "awaiting_approval") return p;
  if (!token || token !== p.orderId) throw new PledgeError("This approval link does not match the pledge.", 400);
  const from = deps.paypal.calls.length;
  try {
    const auth = await deps.paypal.authorizeOrder(token, `authorize-${id}`);
    p.authorizationId = auth.authorizationId;
    p.authorizationExpires = auth.expiresAt;
    p.status = "active";
    p.days[0].status = "open";
    log(
      p,
      deps,
      "paypal",
      `Hold placed: authorization ${auth.authorizationId} for $${auth.amount.value} (${auth.status}${auth.expiresAt ? `, valid until ${auth.expiresAt.slice(0, 10)}` : ""}). No money has moved.`,
      callsSince(deps, from),
    );
  } catch (err) {
    console.error("authorize failed:", err);
    log(p, deps, "paypal", `Authorization failed: ${publicError(err)}`, callsSince(deps, from));
    await deps.store.put(p);
    throw new PledgeError("PayPal could not place the hold. Please try again.", 502);
  }
  await deps.store.put(p);
  return p;
}

export async function cancelApproval(id: string, deps: PledgeDeps): Promise<Pledge> {
  const p = await load(deps, id);
  if (p.status === "awaiting_approval") {
    p.status = "cancelled";
    log(p, deps, "learner", "Cancelled at PayPal before approving. Nothing was held.");
    await deps.store.put(p);
  }
  return p;
}

export async function getPledge(id: string, deps: PledgeDeps): Promise<Pledge> {
  return load(deps, id);
}

export async function startQuiz(id: string, n: number, deps: PledgeDeps): Promise<Pledge> {
  const p = await load(deps, id);
  requireActive(p);
  const d = dayOf(p, n);
  if (d.status !== "open") throw new PledgeError("This day is not open.", 409);
  if (d.quiz) return p;
  const out = await deps.llm.json<unknown>(
    quizPrompt({ day: d.day, title: d.title, format: d.format, activity: d.activity, description: d.description, level: p.level }),
  );
  const qs = validQuestions(out);
  if (!qs) throw new PledgeError("The tutor could not write today's questions. Try again.", 502);
  d.quiz = qs;
  d.quizSource = deps.llm.lastSource ?? "workers-ai";
  log(p, deps, "tutor", `Wrote day ${d.day}'s check-in questions about "${d.title}".`);
  await deps.store.put(p);
  return p;
}

export async function submitAnswers(id: string, n: number, answers: unknown, deps: PledgeDeps): Promise<Pledge> {
  const p = await load(deps, id);
  requireActive(p);
  const d = dayOf(p, n);
  if (d.status !== "open" || !d.quiz) throw new PledgeError("Start today's check-in first.", 409);
  if (!Array.isArray(answers) || answers.length !== d.quiz.length) throw new PledgeError("Answer all three questions.");
  const clean = answers.map((a) => str(a, 800));
  if (clean.some((a) => !a)) throw new PledgeError("Answer all three questions.");
  d.answers = clean;
  d.attempts += 1;
  const out = await deps.llm.json<unknown>(
    gradePrompt({
      title: d.title,
      format: d.format,
      activity: d.activity,
      description: d.description,
      level: p.level,
      qa: d.quiz.map((q, i) => ({ q: q.q, kind: q.kind, answer: clean[i] })),
    }),
  );
  const grade = { ...cleanGrade(out), source: deps.llm.lastSource ?? ("workers-ai" as LlmSource) };
  d.grade = grade;
  log(p, deps, "learner", `Answered day ${d.day}'s check-in (attempt ${d.attempts}).`);
  if (grade.passed) {
    d.status = "passed";
    log(p, deps, "tutor", `Day ${d.day} passed with ${grade.score}/100. $${p.perDayUsd.toFixed(2)} of the hold is safe.`);
    unlockNext(p);
  } else if (d.attempts >= MAX_ATTEMPTS) {
    d.status = "failed";
    log(p, deps, "tutor", `Day ${d.day} failed twice (${grade.score}/100). It counts as missed.`);
    unlockNext(p);
  } else {
    log(p, deps, "tutor", `Day ${d.day} scored ${grade.score}/100, below the pass mark. One more try allowed.`);
  }
  await deps.store.put(p);
  return p;
}

export async function skipDay(id: string, n: number, deps: PledgeDeps): Promise<Pledge> {
  const p = await load(deps, id);
  requireActive(p);
  const d = dayOf(p, n);
  if (d.status !== "open") throw new PledgeError("This day is not open.", 409);
  d.status = "missed";
  log(p, deps, "learner", `Skipped day ${d.day}. $${p.perDayUsd.toFixed(2)} will go to ${p.cause}.`);
  unlockNext(p);
  await deps.store.put(p);
  return p;
}

/** The guardrail: the only amounts PayPal will ever be asked to capture come from the ledger. */
export function guardDecision(p: Pledge, proposed: SettleDecision): { decision: SettleDecision; overridden: boolean; why?: string } {
  const { missed, owedUsd } = ledgerOf(p);
  const expectedAction: SettleDecision["action"] = missed === 0 ? "void" : owedUsd >= p.pledgeUsd ? "full_capture" : "partial_capture";
  const amountOk = Math.abs(round2(Number(proposed.captureUsd) || 0) - owedUsd) < 0.005;
  if (proposed.action === expectedAction && amountOk) {
    return { decision: { ...proposed, captureUsd: owedUsd }, overridden: false };
  }
  const fallback = ruleSettle(settleInputOf(p));
  return {
    decision: { ...fallback, message: proposed.message || fallback.message },
    overridden: true,
    why: `Agent proposed ${proposed.action} $${Number(proposed.captureUsd || 0).toFixed(2)}, but the ledger says ${expectedAction} $${owedUsd.toFixed(2)}. The ledger wins.`,
  };
}

function settleInputOf(p: Pledge): SettleInput {
  return {
    pledgeUsd: p.pledgeUsd,
    perDayUsd: p.perDayUsd,
    cause: p.cause,
    days: p.days.map((d) => ({ day: d.day, title: d.title, status: d.status, score: d.grade?.score })),
    ledger: ledgerOf(p),
  };
}

export async function settle(id: string, deps: PledgeDeps): Promise<Pledge> {
  const p = await load(deps, id);
  requireActive(p);
  if (p.days.some((d) => d.status === "open" || d.status === "locked")) {
    throw new PledgeError("Finish or skip every day before settling.", 409);
  }
  if (!p.authorizationId) throw new PledgeError("No PayPal hold to settle.", 409);

  const raw = await deps.llm.json<SettleDecision>(settlePrompt(settleInputOf(p)));
  const source = deps.llm.lastSource ?? "workers-ai";
  const proposed: SettleDecision = {
    action: raw?.action,
    captureUsd: Number(raw?.captureUsd) || 0,
    reasoning: str(raw?.reasoning, 600),
    message: str(raw?.message, 300),
  };
  log(p, deps, "agent", `Proposed ${proposed.action}${proposed.captureUsd ? ` of $${proposed.captureUsd.toFixed(2)}` : ""}: ${proposed.reasoning}`);
  const guarded = guardDecision(p, proposed);
  if (guarded.overridden) log(p, deps, "guardrail", guarded.why!);
  else log(p, deps, "guardrail", "Checked the proposal against the ledger: approved.");

  const d = guarded.decision;
  const from = deps.paypal.calls.length;
  try {
    if (d.action === "void") {
      const r = await deps.paypal.voidAuthorization(p.authorizationId);
      p.settlement = { decision: d, source, overridden: guarded.overridden, capturedUsd: 0, releasedUsd: p.pledgeUsd, paypalStatus: r.status };
      log(p, deps, "paypal", `Authorization ${p.authorizationId} voided. The full $${p.pledgeUsd.toFixed(2)} hold is released.`, callsSince(deps, from));
    } else {
      const c = await deps.paypal.captureAuthorization(p.authorizationId, usd(d.captureUsd), d.message, `capture-${p.id}`);
      const captured = Number(c.amount.value);
      p.settlement = {
        decision: d,
        source,
        overridden: guarded.overridden,
        capturedUsd: captured,
        releasedUsd: round2(p.pledgeUsd - captured),
        captureId: c.captureId,
        paypalStatus: c.status,
      };
      log(
        p,
        deps,
        "paypal",
        `Captured $${captured.toFixed(2)} (capture ${c.captureId}, ${c.status}) for ${p.cause}; final_capture released the remaining $${round2(p.pledgeUsd - captured).toFixed(2)}.`,
        callsSince(deps, from),
      );
    }
    p.status = "settled";
  } catch (err) {
    console.error("settle failed:", err);
    log(p, deps, "paypal", `Settlement call failed: ${publicError(err)}`, callsSince(deps, from));
    await deps.store.put(p);
    throw new PledgeError("PayPal could not settle the hold. Please try again.", 502);
  }
  await deps.store.put(p);
  return p;
}

/** Strip what the browser does not need (the approve URL only matters before approval). */
export function view(p: Pledge) {
  const { approveUrl, ...rest } = p;
  return { ...rest, approveUrl: p.status === "awaiting_approval" ? approveUrl : undefined, summary: ledgerOf(p) };
}
