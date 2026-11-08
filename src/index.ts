import { AgentError, runPlan, type AgentDeps } from "./agent";
import { CachedQlooClient } from "./cache";
import { RuleBasedLlm } from "./fallback-llm";
import { ResilientLlm, WorkersAiLlm, type Llm } from "./llm";
import { MockQlooClient } from "./mock-qloo";
import { createQlooClient, qlooMode } from "./qloo";
import { checkRateLimit } from "./ratelimit";
import type { AgentEvent, PlanInput } from "./types";
import { parsePlanInput } from "./validate";
import { HttpPayPalClient, SANDBOX_BASE, SimulatedPayPalClient } from "./paypal";
import {
  KvPledgeStore,
  MemoryPledgeStore,
  PledgeError,
  cancelApproval,
  completeApproval,
  createPledge,
  getPledge,
  parseCreateInput,
  settle,
  skipDay,
  startQuiz,
  submitAnswers,
  view,
  type PledgeDeps,
} from "./pledge";
import { PledgeRulesLlm } from "./pledge-ai";

export interface Env {
  /** Workers AI. When missing (or failing) the rule-based fallback answers instead. */
  AI?: Ai;
  ASSETS: Fetcher;
  QLOO_BASE_URL: string;
  QLOO_API_KEY?: string;
  /** Pledge records. Without it (tests, offline dev) pledges live in memory. */
  PLEDGES?: KVNamespace;
  /** PayPal sandbox REST app. Without both, pledges use a clearly labelled simulated client. */
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_BASE_URL?: string;
}

const memoryPledges = new MemoryPledgeStore();

function makePledgeDeps(env: Env): PledgeDeps {
  const paypal =
    env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
      ? new HttpPayPalClient(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET, env.PAYPAL_BASE_URL || SANDBOX_BASE)
      : new SimulatedPayPalClient();
  const rules = new PledgeRulesLlm();
  return {
    store: env.PLEDGES ? new KvPledgeStore(env.PLEDGES) : memoryPledges,
    paypal,
    llm: env.AI ? new ResilientLlm(new WorkersAiLlm(env.AI), rules) : rules,
  };
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

async function readJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new PledgeError("Request body is too large.", 413);
  const text = await readBodyLimited(request, MAX_BODY_BYTES);
  if (text === null) throw new PledgeError("Request body is too large.", 413);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new PledgeError("Request body must be valid JSON.");
  }
}

async function handlePledge(request: Request, env: Env, url: URL): Promise<Response> {
  const deps = makePledgeDeps(env);
  const parts = url.pathname.split("/").filter(Boolean); // ["api","pledges",id?,...]
  const [, , id, action, n, sub] = parts;
  const method = request.method;
  try {
    if (!id) {
      if (method !== "POST") return json({ error: "Use POST to create a pledge." }, 405);
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const limit = await checkRateLimit(`pledge:${ip}`);
      if (!limit.allowed) return json({ error: "Too many pledges this hour, try again later." }, 429);
      const p = await createPledge(parseCreateInput(await readJson(request)), url.origin, deps);
      return json(view(p), p.status === "error" ? 502 : 201);
    }
    if (!action && method === "GET") return json(view(await getPledge(id, deps)));
    if (action === "return" && method === "GET") {
      try {
        await completeApproval(id, url.searchParams.get("token"), deps);
        return redirect(`/?pledge=${encodeURIComponent(id)}`);
      } catch (err) {
        if (err instanceof PledgeError && err.status === 404) throw err;
        return redirect(`/?pledge=${encodeURIComponent(id)}&error=approve`);
      }
    }
    if (action === "cancel" && method === "GET") {
      await cancelApproval(id, deps);
      return redirect(`/?pledge=${encodeURIComponent(id)}`);
    }
    if (action === "settle" && method === "POST") return json(view(await settle(id, deps)));
    if (action === "days" && n && method === "POST") {
      const day = Number(n);
      if (sub === "quiz") return json(view(await startQuiz(id, day, deps)));
      if (sub === "skip") return json(view(await skipDay(id, day, deps)));
      if (sub === "answers") {
        const body = (await readJson(request)) as { answers?: unknown };
        return json(view(await submitAnswers(id, day, body.answers, deps)));
      }
    }
    return json({ error: "Not found" }, 404);
  } catch (err) {
    if (err instanceof PledgeError) return json({ error: err.message }, err.status);
    console.error("pledge failed:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return json({ error: "Something went wrong" }, 500);
  }
}

const MAX_BODY_BYTES = 8 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Reads at most `max` bytes of the body; null when it is longer (a chunked body has no content-length). */
async function readBodyLimited(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function handlePlan(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // The largest valid body is well under 2 KB; refuse big ones before parsing.
  const tooLarge = () => json({ error: "Request body is too large." }, 413);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return tooLarge();
  const text = await readBodyLimited(request, MAX_BODY_BYTES);
  if (text === null) return tooLarge();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }
  const parsed = parsePlanInput(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  // Demo runs make no Qloo calls, so they get their own allowance instead of eating into the live one.
  const limit = await checkRateLimit(parsed.value.demo ? `demo:${ip}` : ip);
  if (!limit.allowed) return json({ error: "Too many plans this hour, try again later." }, 429);

  try {
    const mode = parsed.value.demo ? "mock" : qlooMode(env);
    const deps: AgentDeps = {
      // Demo runs use the hand-written sample set even when a key is configured.
      qloo: new CachedQlooClient(parsed.value.demo ? new MockQlooClient() : createQlooClient(env), undefined, `v2-${mode}`),
      llm: makeLlm(env),
      mode,
    };
    if ((request.headers.get("accept") ?? "").includes("application/x-ndjson")) {
      return streamPlan(parsed.value, deps, ctx);
    }
    return json(await runPlan(parsed.value, deps));
  } catch (err) {
    if (err instanceof AgentError) return json({ error: err.message, step: err.step, trace: err.trace }, 502);
    console.error("plan failed:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return json({ error: "Something went wrong" }, 500);
  }
}

function makeLlm(env: Env): Llm {
  const rules = new RuleBasedLlm();
  return env.AI ? new ResilientLlm(new WorkersAiLlm(env.AI), rules) : rules;
}

/** Streams the agent's events as NDJSON so the page can show each step and tool call as it happens. */
function streamPlan(input: PlanInput, deps: AgentDeps, ctx: ExecutionContext): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const gone = new AbortController();
  const send = (e: AgentEvent) => {
    if (gone.signal.aborted) return;
    // A client that went away makes writes reject; stop writing and stop the run before its next step.
    writer.write(encoder.encode(`${JSON.stringify(e)}\n`)).catch(() => gone.abort());
  };
  const run = (async () => {
    try {
      const result = await runPlan(input, { ...deps, onEvent: send, signal: gone.signal });
      send({ type: "result", result });
    } catch (err) {
      if (err instanceof AgentError) {
        send({ type: "error", error: err.message, step: err.step, trace: err.trace });
      } else {
        console.error("plan failed:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
        send({ type: "error", error: "Something went wrong", trace: [] });
      }
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  ctx.waitUntil(run);
  return new Response(readable, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === "/api/health" && request.method === "GET") {
      const paypal = env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET ? "sandbox" : "simulated";
      return json({ ok: true, mode: qlooMode(env), paypal, storage: env.PLEDGES ? "kv" : "memory" });
    }
    if (pathname === "/api/pledges" || pathname.startsWith("/api/pledges/")) {
      return handlePledge(request, env, url);
    }
    if (pathname === "/api/plan") {
      if (request.method !== "POST") return json({ error: "Use POST for /api/plan." }, 405);
      return handlePlan(request, env, ctx);
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
