import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.js";
import { memoryStore } from "../src/store/memory.js";
import type { Store, TrackerProvider } from "../src/store/types.js";
import type { TrackerClient } from "../src/integrations/index.js";
import { readTriageLog } from "../src/triage/tools.js";
import { readVerdicts } from "../src/defects/verdicts.js";
import { triageHandoff } from "../src/triage/agenticorg.js";

const ORIGIN = "http://localhost:4000";
const TOKEN = "agent-secret-token";

let store: Store;
let userId: string;
const filed: { provider: TrackerProvider; title: string }[] = [];

const trackers: TrackerClient = {
  authConfigId: async () => "ac_1",
  startConnection: async () => ({ connectedAccountId: "ca_1", redirectUrl: "https://x" }),
  awaitConnection: async () => "active",
  listDestinations: async () => [],
  createIssue: async (_uid, provider, _ca, _dest, body) => { filed.push({ provider, title: body.title }); return { key: "ENG-7", url: "https://linear.app/acme/issue/ENG-7" }; },
  disconnect: async () => {},
};

function seed(runId: string) {
  const dir = process.env.QA_PILOT_OUTPUT + runId + "/";
  mkdirSync(dir, { recursive: true });
  const flow = { id: "checkout-001", title: "Coupon", category: "happy", priority: "P0", preconditions: [], steps: [{ action: "goto", target: "/" }], expected: [{ type: "url_contains", value: "/" }], source: "explored" };
  writeFileSync(dir + "plan.json", JSON.stringify([flow]));
  writeFileSync(dir + "results.json", JSON.stringify({ at: "2026-10-24T10:00:00.000Z", tests: [{ id: "checkout-001", file: "f", title: "Coupon", status: "failed", error: "expect failed", network: [], consoleErrors: [], pageErrors: [], durationMs: 1 }] }));
  writeFileSync(dir + "defects.json", JSON.stringify([{ id: "DEF-1-checkout-001", title: "Coupon: POST /api/coupon returned 500", severity: "critical", flow: "checkout-001", repro_steps: ["1. goto /"], expected: "applied", actual: "500", evidence: ["POST /api/coupon returned 500"], attachments: [], confidence: 0.9, needsLook: false, rationale: "Server error on apply." }]));
}

beforeEach(async () => {
  process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-triage-")) + "/";
  store = memoryStore();
  filed.length = 0;
  userId = (await store.createUser("owner@team.test", "unused")).id;
  await store.insertRun({ id: "tr-1", userId, url: "http://localhost:3005", hasPrd: false, status: "awaiting_confirmation", startedAt: "2026-10-24T09:55:00.000Z" });
  await store.saveIntegration({ userId, provider: "linear", connectedAccountId: "ca_1", status: "active", destination: { id: "t1", label: "ENG" }, connectedAt: "2026-10-24T09:00:00.000Z" });
  seed("tr-1");
});

let rpcId = 0;
async function call(app: ReturnType<typeof createApi>, method: string, params: unknown, token = TOKEN) {
  const res = await app.request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}
const tool = async (app: ReturnType<typeof createApi>, name: string, args: unknown) => (await call(app, "tools/call", { name, arguments: args })).body.result;

describe("triage agent MCP endpoint", () => {
  it("is off without a token and refuses a wrong one", async () => {
    const off = createApi({ store, start: () => ({ runId: "x" }), trackers, agentToken: "" });
    expect((await call(off, "tools/list", {})).status).toBe(503);
    const app = createApi({ store, start: () => ({ runId: "x" }), trackers, agentToken: TOKEN });
    expect((await call(app, "tools/list", {}, "wrong-token-of-same-len")).status).toBe(401);
  });

  it("lists its tools", async () => {
    const app = createApi({ store, start: () => ({ runId: "x" }), trackers, agentToken: TOKEN });
    const { body } = await call(app, "tools/list", {});
    expect(body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["file_confirmed_defect", "list_candidate_defects", "log_owner_message", "record_owner_verdict", "rerun_tests"]);
  });

  it("files nothing until the owner confirms, then files once, and logs every step", async () => {
    const app = createApi({ store, start: () => ({ runId: "x" }), trackers, agentToken: TOKEN });

    const listed = await tool(app, "list_candidate_defects", { runId: "tr-1" });
    expect(listed.structuredContent).toMatchObject({ run: { id: "tr-1", owner: "owner@team.test" }, defects: [{ id: "DEF-1-checkout-001", confidence: 0.9, needsLook: false, verdict: null, ticket: null }] });

    const early = await tool(app, "file_confirmed_defect", { runId: "tr-1", defectId: "DEF-1-checkout-001" });
    expect(early.isError).toBe(true);
    expect(early.content[0].text).toMatch(/not been confirmed/);
    expect(filed).toHaveLength(0);

    await tool(app, "log_owner_message", { runId: "tr-1", channel: "whatsapp", direction: "to_owner", text: "Is the coupon 500 a real bug?" });
    await tool(app, "log_owner_message", { runId: "tr-1", channel: "whatsapp", direction: "from_owner", text: "yes, real" });
    const ruled = await tool(app, "record_owner_verdict", { runId: "tr-1", defectId: "DEF-1-checkout-001", verdict: "confirmed", note: "yes, real" });
    expect(ruled.structuredContent).toMatchObject({ undecided: [] });
    expect(readVerdicts("tr-1")).toMatchObject([{ verdict: "confirmed", by: "agent", note: "yes, real" }]);

    const ok = await tool(app, "file_confirmed_defect", { runId: "tr-1", defectId: "DEF-1-checkout-001" });
    expect(ok.structuredContent).toEqual({ key: "ENG-7", url: "https://linear.app/acme/issue/ENG-7", alreadyFiled: false });
    const again = await tool(app, "file_confirmed_defect", { runId: "tr-1", defectId: "DEF-1-checkout-001" });
    expect(again.structuredContent).toMatchObject({ alreadyFiled: true });
    expect(filed).toHaveLength(1);

    const log = readTriageLog("tr-1");
    expect(log.map((e) => `${e.tool}:${e.outcome}`)).toEqual([
      "list_candidate_defects:ok", "file_confirmed_defect:refused", "log_owner_message:ok", "log_owner_message:ok",
      "record_owner_verdict:ok", "file_confirmed_defect:ok", "file_confirmed_defect:ok",
    ]);
    expect(log.every((e) => !Number.isNaN(Date.parse(e.at)))).toBe(true);
  });

  it("refuses to file a candidate the owner ruled a script bug", async () => {
    const app = createApi({ store, start: () => ({ runId: "x" }), trackers, agentToken: TOKEN });
    await tool(app, "record_owner_verdict", { runId: "tr-1", defectId: "DEF-1-checkout-001", verdict: "script" });
    const res = await tool(app, "file_confirmed_defect", { runId: "tr-1", defectId: "DEF-1-checkout-001" });
    expect(res.isError).toBe(true);
    expect(filed).toHaveLength(0);
  });
});

describe("starting the AgenticOrg triage agent", () => {
  const defects = [{ id: "DEF-1-checkout-001", title: "Coupon 500", severity: "critical" as const, flow: "checkout-001", repro_steps: [], expected: "", actual: "", evidence: ["POST /api/coupon returned 500"], attachments: [], confidence: 0.9, needsLook: false }];

  it("posts the candidates and the owner's contact to the A2A tasks API and logs the task", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response(JSON.stringify({ id: "task-42" }), { status: 201 }); }) as unknown as typeof fetch;
    const hook = triageHandoff(store, "https://app.qa-pilot.test", { baseUrl: "https://agenticorg.test", apiKey: "k-1", agentId: "qa-triage" }, fakeFetch);
    await hook("tr-1", defects);
    expect(sent[0].url).toBe("https://agenticorg.test/api/v1/a2a/tasks");
    expect((sent[0].init.headers as Record<string, string>).authorization).toBe("Bearer k-1");
    const body = JSON.parse(sent[0].init.body as string);
    expect(body).toMatchObject({ agent_id: "qa-triage", input: { runId: "tr-1", ownerEmail: "owner@team.test", reviewUrl: "https://app.qa-pilot.test/runs/tr-1", candidates: [{ id: "DEF-1-checkout-001", needsLook: false }] } });
    expect(readTriageLog("tr-1")).toMatchObject([{ tool: "start_triage_agent", outcome: "ok", detail: { taskId: "task-42" } }]);
  });

  it("logs that the owner decides in the app when AgenticOrg is not configured", async () => {
    await triageHandoff(store, "https://app.qa-pilot.test", null)("tr-1", defects);
    expect(readTriageLog("tr-1")).toMatchObject([{ tool: "start_triage_agent", outcome: "refused" }]);
  });

  it("logs and rethrows a failed hand-off, which the run reports without stopping", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(triageHandoff(store, "x", { baseUrl: "https://a", apiKey: "k", agentId: "a" }, fakeFetch)("tr-1", defects)).rejects.toThrow(/500/);
    expect(readTriageLog("tr-1")).toMatchObject([{ outcome: "error" }]);
  });
});
