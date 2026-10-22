export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface LlmJsonOptions {
  system: string;
  user: string;
  schema: object;
  maxTokens?: number;
}

export type LlmSource = "workers-ai" | "rule-based";

export interface Llm {
  json<T>(opts: LlmJsonOptions): Promise<T>;
  /** Who answered the most recent `json` call (calls are made one at a time). */
  readonly lastSource?: LlmSource;
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

/** The one method of the Workers AI binding we use; `Ai.run` is heavily overloaded, so we narrow it. */
interface AiRunner {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

/** Turn a Workers AI result into parsed JSON. `response` may be an object or a JSON string (sometimes fenced). */
export function parseLlmResponse(result: unknown): unknown {
  const response = result && typeof result === "object" ? (result as { response?: unknown }).response : result;
  if (response && typeof response === "object") return response;
  if (typeof response !== "string") throw new LlmError("The model returned no response");
  const text = response
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError("The model returned invalid JSON");
  }
}

export class WorkersAiLlm implements Llm {
  readonly lastSource: LlmSource = "workers-ai";
  private readonly runner: AiRunner;

  constructor(
    ai: Ai | AiRunner,
    private readonly model: string = DEFAULT_MODEL,
  ) {
    this.runner = ai as unknown as AiRunner;
  }

  async json<T>(opts: LlmJsonOptions): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.runner.run(this.model, {
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
          response_format: { type: "json_schema", json_schema: opts.schema },
          max_tokens: opts.maxTokens ?? 1024,
        });
        return parseLlmResponse(result) as T;
      } catch (err) {
        last = err;
      }
    }
    const reason = last instanceof Error ? last.message : String(last);
    throw new LlmError(`AI model call failed: ${reason}`);
  }
}

/**
 * Tries the primary model and, when a call throws, answers that call with the fallback instead.
 * After two primary failures in a row it stops waiting on the primary for the rest of this run.
 */
export class ResilientLlm implements Llm {
  lastSource: LlmSource | undefined;
  private failures = 0;

  constructor(
    private readonly primary: Llm,
    private readonly fallback: Llm,
    private readonly maxFailures = 2,
  ) {}

  async json<T>(opts: LlmJsonOptions): Promise<T> {
    if (this.failures < this.maxFailures) {
      try {
        const out = await this.primary.json<T>(opts);
        this.failures = 0;
        this.lastSource = this.primary.lastSource ?? "workers-ai";
        return out;
      } catch (err) {
        this.failures += 1;
        console.error("LLM call failed, using rule-based fallback:", err instanceof Error ? err.message : String(err));
      }
    }
    const out = await this.fallback.json<T>(opts);
    this.lastSource = this.fallback.lastSource ?? "rule-based";
    return out;
  }
}
