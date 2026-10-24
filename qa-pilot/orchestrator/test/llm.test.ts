import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { AnthropicLlmClient, FakeLlmClient, SarvamLlmClient, resolveProvider } from "../src/llm/client.js";
import { loadPrompt } from "../src/llm/prompts.js";

describe("FakeLlmClient", () => {
  it("returns canned, schema-validated output and counts calls", async () => {
    const fake = new FakeLlmClient({ _smoke: { answer: 42 } });
    const out = await fake.complete({ prompt: "_smoke", input: "x", schema: z.object({ answer: z.number() }) });
    expect(out.answer).toBe(42);
    expect(fake.calls).toBe(1);
  });
  it("supports function answers keyed by input", async () => {
    const fake = new FakeLlmClient({ _smoke: (input: string) => ({ answer: input.length }) });
    const out = await fake.complete({ prompt: "_smoke", input: "abc", schema: z.object({ answer: z.number() }) });
    expect(out.answer).toBe(3);
  });
  it("throws on unknown prompt", async () => {
    const fake = new FakeLlmClient({});
    await expect(fake.complete({ prompt: "nope", input: "", schema: z.any() })).rejects.toThrow(/no canned/);
  });
});

describe("loadPrompt", () => {
  it("loads a prompt file", () => {
    expect(loadPrompt("_smoke")).toContain("smoke");
  });
});

describe("zodOutputFormat", () => {
  it("builds a json_schema output format from a plain zod schema without throwing", () => {
    const format = zodOutputFormat(z.object({ answer: z.number() }));
    expect(format).toBeTypeOf("object");
    expect(format).toHaveProperty("type", "json_schema");
  });
});

describe("AnthropicLlmClient", () => {
  const schema = z.object({ answer: z.number() });

  it("throws immediately on refusal without retrying", async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: "refusal", content: [] });
    const client = new AnthropicLlmClient({ client: { messages: { create } } as any });
    await expect(client.complete({ prompt: "_smoke", input: "x", schema })).rejects.toThrow(/refused/);
    expect(client.calls).toBe(1);
  });

  it("retries once on invalid output, appending the validation error, then succeeds", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ answer: "nope" }) }] })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ answer: 42 }) }] });
    const client = new AnthropicLlmClient({ client: { messages: { create } } as any });
    const out = await client.complete({ prompt: "_smoke", input: "x", schema });
    expect(out.answer).toBe(42);
    expect(client.calls).toBe(2);
    const secondCallArgs = create.mock.calls[1]![0];
    expect(secondCallArgs.messages[0].content).toContain("failed validation");
  });

  it("throws after two failed validation attempts", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ answer: "nope" }) }] })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ answer: "still nope" }) }] });
    const client = new AnthropicLlmClient({ client: { messages: { create } } as any });
    await expect(client.complete({ prompt: "_smoke", input: "x", schema })).rejects.toThrow(/failed validation twice/);
    expect(client.calls).toBe(2);
  });
});

describe("resolveProvider", () => {
  it("defaults to anthropic when unset or blank", () => {
    expect(resolveProvider({})).toBe("anthropic");
    expect(resolveProvider({ QA_PILOT_LLM_PROVIDER: "  " })).toBe("anthropic");
  });
  it("accepts sarvam case-insensitively", () => {
    expect(resolveProvider({ QA_PILOT_LLM_PROVIDER: " Sarvam " })).toBe("sarvam");
  });
  it("throws on an unknown provider rather than silently falling back", () => {
    expect(() => resolveProvider({ QA_PILOT_LLM_PROVIDER: "openai" })).toThrow(/Unknown QA_PILOT_LLM_PROVIDER/);
  });
});

describe("SarvamLlmClient", () => {
  const schema = z.object({ answer: z.number() });
  const ok = (text: string) => ({ ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: text } }] }) });
  const client = (fetchImpl: unknown) =>
    new SarvamLlmClient({ apiKey: "test-key", fetchImpl: fetchImpl as typeof fetch, baseUrl: "https://api.example.com/v1/" });

  it("requires an API key", () => {
    const saved = process.env.SARVAM_API_KEY;
    delete process.env.SARVAM_API_KEY;
    expect(() => new SarvamLlmClient()).toThrow(/SARVAM_API_KEY/);
    if (saved !== undefined) process.env.SARVAM_API_KEY = saved;
  });

  it("posts an OpenAI-shaped request with the schema and both auth headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(JSON.stringify({ answer: 42 })));
    const out = await client(fetchImpl).complete({ prompt: "_smoke", input: "x", schema, effort: "low" });
    expect(out.answer).toBe(42);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer test-key");
    expect(init.headers["api-subscription-key"]).toBe("test-key");
    const body = JSON.parse(init.body);
    expect(body.reasoning_effort).toBe("low");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("smoke");
    expect(body.response_format.json_schema.schema.properties.answer.type).toBe("number");
    expect(body.response_format.json_schema.schema.$schema).toBeUndefined();
  });

  it("maps the xhigh effort tier onto sarvam's high", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(JSON.stringify({ answer: 1 })));
    await client(fetchImpl).complete({ prompt: "_smoke", input: "x", schema, effort: "xhigh" });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).reasoning_effort).toBe("high");
  });

  it("unwraps a markdown code fence around the JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok('```json\n{"answer": 7}\n```'));
    expect((await client(fetchImpl).complete({ prompt: "_smoke", input: "x", schema })).answer).toBe(7);
  });

  it("throws on a refusal without retrying", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { refusal: "no" } }] }) });
    const c = client(fetchImpl);
    await expect(c.complete({ prompt: "_smoke", input: "x", schema })).rejects.toThrow(/refused/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces an HTTP error with status and body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "bad key" });
    await expect(client(fetchImpl).complete({ prompt: "_smoke", input: "x", schema })).rejects.toThrow(
      /Sarvam API 401 Unauthorized: bad key/,
    );
  });

  it("retries once on invalid output, appending the validation error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok(JSON.stringify({ answer: "nope" })))
      .mockResolvedValueOnce(ok(JSON.stringify({ answer: 42 })));
    const c = client(fetchImpl);
    expect((await c.complete({ prompt: "_smoke", input: "x", schema })).answer).toBe(42);
    expect(c.calls).toBe(2);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body).messages[1].content).toContain("failed validation");
  });
});
