import { describe, expect, it } from "vitest";
import { LlmError, WorkersAiLlm, parseLlmResponse } from "../src/llm";

const opts = { system: "sys", user: "usr", schema: { type: "object" }, maxTokens: 99 };

describe("WorkersAiLlm", () => {
  it("sends messages, json_schema format and max_tokens; accepts an object response", async () => {
    const calls: { model: string; inputs: Record<string, unknown> }[] = [];
    const ai = { run: async (model: string, inputs: Record<string, unknown>) => (calls.push({ model, inputs }), { response: { a: 1 } }) };
    const llm = new WorkersAiLlm(ai);
    expect(await llm.json(opts)).toEqual({ a: 1 });
    expect(calls[0].model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(calls[0].inputs).toEqual({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
      response_format: { type: "json_schema", json_schema: { type: "object" } },
      max_tokens: 99,
    });
  });

  it("parses string (and fenced) responses", () => {
    expect(parseLlmResponse({ response: '{"b":2}' })).toEqual({ b: 2 });
    expect(parseLlmResponse({ response: '```json\n{"c":3}\n```' })).toEqual({ c: 3 });
  });

  it("retries once on a parse failure", async () => {
    let n = 0;
    const ai = { run: async () => ({ response: n++ === 0 ? "not json" : '{"ok":true}' }) };
    expect(await new WorkersAiLlm(ai).json(opts)).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  it("throws LlmError after two failures", async () => {
    let n = 0;
    const ai = { run: async () => (n++, { response: "still not json" }) };
    await expect(new WorkersAiLlm(ai).json(opts)).rejects.toBeInstanceOf(LlmError);
    expect(n).toBe(2);
  });

  it("retries when the model call itself rejects and reports the reason", async () => {
    let n = 0;
    const ai = {
      run: async () => {
        n++;
        throw new Error("boom");
      },
    };
    await expect(new WorkersAiLlm(ai).json(opts)).rejects.toThrow(/AI model call failed: boom/);
    expect(n).toBe(2);
  });
});
