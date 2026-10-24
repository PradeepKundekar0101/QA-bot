import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShop } from "./helpers/shop.js";
import { startRun, awaitingReview, submitReview, awaitingConfirmation, submitVerdicts, reviewFlowCap } from "../src/run.js";
import { buildGraph } from "../src/graph.js";
import { EventBus, getBus } from "../src/events.js";
import { FakeLlmClient } from "../src/llm/client.js";
import { memoryStore } from "../src/store/memory.js";
import { initialState, outputDir, RunStateAnnotation, type Flow } from "../src/state.js";
import { StateGraph, START, END } from "@langchain/langgraph";

let shop: Awaited<ReturnType<typeof startShop>>;
beforeAll(async () => { shop = await startShop(); });
afterAll(async () => { await shop.stop(); });

const flows: Flow[] = [
  { id: "auth-001", title: "Login with valid credentials lands on products", category: "happy", priority: "P0", preconditions: ["logged_out"], source: "explored",
    steps: [{ action: "goto", target: "/login", intent: "open login" }, { action: "fill", role: "textbox", name: "Email", value: "demo@shop.test", intent: "email" }, { action: "fill", role: "textbox", name: "Password", value: "demo1234", intent: "password" }, { action: "click", role: "button", name: "Sign in", intent: "submit" }],
    expected: [{ type: "url_contains", value: "/products" }, { type: "visible", role: "heading", name: "Products" }] },
  { id: "auth-002", title: "Login with wrong password shows error", category: "negative", priority: "P1", preconditions: ["logged_out"], source: "explored",
    steps: [{ action: "goto", target: "/login", intent: "open login" }, { action: "fill", role: "textbox", name: "Email", value: "demo@shop.test", intent: "email" }, { action: "fill", role: "textbox", name: "Password", value: "wrong", intent: "password" }, { action: "click", role: "button", name: "Sign in", intent: "submit" }],
    expected: [{ type: "visible", role: "alert", text_contains: "Invalid" }, { type: "url_stays", value: "/login" }] },
  { id: "auth-003", title: "Login with empty form shows validation", category: "negative", priority: "P2", preconditions: ["logged_out"], source: "explored",
    steps: [{ action: "goto", target: "/login", intent: "open login" }, { action: "click", role: "button", name: "Sign in", intent: "submit empty" }],
    expected: [{ type: "url_stays", value: "/login" }] },
  { id: "orders-authz-001", title: "Orders redirects to login when logged out", category: "authz", priority: "P1", preconditions: ["logged_out"], source: "explored",
    steps: [{ action: "goto", target: "/orders", intent: "open orders" }], expected: [{ type: "url_contains", value: "/login" }] },
  { id: "checkout-001", title: "Apply valid coupon shows applied status", category: "happy", priority: "P1", preconditions: ["logged_in"], source: "intent",
    steps: [{ action: "goto", target: "/checkout", intent: "open checkout" }, { action: "fill", role: "textbox", name: "Coupon code", value: "SAVE10", intent: "enter coupon" }, { action: "click", role: "button", name: "Apply coupon", intent: "apply coupon" }],
    expected: [{ type: "visible", role: "status", text_contains: "Coupon applied" }] },
];

describe("full graph against mini-shop with the fake LLM", () => {
  it("produces every output file and escalates the broken coupon endpoint", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-graph-")) + "/";
    await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ breakCoupon: true }) });
    const llm = new FakeLlmClient({
      plan: { flows },
      "classify-rationale": { rationale: "Server returned 500 on the coupon endpoint.", confidence_adjustment: 0 },
      heal: { role: "button", name: "Apply coupon", reason: "unchanged", confidence: 0.2 },
    });
    const store = memoryStore();
    const handedOff: string[][] = [];
    const { runId, done } = await startRun(
      { runId: "it-1", userId: "u-test", url: shop.base, credentials: { username: "demo@shop.test", password: "demo1234" }, intent: "login and checkout coupon", maxFlows: 12, budget: { maxLlmCalls: 200, maxMinutes: 40 } },
      { headless: true, llm, store, onCandidates: async (_id, defects) => { handedOff.push(defects.map((d) => d.flow)); } },
    );

    // The run holds its candidate defects for a person before writing the report.
    const deadline = Date.now() + 240_000;
    while (!awaitingConfirmation(runId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(awaitingConfirmation(runId)).toBe(true);
    expect((await store.getRun(runId))!.status).toBe("awaiting_confirmation");
    expect(handedOff).toEqual([["checkout-001"]]);
    const candidates = JSON.parse(readFileSync(outputDir(runId) + "defects.json", "utf8")) as Array<{ id: string; flow: string; confidence: number; needsLook: boolean }>;
    expect(candidates.map((d) => d.flow)).toEqual(["checkout-001"]);
    expect(candidates[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(candidates[0].needsLook).toBe(false);
    expect((candidates[0] as { screenshot?: string }).screenshot).toMatch(/traces\/classify\/.*failure-checkout-001\.png$/);
    expect(existsSync(outputDir(runId) + "report.md")).toBe(false);
    expect(submitVerdicts(runId, [{ defectId: candidates[0].id, verdict: "confirmed" }], "owner")).toMatchObject({ undecided: [], resumed: true });

    const final = await done;
    expect((await store.getRun(runId))!.status).toBe("done");
    await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ breakCoupon: false }) });
    const dir = process.env.QA_PILOT_OUTPUT + runId + "/";
    for (const f of ["plan.md", "plan.json", "coverage.json", "results.json", "heal-log.json", "defects.json", "report.md", "report.html", "decisions.jsonl", "events.jsonl", "login-steps.json"]) expect(existsSync(dir + f), f).toBe(true);
    const loginSteps = readFileSync(dir + "login-steps.json", "utf8");
    expect(loginSteps).not.toContain("demo1234");
    expect(loginSteps).toContain("{{password}}");
    expect(existsSync(dir + "tests/auth-002.spec.ts")).toBe(true);
    const passed = final.results!.tests.filter((t) => t.status === "passed").map((t) => t.id);
    expect(passed).toEqual(expect.arrayContaining(["auth-001", "auth-002", "auth-003", "orders-authz-001"]));
    const coupon = final.classifications.find((c) => c.test === "checkout-001");
    expect(coupon?.class).toBe("defect");
    expect(coupon?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(final.defects.map((d) => d.flow)).toContain("checkout-001");
    const decisions = readFileSync(dir + "decisions.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(decisions.map((d) => d.node)).toEqual(expect.arrayContaining(["explore", "evaluate_coverage", "classify", "await_defect_confirmation"]));
    expect(decisions.find((d) => d.node === "await_defect_confirmation")?.reason).toBe("1 of 1 candidate defect(s) confirmed");
  }, 300_000);
});

describe("graph budget guard (fast, no browser)", () => {
  it("marks the run partial with a budget-exceeded reason before any node launches a browser", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-graph-budget-")) + "/";
    const runId = "budget-1";
    const bus = new EventBus(runId, outputDir(runId));
    const llm = new FakeLlmClient({});
    const graph = buildGraph({ bus, llm, headless: true }, { checkpointPath: outputDir(runId) + "checkpoint.db" });
    const state = {
      ...initialState({ runId, url: "http://example.test" }),
      budget: { maxLlmCalls: 0, maxMinutes: 40 },
      llmCalls: 1,
    };
    const final = await graph.invoke(state, { configurable: { thread_id: runId }, recursionLimit: 100 });
    expect(final.partial).toBe(true);
    expect(final.partialReason).toMatch(/budget exceeded/);
    expect(existsSync(outputDir(runId) + "report.md")).toBe(true);
  });
});

describe("defect confirmation relayed by the triage agent", () => {
  it("finishes when the hand-off itself rules on every candidate before returning", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-graph-agent-")) + "/";
    await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ breakCoupon: true }) });
    try {
      const llm = new FakeLlmClient({
        plan: { flows: flows.filter((f) => f.id === "checkout-001") },
        "classify-rationale": { rationale: "Server returned 500 on the coupon endpoint.", confidence_adjustment: 0 },
      });
      const store = memoryStore();
      // AgenticOrg runs the agent synchronously: the owner may answer, and the agent record
      // the ruling, before the hand-off call has even returned.
      const { done } = await startRun(
        { runId: "agent-1", userId: "u-test", url: shop.base, credentials: { username: "demo@shop.test", password: "demo1234" }, maxFlows: 1, autoHeal: false },
        { headless: true, llm, store, onCandidates: async (id, defects) => { submitVerdicts(id, defects.map((d) => ({ defectId: d.id, verdict: "confirmed" as const })), "agent"); } },
      );
      const final = await Promise.race([done, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("run stuck at confirmation")), 200_000))]);
      expect(final.defects).toHaveLength(1);
      expect((await store.getRun("agent-1"))!.status).toBe("done");
      expect(readFileSync(outputDir("agent-1") + "report.md", "utf8")).toContain("Status: confirmed.");
    } finally {
      await fetch(shop.base + "/__chaos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ breakCoupon: false }) });
    }
  }, 300_000);
});

describe("plan review gate", () => {
  it("pauses after coverage, records awaiting_review, and generates only the flows the reviewer kept", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-graph-review-")) + "/";
    const store = memoryStore();
    const llm = new FakeLlmClient({ plan: { flows } });
    const runId = "review-1";
    const { done } = await startRun(
      { runId, userId: "u-test", url: shop.base, credentials: { username: "demo@shop.test", password: "demo1234" }, reviewPlan: true },
      { headless: true, llm, store },
    );

    // The gate opens once the plan has passed coverage; poll rather than sleep so the test stays quick.
    const deadline = Date.now() + 120_000;
    while (!awaitingReview(runId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(awaitingReview(runId)).toBe(true);
    expect((await store.getRun(runId))!.status).toBe("awaiting_review");
    const events = getBus(runId).replay();
    expect(events.some((e) => e.type === "node_start" && e.node === "review")).toBe(true);
    expect(events.some((e) => e.type === "node_start" && e.node === "generate")).toBe(false);

    expect(reviewFlowCap(runId)).toBe(3);
    const kept = flows.filter((f) => f.id === "auth-001" || f.id === "orders-authz-001");
    expect(submitReview(runId, kept)).toBe(true);
    expect(submitReview(runId, kept)).toBe(false);

    const final = await done;
    expect(final.plan.map((f) => f.id).sort()).toEqual(["auth-001", "orders-authz-001"]);
    expect(final.results!.tests.map((t) => t.id).sort()).toEqual(["auth-001", "orders-authz-001"]);
    expect(JSON.parse(readFileSync(outputDir(runId) + "plan.json", "utf8")).map((f: Flow) => f.id).sort()).toEqual(["auth-001", "orders-authz-001"]);
    expect((await store.getRun(runId))!.status).toBe("done");
    const after = getBus(runId).replay();
    expect(after.some((e) => e.type === "node_end" && e.node === "review")).toBe(true);
    expect(after.filter((e) => e.type === "test_start").length).toBeGreaterThan(0);
    expect(final.results!.tests.every((t) => t.videoPath && existsSync(t.videoPath))).toBe(true);
  }, 300_000);
});

describe("concurrent node failures", () => {
  it("keeps every reason when two fanned-out nodes fail in the same step", async () => {
    // Generation fans out one node per flow, and each failure records why the run went partial.
    // Two failures in one step therefore write that one channel twice, which used to abort the
    // whole run with "LastValue can only receive one value per step" - losing the passing tests
    // and the report with them. The channel has to fold concurrent writes, not reject them.
    const graph = new StateGraph(RunStateAnnotation)
      .addNode("fanOut", async () => ({}))
      .addNode("a", async () => ({ partial: true, partialReason: "generate failed: goto timed out" }))
      .addNode("b", async () => ({ partial: true, partialReason: "generate failed: screenshot timed out" }))
      .addEdge(START, "fanOut")
      .addEdge("fanOut", "a")
      .addEdge("fanOut", "b")
      .addEdge("a", END)
      .addEdge("b", END)
      .compile();
    const final = await graph.invoke(initialState({ runId: "fanout-1", url: "http://example.test" }));
    expect(final.partial).toBe(true);
    expect(final.partialReason).toContain("goto timed out");
    expect(final.partialReason).toContain("screenshot timed out");
  });

  it("does not repeat a reason two nodes happen to share", async () => {
    const graph = new StateGraph(RunStateAnnotation)
      .addNode("fanOut", async () => ({}))
      .addNode("a", async () => ({ partial: true, partialReason: "generate failed: goto timed out" }))
      .addNode("b", async () => ({ partial: true, partialReason: "generate failed: goto timed out" }))
      .addEdge(START, "fanOut")
      .addEdge("fanOut", "a")
      .addEdge("fanOut", "b")
      .addEdge("a", END)
      .addEdge("b", END)
      .compile();
    const final = await graph.invoke(initialState({ runId: "fanout-2", url: "http://example.test" }));
    expect(final.partialReason).toBe("generate failed: goto timed out");
  });
});
