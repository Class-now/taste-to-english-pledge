import { AgentError, runPlan, type AgentDeps } from "./agent";
import { CachedQlooClient } from "./cache";
import { RuleBasedLlm } from "./fallback-llm";
import { ResilientLlm, WorkersAiLlm, type Llm } from "./llm";
import { MockQlooClient } from "./mock-qloo";
import { createQlooClient, qlooMode } from "./qloo";
import { checkRateLimit } from "./ratelimit";
import type { AgentEvent, PlanInput } from "./types";
import { parsePlanInput } from "./validate";

export interface Env {
  /** Workers AI. When missing (or failing) the rule-based fallback answers instead. */
  AI?: Ai;
  ASSETS: Fetcher;
  QLOO_BASE_URL: string;
  QLOO_API_KEY?: string;
}

const MAX_BODY_BYTES = 8 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handlePlan(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // The largest valid body is well under 2 KB; refuse big ones before parsing.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return json({ error: "Request body is too large." }, 413);
  }
  let body: unknown;
  try {
    body = await request.json();
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
    const { pathname } = new URL(request.url);
    if (pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, mode: qlooMode(env) });
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
