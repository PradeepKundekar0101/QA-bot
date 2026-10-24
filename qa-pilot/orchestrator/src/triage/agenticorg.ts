import type { Defect } from "../state.js";
import type { Store } from "../store/types.js";
import { logTriage } from "./tools.js";

/**
 * Starts the defect-triage agent on AgenticOrg when a run pauses with candidate defects.
 *
 * AgenticOrg runs an agent through its A2A tasks API with a workspace API key. The agent then
 * works through qa-pilot's MCP tools (`/mcp`): it asks the owner about each candidate, records
 * their ruling, files what they confirmed, and follows up. The request shape below follows
 * AgenticOrg's documented `POST /api/v1/a2a/tasks`; the path and the auth header are
 * configurable because the docs do not pin them down.
 */
export type AgenticOrgConfig = {
  baseUrl: string;
  apiKey: string;
  agentId: string;
  /** Default `/api/v1/a2a/tasks`. */
  tasksPath?: string;
  /** Default `authorization`, sent as `Bearer <key>`; any other header carries the key as is. */
  authHeader?: string;
};

export function agenticOrgFromEnv(env: NodeJS.ProcessEnv = process.env): AgenticOrgConfig | null {
  const { AGENTICORG_BASE_URL: baseUrl, AGENTICORG_API_KEY: apiKey, AGENTICORG_AGENT_ID: agentId } = env;
  if (!baseUrl || !apiKey || !agentId) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, agentId, tasksPath: env.AGENTICORG_TASKS_PATH, authHeader: env.AGENTICORG_AUTH_HEADER };
}

export type TriageTask = {
  runId: string;
  ownerEmail: string | null;
  targetUrl: string;
  reviewUrl: string;
  candidates: { id: string; title: string; severity: string; confidence?: number; needsLook: boolean; evidence: string[] }[];
};

export function triageTask(runId: string, targetUrl: string, ownerEmail: string | null, defects: Defect[], uiOrigin: string): TriageTask {
  return {
    runId,
    ownerEmail,
    targetUrl,
    reviewUrl: `${uiOrigin}/runs/${runId}`,
    candidates: defects.map((d) => ({ id: d.id, title: d.title, severity: d.severity, confidence: d.confidence, needsLook: d.needsLook ?? false, evidence: d.evidence.slice(0, 5) })),
  };
}

export async function startTriageTask(cfg: AgenticOrgConfig, task: TriageTask, fetchImpl: typeof fetch = fetch): Promise<{ taskId: string | null }> {
  const header = (cfg.authHeader ?? "authorization").toLowerCase();
  const res = await fetchImpl(cfg.baseUrl + (cfg.tasksPath ?? "/api/v1/a2a/tasks"), {
    method: "POST",
    headers: { "content-type": "application/json", [header]: header === "authorization" ? `Bearer ${cfg.apiKey}` : cfg.apiKey },
    body: JSON.stringify({
      agent_id: cfg.agentId,
      input: {
        ...task,
        instructions:
          "For each candidate defect, send the owner a plain-language repro with the evidence and ask whether it is a real bug, not a bug, or a test problem. " +
          "Record their answer with record_owner_verdict, then file confirmed ones with file_confirmed_defect. Present needsLook candidates as 'needs a look'. Never rule on a defect yourself.",
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AgenticOrg answered ${res.status}: ${text.slice(0, 200)}`);
  let taskId: string | null = null;
  try {
    const body = JSON.parse(text) as { id?: string; task_id?: string; taskId?: string };
    taskId = body.id ?? body.task_id ?? body.taskId ?? null;
  } catch {
    // A non-JSON success still started the task; there is just no id to log.
  }
  return { taskId };
}

/**
 * The `onCandidates` hook `startRun` calls when a run pauses for confirmation. With AgenticOrg
 * unconfigured the run simply waits for the owner in the UI, and the log says so.
 */
export function triageHandoff(store: Store, uiOrigin: string, cfg: AgenticOrgConfig | null = agenticOrgFromEnv(), fetchImpl: typeof fetch = fetch) {
  return async (runId: string, defects: Defect[]): Promise<void> => {
    const run = await store.getRun(runId);
    if (!run) return;
    if (!cfg) {
      logTriage(runId, { tool: "start_triage_agent", input: { candidates: defects.length }, outcome: "refused", detail: "AgenticOrg is not configured; waiting for the owner in the app" });
      return;
    }
    const owner = await store.findUserById(run.userId);
    const task = triageTask(runId, run.url, owner?.email ?? null, defects, uiOrigin);
    try {
      const { taskId } = await startTriageTask(cfg, task, fetchImpl);
      logTriage(runId, { tool: "start_triage_agent", input: { candidates: defects.map((d) => d.id) }, outcome: "ok", detail: { taskId } });
    } catch (err) {
      logTriage(runId, { tool: "start_triage_agent", input: { candidates: defects.map((d) => d.id) }, outcome: "error", detail: (err as Error).message });
      throw err;
    }
  };
}
