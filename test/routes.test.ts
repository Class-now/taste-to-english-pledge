import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import type { LlmJsonOptions } from "../src/llm";
import { FakeLlm } from "./fake-llm";
import { resetMemoryCache } from "../src/cache";
import { PLANS_PER_HOUR, resetRateLimits } from "../src/ratelimit";
import { installMemoryCaches, type MemoryCache } from "./memory-cache";

/** Fake Workers AI binding: routes each `run` through FakeLlm so WorkersAiLlm is exercised for real. */
function fakeAi(llm = new FakeLlm(), asString = false) {
  return {
    async run(_model: string, inputs: { messages: { content: string }[]; response_format: { json_schema: object } }) {
      const opts: LlmJsonOptions = {
        system: inputs.messages[0].content,
        user: inputs.messages[1].content,
        schema: inputs.response_format.json_schema,
      };
      const response = await llm.json(opts);
      return { response: asString ? JSON.stringify(response) : response };
    },
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: fakeAi() as unknown as Ai,
    ASSETS: { fetch: async () => new Response("<!doctype html>asset", { headers: { "content-type": "text/html" } }) } as unknown as Fetcher,
    QLOO_BASE_URL: "https://hackathon.api.qloo.com",
    ...overrides,
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const validBody = {
  favorites: [{ title: "千と千尋の神隠し" }, { title: "ペルソナ5" }, { title: "ノルウェイの森" }],
  level: "B1",
  minutesPerDay: 20,
  formats: ["read", "listen", "watch"],
};

function plan(body: unknown, ip = "203.0.113.7", raw?: string) {
  return new Request("https://example.com/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
    body: raw ?? JSON.stringify(body),
  });
}

let cache: MemoryCache;
beforeEach(() => {
  cache = installMemoryCaches();
  resetRateLimits();
  resetMemoryCache();
});
afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
  vi.restoreAllMocks();
});

describe("worker routes", () => {
  it("GET /api/health reports mock mode without a key", async () => {
    const res = await worker.fetch(new Request("https://example.com/api/health"), makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, mode: "mock", paypal: "simulated", storage: "memory" });
  });

  it("GET /api/health reports live mode with a key", async () => {
    const res = await worker.fetch(new Request("https://example.com/api/health"), makeEnv({ QLOO_API_KEY: "k" }), ctx);
    expect(await res.json()).toEqual({ ok: true, mode: "live", paypal: "simulated", storage: "memory" });
  });

  it("POST /api/plan returns a plan with picks", async () => {
    const res = await worker.fetch(plan(validBody), makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { mode: string; picks: unknown[]; plan: unknown[]; vocab: unknown[]; trace: unknown[] };
    expect(body.mode).toBe("mock");
    expect(body.picks.length).toBeGreaterThanOrEqual(6);
    expect(body.picks.length).toBeLessThanOrEqual(9);
    expect(body.plan).toHaveLength(7);
    expect(body.vocab).toHaveLength(12);
    expect(body.trace.length).toBeGreaterThan(0);
  });

  it("handles string responses from Workers AI and caches Qloo results without the key", async () => {
    const res = await worker.fetch(plan(validBody), makeEnv({ AI: fakeAi(new FakeLlm(), true) as unknown as Ai }), ctx);
    expect(res.status).toBe(200);
    const keys = [...cache.store.keys()].filter((k) => k.startsWith("https://qloo-cache.local/"));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((k) => k.includes("/v2-mock/search"))).toBe(true);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await worker.fetch(plan(undefined, undefined, "{not json"), makeEnv(), ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/JSON/);
  });

  it("returns 413 for a body over 8 KB, with or without content-length", async () => {
    const big = JSON.stringify({ ...validBody, refine: "x".repeat(9000) });
    const bytes = new TextEncoder().encode(big);
    const withLength = new Request("https://example.com/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(bytes.length), "CF-Connecting-IP": "203.0.113.7" },
      body: big,
    });
    expect((await worker.fetch(withLength, makeEnv(), ctx)).status).toBe(413);
    const chunked = new Request("https://example.com/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
      body: new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < bytes.length; i += 1024) c.enqueue(bytes.slice(i, i + 1024));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(chunked.headers.get("content-length")).toBeNull();
    const res = await worker.fetch(chunked, makeEnv(), ctx);
    expect(res.status).toBe(413);
  });

  it("returns 400 for an invalid body", async () => {
    const res = await worker.fetch(plan({ ...validBody, level: "Z9" }), makeEnv(), ctx);
    expect(res.status).toBe(400);
    expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
  });

  it("returns 429 once an IP has used its hourly plans", async () => {
    const env = makeEnv();
    for (let i = 0; i < PLANS_PER_HOUR; i++) {
      const res = await worker.fetch(plan(validBody, "198.51.100.1"), env, ctx);
      expect(res.status).toBe(200);
    }
    const res = await worker.fetch(plan(validBody, "198.51.100.1"), env, ctx);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too many plans this hour, try again later." });
    // Another IP is unaffected.
    expect((await worker.fetch(plan(validBody, "198.51.100.2"), env, ctx)).status).toBe(200);
  });

  it("returns 502 with step and trace on AgentError", async () => {
    const body = { ...validBody, favorites: [{ title: "zzz nothing matches this" }] };
    const res = await worker.fetch(plan(body), makeEnv(), ctx);
    expect(res.status).toBe(502);
    const out = (await res.json()) as { error: string; step: string; trace: unknown[] };
    expect(out.step).toBe("resolve");
    expect(out.trace.length).toBeGreaterThan(0);
  });

  it("returns 500 without leaking details on unexpected errors", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://example.com/api/plan", {
        method: "POST",
        headers: { "CF-Connecting-IP": "192.0.2.9" },
        body: JSON.stringify(validBody),
      }),
      { ...env, get QLOO_API_KEY(): string { throw new Error("secret-ish detail"); } } as Env,
      ctx,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Something went wrong" });
    expect(err).toHaveBeenCalled();
  });

  it("returns 404 JSON for unknown API paths", async () => {
    const res = await worker.fetch(new Request("https://example.com/api/nope"), makeEnv(), ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("serves non-API paths from assets", async () => {
    const res = await worker.fetch(new Request("https://example.com/"), makeEnv(), ctx);
    expect(await res.text()).toContain("asset");
  });

  it("streams NDJSON agent events ending with the result when asked", async () => {
    const req = plan(validBody);
    req.headers.set("accept", "application/x-ndjson");
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { type: string; [k: string]: unknown });
    expect(lines[0].type).toBe("start");
    expect(lines.some((l) => l.type === "call")).toBe(true);
    expect(lines.filter((l) => l.type === "step").length).toBe(9 - 1); // no refine step
    const last = lines[lines.length - 1] as { type: string; result: { picks: unknown[]; seeds: unknown[] } };
    expect(last.type).toBe("result");
    expect(last.result.picks.length).toBeGreaterThanOrEqual(6);
    expect(last.result.seeds).toHaveLength(3);
  });

  it("streams an error event (not a 502) when a step fails mid-stream", async () => {
    const req = plan({ ...validBody, favorites: [{ title: "zzz nothing matches this" }] });
    req.headers.set("accept", "application/x-ndjson");
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { type: string; step?: string; error?: string });
    const last = lines[lines.length - 1];
    expect(last).toMatchObject({ type: "error", step: "resolve" });
    expect(last.error).toMatch(/couldn't find any of these titles/);
  });

  it("keeps validation and rate-limit errors as plain JSON on the streaming path", async () => {
    const req = plan({ ...validBody, level: "Z9" });
    req.headers.set("accept", "application/x-ndjson");
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("uses the sample data for demo runs even when a key is set, without calling Qloo", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await worker.fetch(plan({ ...validBody, demo: true }), makeEnv({ QLOO_API_KEY: "k" }), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; picks: unknown[] };
    expect(body.mode).toBe("mock");
    expect(body.picks.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still builds a plan with rule-based answers when Workers AI is missing or failing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { async run() { throw new Error("not logged in"); } } as unknown as Ai;
    for (const env of [makeEnv({ AI: undefined }), makeEnv({ AI: broken })]) {
      resetMemoryCache();
      const res = await worker.fetch(plan(validBody, `192.0.2.${env.AI ? 1 : 2}`), env, ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { plan: unknown[]; trace: { status?: string }[]; warnings: string[] };
      expect(body.plan).toHaveLength(7);
      expect(body.trace.some((t) => t.status === "fallback")).toBe(true);
      expect(body.warnings.some((w) => /simple rules/.test(w))).toBe(true);
    }
  });
});
