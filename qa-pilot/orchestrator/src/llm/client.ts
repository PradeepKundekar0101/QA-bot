import type { EventBus } from "../events.js";
import type { LlmClient, LlmRequest } from "./base.js";
import { AnthropicLlmClient } from "./anthropic.js";
import { SarvamLlmClient } from "./sarvam.js";

export type { Completion, Effort, LlmClient, LlmRequest } from "./base.js";
export { RetryingLlmClient } from "./base.js";
export { AnthropicLlmClient } from "./anthropic.js";
export { SarvamLlmClient } from "./sarvam.js";

/** Which vendor backs every LLM call, chosen once by `QA_PILOT_LLM_PROVIDER`. */
export const LLM_PROVIDERS = ["anthropic", "sarvam"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
export const DEFAULT_LLM_PROVIDER: LlmProvider = "anthropic";

/**
 * Reads `QA_PILOT_LLM_PROVIDER`. Unset means Anthropic, so existing setups keep
 * working untouched; an unrecognised value is a typo worth failing loudly on rather
 * than silently falling back and billing the wrong vendor.
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const raw = env.QA_PILOT_LLM_PROVIDER?.trim().toLowerCase();
  if (!raw) return DEFAULT_LLM_PROVIDER;
  const match = LLM_PROVIDERS.find((p) => p === raw);
  if (!match) throw new Error(`Unknown QA_PILOT_LLM_PROVIDER "${raw}" (expected one of: ${LLM_PROVIDERS.join(", ")})`);
  return match;
}

type Canned = unknown | ((input: string) => unknown);
export class FakeLlmClient implements LlmClient {
  calls = 0;
  constructor(private answers: Record<string, Canned>) {}
  async complete<T>(req: LlmRequest<T>): Promise<T> {
    this.calls++;
    if (!(req.prompt in this.answers)) throw new Error(`FakeLlmClient: no canned answer for prompt "${req.prompt}"`);
    const a = this.answers[req.prompt];
    const value = typeof a === "function" ? (a as (i: string) => unknown)(req.input) : a;
    return req.schema.parse(value);
  }
}

export function makeLlmClient(bus?: EventBus, fake?: FakeLlmClient): LlmClient {
  if (fake) return fake;
  if (process.env.QA_PILOT_FAKE_LLM === "1") return new FakeLlmClient({});
  return resolveProvider() === "sarvam" ? new SarvamLlmClient({ bus }) : new AnthropicLlmClient({ bus });
}
