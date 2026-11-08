import { describe, expect, it } from "vitest";
import type { Llm, LlmJsonOptions } from "../src/llm";
import { HttpPayPalClient, SimulatedPayPalClient } from "../src/paypal";
import {
  MemoryPledgeStore,
  PledgeError,
  completeApproval,
  createPledge,
  guardDecision,
  parseCreateInput,
  settle,
  skipDay,
  startQuiz,
  submitAnswers,
  type PledgeDeps,
} from "../src/pledge";
import { PledgeRulesLlm, ruleGrade } from "../src/pledge-ai";

const days = Array.from({ length: 7 }, (_, i) => ({
  day: i + 1,
  title: `Book ${i + 1}`,
  format: "read",
  activity: "Read chapter one",
  minutes: 20,
}));

const GOOD = [
  "The girl moves to a new town with her parents and finds a strange tunnel near the forest road.",
  "I liked the moment when she meets the dragon because the writer describes his eyes very clearly.",
  "Whisper: She whispered the secret to her friend so the teacher could not hear it.",
];

function deps(llm: Llm = new PledgeRulesLlm()): PledgeDeps & { paypal: SimulatedPayPalClient } {
  let n = 0;
  return {
    store: new MemoryPledgeStore(),
    paypal: new SimulatedPayPalClient(),
    llm,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  };
}

async function activePledge(d: PledgeDeps, perDayUsd = 1) {
  const p = await createPledge(parseCreateInput({ level: "B1", perDayUsd, days }), "https://app.test", d);
  return completeApproval(p.id, p.orderId!, d);
}

async function pass(d: PledgeDeps, id: string, day: number) {
  await startQuiz(id, day, d);
  return submitAnswers(id, day, GOOD, d);
}

describe("pledge input", () => {
  it("needs exactly 7 days and a known amount", () => {
    expect(() => parseCreateInput({ perDayUsd: 3, days })).toThrow(PledgeError);
    expect(() => parseCreateInput({ perDayUsd: 1, days: days.slice(0, 3) })).toThrow(PledgeError);
    expect(parseCreateInput({ perDayUsd: 2, days }).days).toHaveLength(7);
  });
});

describe("pledge flow", () => {
  it("creates an AUTHORIZE order and holds it on approval", async () => {
    const d = deps();
    const created = await createPledge(parseCreateInput({ level: "B1", perDayUsd: 1, days }), "https://app.test", d);
    expect(created.status).toBe("awaiting_approval");
    expect(created.approveUrl).toContain("/api/pledges/");
    await expect(completeApproval(created.id, "WRONG", d)).rejects.toThrow(PledgeError);
    const p = await completeApproval(created.id, created.orderId!, d);
    expect(p.status).toBe("active");
    expect(p.authorizationId).toBeTruthy();
    expect(p.days[0].status).toBe("open");
    expect(p.days[1].status).toBe("locked");
  });

  it("places the hold directly with the sandbox test card", async () => {
    const d = deps();
    const p = await createPledge(parseCreateInput({ level: "B1", perDayUsd: 1, funding: "test-card", days }), "https://app.test", d);
    expect(p.status).toBe("active");
    expect(p.authorizationId).toBeTruthy();
    expect(p.days[0].status).toBe("open");
  });

  it("voids the hold when every day passes", async () => {
    const d = deps();
    const p = await activePledge(d);
    for (let i = 1; i <= 7; i++) await pass(d, p.id, i);
    const s = await settle(p.id, d);
    expect(s.status).toBe("settled");
    expect(s.settlement?.decision.action).toBe("void");
    expect(s.settlement?.capturedUsd).toBe(0);
    expect(d.paypal.calls.map((c) => c.path)).toContain("/v2/payments/authorizations/:id/void");
  });

  it("captures only the missed days and releases the rest", async () => {
    const d = deps();
    const p = await activePledge(d, 2);
    for (let i = 1; i <= 7; i++) {
      if (i === 3 || i === 6) await skipDay(p.id, i, d);
      else await pass(d, p.id, i);
    }
    const s = await settle(p.id, d);
    expect(s.settlement?.decision.action).toBe("partial_capture");
    expect(s.settlement?.capturedUsd).toBe(4);
    expect(s.settlement?.releasedUsd).toBe(10);
  });

  it("gives one retry, then counts a failed day as missed", async () => {
    const d = deps();
    const p = await activePledge(d);
    await startQuiz(p.id, 1, d);
    let q = await submitAnswers(p.id, 1, ["yes", "good", "ok"], d);
    expect(q.days[0].status).toBe("open");
    q = await submitAnswers(p.id, 1, ["yes", "good", "ok"], d);
    expect(q.days[0].status).toBe("failed");
    expect(q.days[1].status).toBe("open");
  });

  it("refuses to settle before the week is over", async () => {
    const d = deps();
    const p = await activePledge(d);
    await expect(settle(p.id, d)).rejects.toThrow(/Finish or skip/);
  });
});

describe("guardrail", () => {
  it("overrides an agent that tries to capture more than the ledger allows", async () => {
    const greedy: Llm = {
      lastSource: "workers-ai",
      async json<T>(opts: LlmJsonOptions): Promise<T> {
        if (opts.system.startsWith("[kind:settle]")) {
          return { action: "full_capture", captureUsd: 7, reasoning: "Keep it all.", message: "Bye" } as T;
        }
        return new PledgeRulesLlm().json<T>(opts);
      },
    };
    const d = deps(greedy);
    const p = await activePledge(d);
    for (let i = 1; i <= 7; i++) {
      if (i === 2) await skipDay(p.id, i, d);
      else await pass(d, p.id, i);
    }
    const s = await settle(p.id, d);
    expect(s.settlement?.overridden).toBe(true);
    expect(s.settlement?.capturedUsd).toBe(1);
    expect(s.ledger.some((e) => e.actor === "guardrail" && /ledger wins/.test(e.text))).toBe(true);
  });

  it("accepts a correct proposal unchanged", () => {
    const p = { pledgeUsd: 7, perDayUsd: 1, cause: "x", days: days.map((x) => ({ ...x, status: "passed", attempts: 1 })) };
    const g = guardDecision(p as never, { action: "void", captureUsd: 0, reasoning: "all done", message: "nice" });
    expect(g.overridden).toBe(false);
  });
});

describe("rule-based grading", () => {
  it("passes real answers and fails filler or Japanese", () => {
    const base = { title: "T", format: "read", activity: "a", level: "B1" };
    const qa = (answers: string[]) => answers.map((answer, i) => ({ q: `Question ${i}?`, kind: "summary", answer }));
    expect(ruleGrade({ ...base, qa: qa(GOOD) }).passed).toBe(true);
    expect(ruleGrade({ ...base, qa: qa(["ok", "yes", "no"]) }).passed).toBe(false);
    expect(ruleGrade({ ...base, qa: qa(["今日は本を読みました。とても面白かったです。主人公が好き", "楽しかったです。また読みたいと思います。", "単語を覚えました"]) }).passed).toBe(false);
  });
});

describe("HttpPayPalClient", () => {
  it("gets a token, sends a request id, and reads the authorization", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fake = async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      seen.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string> });
      if (u.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
      return Response.json(
        { id: "ORDER123456", purchase_units: [{ payments: { authorizations: [{ id: "AUTH1234567", status: "CREATED", amount: { currency_code: "USD", value: "7.00" } }] } }] },
        { status: 201, headers: { "paypal-debug-id": "dbg1" } },
      );
    };
    const c = new HttpPayPalClient("id", "secret", "https://pp.test", fake as typeof fetch);
    const a = await c.authorizeOrder("ORDER123456", "req-1");
    expect(a.authorizationId).toBe("AUTH1234567");
    expect(seen[1].headers["paypal-request-id"]).toBe("req-1");
    expect(seen[1].headers.authorization).toBe("Bearer tok");
    expect(c.calls[1]).toMatchObject({ path: "/v2/checkout/orders/:id/authorize", status: 201, debugId: "dbg1" });
  });
});
