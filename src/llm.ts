export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface LlmJsonOptions {
  system: string;
  user: string;
  schema: object;
  maxTokens?: number;
}

export interface Llm {
  json<T>(opts: LlmJsonOptions): Promise<T>;
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
