import type { Defect } from "../state.js";
import type { Store } from "../store/types.js";
import { logTriage } from "./tools.js";

/**
 * Starts the defect-triage agent on AgenticOrg when a run pauses with candidate defects.
 *
 * The agent is a custom one (created in the workspace, with qa-pilot's `/mcp` server as its
 * tool source), so it is run through `POST /api/v1/agents/{id}/run`: AgenticOrg's A2A tasks
 * endpoint only runs its built-in agent types. The run is synchronous on AgenticOrg's side, so
 * callers must not wait on it while anything else is held up. The agent asks the owner about
 * each candidate, records their ruling, and files what they confirmed, all through qa-pilot's
 * MCP tools; it never rules on its own.
 */
export const AGENTICORG_DEFAULT_URL = "https://app.agenticorg.ai";

export type AgenticOrgConfig = {
  baseUrl: string;
  /** A workspace key (`ao_sk_...`), sent as a bearer token; running an agent needs `agents:write`. */
  apiKey: string;
  /** The custom agent's id, as `POST /api/v1/agents` returned it. */
  agentId: string;
};

export function agenticOrgFromEnv(env: NodeJS.ProcessEnv = process.env): AgenticOrgConfig | null {
  const { AGENTICORG_API_KEY: apiKey, AGENTICORG_AGENT_ID: agentId } = env;
  if (!apiKey || !agentId) return null;
  return { baseUrl: (env.AGENTICORG_BASE_URL ?? AGENTICORG_DEFAULT_URL).replace(/\/$/, ""), apiKey, agentId };
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

/** How long one agent run may take. It drafts the owner's message and returns; it does not wait for a reply. */
const AGENT_RUN_TIMEOUT_MS = 5 * 60_000;

/**
 * What the agent is asked to do. AgenticOrg dispatches only read-only remote tools from a
 * custom agent, so the agent reads the candidates and drafts the message to the owner; the
 * rulings and the filing stay in qa-pilot, where the owner confirms each defect.
 */
export const TRIAGE_INSTRUCTIONS =
  "Call list_candidate_defects for this runId. Then write one short, plain-language message to the run's owner covering every candidate still undecided: " +
  "what the test did, the key evidence, and the review link. Mark needsLook candidates as 'needs a look: low confidence'. " +
  "Ask the owner to answer each with: real bug, not a bug, or test is wrong. Return only that message. Never decide on a defect yourself.";

export type TriageRunResult = {
  taskId: string | null;
  /** AgenticOrg's run status: completed, failed, or hitl_triggered when it held the output for a person to approve. */
  status: string | null;
  /** The message the agent drafted for the owner, when it returned one. */
  draft: string | null;
};

/** The agent's text answer, wherever this AgenticOrg version put it. */
export function draftFrom(body: Record<string, unknown>): string | null {
  const pick = (v: unknown): string | null => {
    if (typeof v === "string") return v.trim() || null;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return pick(o.raw_output) ?? pick(o.message) ?? pick(o.text) ?? pick(o.output);
    }
    return null;
  };
  return pick(body.output) ?? pick((body.result as Record<string, unknown> | undefined)?.output);
}

export async function startTriageTask(cfg: AgenticOrgConfig, task: TriageTask, fetchImpl: typeof fetch = fetch): Promise<TriageRunResult> {
  const res = await fetchImpl(`${cfg.baseUrl}/api/v1/agents/${encodeURIComponent(cfg.agentId)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      action: "process",
      context: { source: "qa-pilot", runId: task.runId },
      inputs: { ...task, instructions: TRIAGE_INSTRUCTIONS },
    }),
    signal: AbortSignal.timeout(AGENT_RUN_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AgenticOrg answered ${res.status}: ${text.slice(0, 200)}`);
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const id = body.run_id ?? body.id;
    return { taskId: typeof id === "string" ? id : null, status: typeof body.status === "string" ? body.status : null, draft: draftFrom(body) };
  } catch {
    // A non-JSON success still ran the agent; there is just nothing to log about it.
    return { taskId: null, status: null, draft: null };
  }
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
      const { taskId, status, draft } = await startTriageTask(cfg, task, fetchImpl);
      logTriage(runId, { tool: "start_triage_agent", input: { candidates: defects.map((d) => d.id) }, outcome: status === "failed" ? "error" : "ok", detail: { taskId, status, draft } });
    } catch (err) {
      logTriage(runId, { tool: "start_triage_agent", input: { candidates: defects.map((d) => d.id) }, outcome: "error", detail: (err as Error).message });
      throw err;
    }
  };
}
