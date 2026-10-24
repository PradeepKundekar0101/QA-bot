import { randomUUID } from "node:crypto";
import { readOutput } from "../output.js";
import { buildCatalogue } from "../copilot/catalogue.js";
import { readVerdicts, recordVerdicts } from "../defects/verdicts.js";
import type { DefectVerdict } from "../state.js";
import type { Defect, Flow, RunResults } from "../state.js";
import type { RunRecord, Store, TicketRecord } from "../store/types.js";
import { TrackerError } from "./errors.js";
import type { TrackerClient } from "./composio.js";
import { buildTicket } from "./ticket.js";

function readJson<T>(runId: string, name: string, fallback: T): T {
  try {
    return JSON.parse(readOutput(runId, name) ?? "") as T;
  } catch {
    return fallback;
  }
}

export type FileOutcome =
  | { ok: true; ticket: TicketRecord; existed: boolean }
  | { ok: false; status: 404 | 409 | 412 | 500 | 502; error: string; needs?: string[] };

/** Tickets being filed right now, keyed by owner, run and test, so two clicks cannot file twice. */
const filing = new Set<string>();

/**
 * Files one test of one run in the run owner's connected tracker.
 *
 * The one rule every caller goes through: a test the classifier escalated as a candidate
 * defect is filed only once a person has confirmed it. The owner's own "file ticket" click is
 * that confirmation and is recorded as one; the triage agent (`by: "agent"`) can only file
 * what already carries a confirmed ruling, and is refused otherwise. A test that was never a
 * candidate is the owner filing something they saw themselves, which needs no ruling.
 */
export async function fileTicket(opts: {
  store: Store;
  trackers: () => TrackerClient;
  run: RunRecord;
  testId: string;
  by: "owner" | "agent";
  uiOrigin: string;
  /**
   * Records the owner's confirmation implied by filing. Defaults to writing the ruling; the API
   * passes `submitVerdicts` so a run paused at confirmation also resumes.
   */
  confirm?: (defectId: string, by: DefectVerdict["by"]) => void;
}): Promise<FileOutcome> {
  const { store, run, testId } = opts;
  const userId = run.userId;
  const entry = buildCatalogue(run).tests.find((t) => t.id === testId);
  const flow = readJson<Flow[]>(run.id, "plan.json", []).find((f) => f.id === testId);
  if (!entry || !flow) return { ok: false, status: 404, error: "not found" };

  const defect = readJson<Defect[]>(run.id, "defects.json", []).find((d) => d.flow === testId);
  if (defect) {
    const verdict = readVerdicts(run.id).find((v) => v.defectId === defect.id)?.verdict;
    if (verdict && verdict !== "confirmed") return { ok: false, status: 409, error: `${defect.id} was ruled ${verdict === "script" ? "a script bug" : "not a defect"}, so it is not filed` };
    if (!verdict && opts.by === "agent") return { ok: false, status: 409, error: `${defect.id} has not been confirmed by the run's owner; ask them first` };
  }

  const integration = await store.getIntegration(userId);
  if (!integration || integration.status !== "active" || !integration.destination) {
    return { ok: false, status: 412, error: "connect Linear or Jira in Settings, and pick where issues go, to file a ticket", needs: ["integration"] };
  }

  const existing = await store.findTicket(userId, run.id, testId);
  if (existing) return { ok: true, ticket: existing, existed: true };

  const slot = `${userId}/${run.id}/${testId}`;
  if (filing.has(slot)) return { ok: false, status: 409, error: "this ticket is already being filed" };
  filing.add(slot);
  try {
    let client: TrackerClient;
    try {
      client = opts.trackers();
    } catch (err) {
      return { ok: false, status: 500, error: (err as Error).message };
    }
    const latest = readJson<RunResults>(run.id, "results.json", { tests: [], at: "" });
    const latestResult = (Array.isArray(latest.tests) ? latest.tests : []).find((t) => t.id === testId);
    const body = buildTicket({
      runId: run.id, url: run.url, testId, flow, defect,
      verdict: entry.verdict ? { class: entry.verdict.class, confidence: entry.verdict.confidence } : undefined,
      latest: latestResult ? { error: latestResult.error, at: latest.at } : undefined,
      uiOrigin: opts.uiOrigin,
    });
    let created: { key: string; url: string };
    try {
      created = await client.createIssue(userId, integration.provider, integration.connectedAccountId, integration.destination, body);
    } catch (err) {
      if (err instanceof TrackerError) return { ok: false, status: 502, error: err.message };
      console.error("[tickets] create failed:", err);
      return { ok: false, status: 502, error: `could not reach ${integration.provider} through Composio; try again` };
    }
    // Recorded only once the issue exists, so a failed filing leaves the candidate undecided.
    if (defect && opts.by === "owner" && !readVerdicts(run.id).some((v) => v.defectId === defect.id)) {
      (opts.confirm ?? ((id, by) => recordVerdicts(run.id, [{ defectId: id, verdict: "confirmed", note: "confirmed by filing a ticket" }], by)))(defect.id, "owner");
    }
    const ticket: TicketRecord = { id: randomUUID(), userId, runId: run.id, testId, provider: integration.provider, key: created.key, url: created.url, createdAt: new Date().toISOString() };
    try {
      await store.insertTicket(ticket);
    } catch (err) {
      // Two requests raced past the pre-check; the index kept one. Answer with the survivor.
      const survivor = await store.findTicket(userId, run.id, testId);
      if (survivor) return { ok: true, ticket: survivor, existed: true };
      throw err;
    }
    return { ok: true, ticket, existed: false };
  } finally {
    filing.delete(slot);
  }
}
