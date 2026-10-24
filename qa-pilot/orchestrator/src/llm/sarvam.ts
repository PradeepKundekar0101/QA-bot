import { z } from "zod";
import { RetryingLlmClient, type Completion, type Effort, type LlmRequest } from "./base.js";
import type { EventBus } from "../events.js";

export const SARVAM_DEFAULT_BASE_URL = "https://api.sarvam.ai/v1";
export const SARVAM_DEFAULT_MODEL = "sarvam-105b";

/**
 * Appended to every system prompt. The prompts in `prompts/` were written for
 * Anthropic's `output_config.format`, which enforces the shape out of band, so none
 * of them say "reply with JSON" themselves.
 */
const JSON_ONLY_RULE =
  "Respond with a single JSON object matching the requested schema. " +
  "Output only that JSON: no prose before or after it, and no markdown code fences.";

/** Sarvam accepts low/medium/high; qa-pilot's extra "xhigh" tier maps onto high. */
function reasoningEffort(effort: Effort = "high"): "low" | "medium" | "high" {
  return effort === "xhigh" ? "high" : effort;
}

/** Unwraps a ```json ... ``` fence, which models emit even when told not to. */
function stripCodeFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?\s*```\s*$/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

/**
 * Builds the `response_format` for a zod schema.
 *
 * `strict: true` would require every property to appear in `required`, which the
 * optional fields in our schemas violate, so the schema is passed as guidance only
 * and `RetryingLlmClient` does the actual enforcement. If a schema cannot be
 * expressed as JSON Schema at all we fall back to plain JSON mode rather than
 * failing the run.
 */
function responseFormat<T>(schema: z.ZodType<T>, name: string): Record<string, unknown> {
  try {
    const { $schema, ...jsonSchema } = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
    return { type: "json_schema", json_schema: { name, strict: false, schema: jsonSchema } };
  } catch {
    return { type: "json_object" };
  }
}

type SarvamResponse = {
  choices?: {
    finish_reason?: string;
    message?: { content?: string | null; refusal?: string | null };
  }[];
};

export type SarvamLlmClientOptions = {
  model?: string;
  bus?: EventBus;
  apiKey?: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Sarvam AI (https://sarvam.ai) behind the same `LlmClient` interface as Anthropic.
 * The API is OpenAI-shaped, so this talks to `/chat/completions` over plain fetch
 * rather than pulling in another SDK.
 */
export class SarvamLlmClient extends RetryingLlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SarvamLlmClientOptions = {}) {
    super(opts.bus);
    const apiKey = opts.apiKey ?? process.env.SARVAM_API_KEY;
    if (!apiKey) throw new Error('SARVAM_API_KEY is not set (required when QA_PILOT_LLM_PROVIDER="sarvam")');
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl ?? process.env.SARVAM_BASE_URL ?? SARVAM_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model ?? process.env.QA_PILOT_SARVAM_MODEL ?? SARVAM_DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  protected async generate<T>(system: string, input: string, req: LlmRequest<T>): Promise<Completion> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "api-subscription-key": this.apiKey,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 16000,
        reasoning_effort: reasoningEffort(req.effort),
        response_format: responseFormat(req.schema, req.prompt),
        messages: [
          { role: "system", content: `${system}\n\n${JSON_ONLY_RULE}` },
          { role: "user", content: input },
        ],
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Sarvam API ${response.status} ${response.statusText}: ${detail.slice(0, 500)}`);
    }
    const data = (await response.json()) as SarvamResponse;
    const choice = data.choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === "content_filter") return { refused: true };
    return { refused: false, text: stripCodeFence(choice?.message?.content ?? "") };
  }
}
