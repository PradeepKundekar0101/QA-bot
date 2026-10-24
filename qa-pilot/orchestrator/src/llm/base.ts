import type { z } from "zod";
import { loadPrompt } from "./prompts.js";
import type { EventBus } from "../events.js";

export type Effort = "low" | "medium" | "high" | "xhigh";
export type LlmRequest<T> = {
  prompt: string;
  input: string;
  schema: z.ZodType<T>;
  effort?: Effort;
  maxTokens?: number;
};

export interface LlmClient {
  complete<T>(req: LlmRequest<T>): Promise<T>;
  calls: number;
}

/** The result of one provider call: either the raw model text, or a refusal. */
export type Completion = { refused: true } | { refused: false; text: string };

/**
 * Everything that is the same whichever provider is behind the call: load the system
 * prompt, ask once, parse the JSON, validate it against the zod schema, and on a bad
 * answer ask a second time with the validation error appended.
 *
 * Subclasses only implement `generate`, which is the provider-specific part.
 */
export abstract class RetryingLlmClient implements LlmClient {
  calls = 0;
  constructor(protected readonly bus?: EventBus) {}

  /** One call to the provider. Must not retry; the base class owns the retry policy. */
  protected abstract generate<T>(system: string, input: string, req: LlmRequest<T>): Promise<Completion>;

  async complete<T>(req: LlmRequest<T>): Promise<T> {
    const system = loadPrompt(req.prompt);
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      this.calls++;
      const input = lastError ? `${req.input}\n\nYour previous answer failed validation: ${lastError}. Fix it.` : req.input;
      this.bus?.log("llm", `call ${req.prompt} (attempt ${attempt + 1})`, { chars: input.length });
      const completion = await this.generate(system, input, req);
      if (completion.refused) throw new Error(`LLM refused prompt ${req.prompt}`);
      if (!completion.text) {
        lastError = "no text content in response";
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(completion.text);
      } catch (error) {
        lastError = `invalid JSON: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`;
        continue;
      }
      const result = req.schema.safeParse(parsed);
      if (result.success) return result.data;
      lastError = result.error.issues
        .slice(0, 1)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")
        .slice(0, 300);
    }
    throw new Error(`LLM output for ${req.prompt} failed validation twice: ${lastError}`);
  }
}
