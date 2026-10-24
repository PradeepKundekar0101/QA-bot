import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { RetryingLlmClient, type Completion, type LlmRequest } from "./base.js";
import type { EventBus } from "../events.js";

type MinimalAnthropicClient = { messages: { create: Anthropic["messages"]["create"] } };

export class AnthropicLlmClient extends RetryingLlmClient {
  private client: MinimalAnthropicClient;
  private model: string;
  constructor(opts: { model?: string; bus?: EventBus; client?: MinimalAnthropicClient } = {}) {
    super(opts.bus);
    this.model = opts.model ?? process.env.QA_PILOT_MODEL ?? "claude-opus-5";
    this.client = opts.client ?? new Anthropic();
  }

  protected async generate<T>(system: string, input: string, req: LlmRequest<T>): Promise<Completion> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      system,
      thinking: { type: "adaptive" },
      output_config: { effort: req.effort ?? "high", format: zodOutputFormat(req.schema) },
      messages: [{ role: "user", content: input }],
    });
    if (response.stop_reason === "refusal") return { refused: true };
    const textBlocks = response.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
    return { refused: false, text: textBlocks.map((b) => b.text).join("") };
  }
}
