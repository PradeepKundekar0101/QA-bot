import { appendFileSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { outputDir, type DefectVerdict, type TestResult } from "../state.js";
import { readOutput } from "../output.js";
import { readDefects, readVerdicts, UnknownDefectError, type VerdictSubmission } from "../defects/verdicts.js";
import { fileTicket } from "../integrations/file.js";
import type { TrackerClient } from "../integrations/composio.js";
import type { Store } from "../store/types.js";

/**
 * What the defect-triage agent can do, as plain functions over a run. The agent reaches them
 * through the MCP endpoint (`triage/mcp.ts`); they are kept separate from the transport so the
 * rules are tested without it.
 *
 * The agent works for the run's owner and never in their place: it relays the owner's ruling
 * on a candidate, it files only what carries a confirmed ruling (`fileTicket` enforces that),
 * and every call it makes is appended to the run's `triage-log.jsonl` with a timestamp.
 */
export type TriageDeps = {
  store: Store;
  trackers: () => TrackerClient;
  uiOrigin: string;
  /** `submitVerdicts` from run.ts, so a ruling relayed by the agent can resume a paused run. */
  submitVerdicts: (runId: string, verdicts: VerdictSubmission["verdicts"], by: DefectVerdict["by"]) => { verdicts: DefectVerdict[]; undecided: string[]; resumed: boolean };
  /** `rerunTests` from run.ts, bound to the run's login context; absent where reruns are not possible. */
  rerun?: (runId: string, testIds: string[]) => Promise<TestResult[]>;
};

export type TriageLogEntry = { at: string; tool: string; input: unknown; outcome: "ok" | "refused" | "error"; detail?: unknown };

export function logTriage(runId: string, entry: Omit<TriageLogEntry, "at">, at: string = new Date().toISOString()): void {
  mkdirSync(outputDir(runId), { recursive: true });
  appendFileSync(outputDir(runId) + "triage-log.jsonl", JSON.stringify({ at, ...entry }) + "\n");
}

export function readTriageLog(runId: string): TriageLogEntry[] {
  return (readOutput(runId, "triage-log.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TriageLogEntry);
}

export class TriageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriageError";
  }
}

async function runOrThrow(deps: TriageDeps, runId: string) {
  const run = await deps.store.getRun(runId);
  if (!run) throw new TriageError(`no run ${runId}`);
  return run;
}

export const ListCandidatesInput = z.object({ runId: z.string() });
export const RecordVerdictInput = z.object({
  runId: z.string(),
  defectId: z.string(),
  verdict: z.enum(["confirmed", "rejected", "script"]),
  /** The owner's own words, as they replied. */
  note: z.string().max(2000).optional(),
});
export const FileDefectInput = z.object({ runId: z.string(), defectId: z.string() });
export const RerunInput = z.object({ runId: z.string(), testIds: z.array(z.string()).min(1).max(12) });
export const LogMessageInput = z.object({
  runId: z.string(),
  channel: z.enum(["email", "whatsapp", "other"]),
  direction: z.enum(["to_owner", "from_owner"]),
  text: z.string().max(4000),
});

/** The run's candidate defects with the evidence a person needs to rule on them, each ruling, and any filed ticket. */
export async function listCandidates(deps: TriageDeps, input: z.infer<typeof ListCandidatesInput>) {
  const run = await runOrThrow(deps, input.runId);
  const owner = await deps.store.findUserById(run.userId);
  const verdicts = new Map(readVerdicts(run.id).map((v) => [v.defectId, v]));
  const tickets = new Map((await deps.store.listTickets(run.userId, run.id)).map((t) => [t.testId, t]));
  const defects = readDefects(run.id).map((d) => ({
    id: d.id,
    title: d.title,
    severity: d.severity,
    test: d.flow,
    confidence: d.confidence,
    needsLook: d.needsLook ?? false,
    rationale: d.rationale,
    reproSteps: d.repro_steps,
    expected: d.expected,
    actual: d.actual,
    evidence: d.evidence,
    reviewUrl: `${deps.uiOrigin}/runs/${run.id}/cases?test=${encodeURIComponent(d.flow)}`,
    verdict: verdicts.get(d.id) ?? null,
    ticket: tickets.get(d.flow) ? { key: tickets.get(d.flow)!.key, url: tickets.get(d.flow)!.url } : null,
  }));
  return { run: { id: run.id, url: run.url, status: run.status, owner: owner?.email ?? null }, defects };
}

/** Records the owner's ruling as the agent heard it. The agent never rules on its own. */
export async function recordOwnerVerdict(deps: TriageDeps, input: z.infer<typeof RecordVerdictInput>) {
  await runOrThrow(deps, input.runId);
  try {
    const out = deps.submitVerdicts(input.runId, [{ defectId: input.defectId, verdict: input.verdict, note: input.note }], "agent");
    return { undecided: out.undecided, resumed: out.resumed };
  } catch (err) {
    if (err instanceof UnknownDefectError) throw new TriageError(err.message);
    throw err;
  }
}

/** Files a confirmed defect in the owner's tracker. Refused for anything not confirmed by the owner. */
export async function fileConfirmedDefect(deps: TriageDeps, input: z.infer<typeof FileDefectInput>) {
  const run = await runOrThrow(deps, input.runId);
  const defect = readDefects(run.id).find((d) => d.id === input.defectId);
  if (!defect) throw new TriageError(`not a candidate defect of this run: ${input.defectId}`);
  const out = await fileTicket({ store: deps.store, trackers: deps.trackers, run, testId: defect.flow, by: "agent", uiOrigin: deps.uiOrigin });
  if (!out.ok) throw new TriageError(out.error);
  return { key: out.ticket.key, url: out.ticket.url, alreadyFiled: out.existed };
}

/** Reruns only the tests the owner asked about, for "is it fixed yet?" follow-ups. */
export async function rerunAffected(deps: TriageDeps, input: z.infer<typeof RerunInput>) {
  await runOrThrow(deps, input.runId);
  if (!deps.rerun) throw new TriageError("reruns are not available for this run");
  const results = await deps.rerun(input.runId, input.testIds);
  return { results: results.map((r) => ({ test: r.id, status: r.status, error: r.error?.split("\n")[0] })) };
}

/** Records a message the agent sent to or received from the owner, so the log holds the whole conversation. */
export async function logOwnerMessage(deps: TriageDeps, input: z.infer<typeof LogMessageInput>) {
  await runOrThrow(deps, input.runId);
  return { logged: true };
}
