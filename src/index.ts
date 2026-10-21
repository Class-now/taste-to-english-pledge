import { AgentError, runPlan } from "./agent";
import { CachedQlooClient } from "./cache";
import { WorkersAiLlm } from "./llm";
import { createQlooClient, qlooMode } from "./qloo";
import { checkRateLimit } from "./ratelimit";
import { parsePlanInput } from "./validate";

export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  QLOO_BASE_URL: string;
  QLOO_API_KEY?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handlePlan(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }
  const parsed = parsePlanInput(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = await checkRateLimit(ip);
  if (!limit.allowed) return json({ error: "Too many plans this hour, try again later." }, 429);

  try {
    const mode = qlooMode(env);
    const result = await runPlan(parsed.value, {
      qloo: new CachedQlooClient(createQlooClient(env), undefined, mode),
      llm: new WorkersAiLlm(env.AI),
      mode,
    });
    return json(result);
  } catch (err) {
    if (err instanceof AgentError) return json({ error: err.message, step: err.step, trace: err.trace }, 502);
    console.error("plan failed:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return json({ error: "Something went wrong" }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, mode: qlooMode(env) });
    }
    if (pathname === "/api/plan") {
      if (request.method !== "POST") return json({ error: "Use POST for /api/plan." }, 405);
      return handlePlan(request, env);
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
