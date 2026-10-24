import "./env.js";
import { getBus, type EventBus } from "./events.js";
import { disposeScreencast } from "./browser/screencast.js";
import { makeLlmClient, type LlmClient } from "./llm/client.js";
import { buildGraph, CONFIRM_NODE, REVIEW_NODE } from "./graph.js";
import { now, type NodeDeps } from "./nodes/deps.js";
import { planRequestedFlow } from "./nodes/plan.js";
import { readVerdicts, recordVerdicts, undecided, type VerdictSubmission } from "./defects/verdicts.js";
import { FlowSchema, initialState, outputDir, StartRunInputSchema, type Flow, type StartRunInput, type RunState } from "./state.js";
import { z } from "zod";
import { readOutput, writeOutput } from "./output.js";
import { defaultStore } from "./store/index.js";
import type { RunRecord, Store } from "./store/types.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { runPlaywright } from "./nodes/run.js";
import type { Defect, DefectVerdict, RunResults, Step, TestResult } from "./state.js";

export function newRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
}

/** Derives the stored summary from the graph's final state. Pure, so it is unit-tested directly. */
export function summarise(state: RunState, startedAt: string, finishedAt: string = new Date().toISOString()): Partial<RunRecord> {
  const tests = state.results?.tests ?? [];
  return {
    status: state.partial ? "partial" : "done",
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    coverageScore: state.coverage?.score,
    planIterations: state.planIterations,
    flowsTotal: state.plan.length,
    testsPassed: tests.filter((t) => t.status === "passed").length,
    // Anything that is not "passed" counts against the run: timedOut, interrupted and
    // skipped are all failures from the point of view of a history row.
    testsFailed: tests.filter((t) => t.status !== "passed").length,
    healsAccepted: state.healLog.filter((h) => h.accepted).length,
    defectsCount: state.defects.length,
    llmCalls: state.llmCalls,
    partialReason: state.partialReason,
  };
}

// ---------- Approval gates ----------

/**
 * Runs paused at one of the two human gates - the plan review, or the defect confirmation -
 * keyed by run id. The graph is checkpointed, so the pause itself survives anything; this map
 * holds what the in-process loop in `startRun` needs to wake up, plus the paused state and the
 * node dependencies so a reviewer's "add a flow" request can be planned against the run's own
 * site map. A run that is not in here is not waiting on anybody.
 */
type Gate =
  | { node: typeof REVIEW_NODE; state: RunState; deps: NodeDeps; added: Flow[]; resume: (plan: Flow[]) => void }
  | { node: typeof CONFIRM_NODE; state: RunState; resume: () => void };
const gates = new Map<string, Gate>();

export const ReviewSubmissionSchema = z.object({ flows: z.array(FlowSchema) });
export const AddFlowSchema = z.object({ text: z.string().trim().min(3).max(500) });

export function awaitingReview(runId: string): boolean {
  return gates.get(runId)?.node === REVIEW_NODE;
}

/** The most flows a reviewer may approve for a run waiting at review, or null when it is not waiting. */
export function reviewFlowCap(runId: string): number | null {
  const gate = gates.get(runId);
  return gate?.node === REVIEW_NODE ? gate.state.maxFlows : null;
}

export function awaitingConfirmation(runId: string): boolean {
  return gates.get(runId)?.node === CONFIRM_NODE;
}

/**
 * Hands the reviewed plan to the paused run and lets it continue. Returns false when the
 * run is not waiting, so the API can answer 409 instead of silently dropping the plan.
 */
export function submitReview(runId: string, flows: Flow[]): boolean {
  const gate = gates.get(runId);
  if (gate?.node !== REVIEW_NODE) return false;
  gates.delete(runId);
  gate.resume(flows);
  return true;
}

/**
 * Plans one flow from the reviewer's plain words while the run waits at review. The flow is
 * returned for the checklist, not added to the plan: the reviewer's submitted list is still
 * the only thing that decides what is generated. Flows added earlier in the same review count
 * as planned, so a second request does not come back with the first one's id.
 */
export async function addReviewFlow(runId: string, text: string): Promise<{ flow: Flow | null; reason?: string } | null> {
  const gate = gates.get(runId);
  if (gate?.node !== REVIEW_NODE) return null;
  const out = await planRequestedFlow({ ...gate.state, plan: [...gate.state.plan, ...gate.added] }, gate.deps, text);
  if (out.flow) gate.added.push(out.flow);
  return { flow: out.flow, ...(out.reason ? { reason: out.reason } : {}) };
}

/**
 * Records rulings on candidate defects. When the run is paused at confirmation and nothing
 * is left undecided, the run resumes into its report. Rulings on a finished run are still
 * recorded, since a partial run can end with defects nobody has looked at yet.
 */
export function submitVerdicts(runId: string, verdicts: VerdictSubmission["verdicts"], by: DefectVerdict["by"]): { verdicts: DefectVerdict[]; undecided: string[]; resumed: boolean } {
  const out = recordVerdicts(runId, verdicts, by);
  const gate = gates.get(runId);
  if (gate?.node === CONFIRM_NODE && out.undecided.length === 0) {
    gates.delete(runId);
    gate.resume();
    return { ...out, resumed: true };
  }
  return { ...out, resumed: false };
}

// ---------- Single-test rerun ----------

/**
 * What a finished run leaves behind in memory so one of its tests can be executed again:
 * the target and the login steps, which carry the target app's credentials and are
 * therefore deliberately never written to disk. A run from an earlier process has no
 * context here and cannot be re-run; the caller reports that rather than failing at login.
 */
const runContexts = new Map<string, { url: string; loginSteps: Step[] }>();
const rerunsInFlight = new Set<string>();

export const specPath = (runId: string, testId: string) => `${outputDir(runId)}tests/${testId}.spec.ts`;

/** Whether a generated spec relies on the login fixture, which needs the credentials only a live run context or a fresh copilot request holds. */
export function needsLogin(file: string): boolean {
  return /\bawait login\(\)/.test(readFileSync(file, "utf8"));
}

/** The login steps still in memory for a run this process finished, or null. Never persisted. */
export function contextLoginSteps(runId: string): Step[] | null {
  return runContexts.get(runId)?.loginSteps ?? null;
}

/**
 * Why a test cannot be re-run right now, or null when it can. A run from an earlier API
 * process has no context here, so its tests can still be re-run only if they never sign in.
 */
export async function rerunBlocker(runId: string, testId: string, store: Store): Promise<string | null> {
  const file = specPath(runId, testId);
  if (!existsSync(file)) return "test not found";
  if (runContexts.has(runId)) return null;
  if (needsLogin(file)) return "this test signs in to the target app and the run's credentials are no longer in memory; start a new run to test it again";
  return (await store.getRun(runId)) ? null : "run not found";
}

/**
 * Re-executes several generated tests in one Playwright invocation. Each fresh result is
 * emitted on the bus like any other, merged into results.json, and reflected in the stored
 * pass/fail counts, so the "latest status" of each test moves without a whole new run.
 * Tests already being re-run are skipped; the caller sees only the results that ran.
 */
export async function rerunTests(runId: string, testIds: string[], loginSteps: Step[], store: Store): Promise<TestResult[]> {
  const run = await store.getRun(runId);
  if (!run) return [];
  const ids = testIds.filter((id) => existsSync(specPath(runId, id)) && !rerunsInFlight.has(`${runId}/${id}`));
  if (ids.length === 0) return [];
  for (const id of ids) rerunsInFlight.add(`${runId}/${id}`);
  const bus = getBus(runId);
  try {
    bus.log("orchestrator", `re-running ${ids.join(", ")}`);
    const fresh = await runPlaywright({ runId, baseUrl: run.url, loginSteps, files: ids.map((id) => specPath(runId, id)), bus });
    const results = fresh.tests.filter((t) => ids.includes(t.id));
    const previous = JSON.parse(readOutput(runId, "results.json") ?? '{"tests":[]}') as RunResults;
    const merged = new Map(previous.tests.map((t) => [t.id, t]));
    for (const r of results) merged.set(r.id, r);
    const tests = [...merged.values()];
    writeOutput(runId, "results.json", { tests, at: fresh.at });
    await record(store, bus, runId, {
      testsPassed: tests.filter((t) => t.status === "passed").length,
      testsFailed: tests.filter((t) => t.status !== "passed").length,
    });
    return results;
  } finally {
    for (const id of ids) rerunsInFlight.delete(`${runId}/${id}`);
  }
}

/** Single-test form of `rerunTests`, kept for the per-test Re-run button. Null when blocked or already running. */
export async function rerunTest(runId: string, testId: string, store: Store): Promise<TestResult | null> {
  if (await rerunBlocker(runId, testId, store)) return null;
  if (rerunsInFlight.has(`${runId}/${testId}`)) return null;
  const ctx = runContexts.get(runId);
  const [result] = await rerunTests(runId, [testId], ctx?.loginSteps ?? [], store);
  return result ?? null;
}

/** Recording must never take a run down with it, so every store write here is best-effort and reported. */
async function record(store: Store, bus: EventBus, runId: string, patch: Partial<RunRecord>): Promise<void> {
  try {
    await store.updateRun(runId, patch);
  } catch (err) {
    bus.log("orchestrator", `could not record run summary: ${(err as Error).message}`);
  }
}

export async function startRun(
  input: StartRunInput,
  opts: {
    headless?: boolean; llm?: LlmClient; store?: Store;
    /** Called once when a run pauses for defect confirmation, so the triage agent can ask the owner. Failures are logged, never fatal. */
    onCandidates?: (runId: string, defects: Defect[]) => Promise<void>;
  } = {},
): Promise<{ runId: string; done: Promise<RunState> }> {
  const parsed = StartRunInputSchema.parse(input);
  const store = opts.store ?? (await defaultStore());
  mkdirSync(outputDir(parsed.runId), { recursive: true });
  // heal.ts only writes heal-log.json when the heal node actually runs; many runs never hit a
  // "heal" classification (e.g. straight to rerun/escalate), so seed the file here to guarantee
  // the output contract - it's overwritten with the real log if heal does run.
  writeOutput(parsed.runId, "heal-log.json", []);

  const bus = getBus(parsed.runId);
  const llm = opts.llm ?? makeLlmClient(bus);
  const headless = opts.headless ?? process.env.QA_PILOT_HEADLESS !== "0";
  const graph = buildGraph({ bus, llm, headless }, { checkpointPath: outputDir(parsed.runId) + "checkpoint.db" });
  const state = initialState(parsed);

  // Inserted before this function resolves, so a caller that immediately navigates to
  // /runs/<id> cannot race a 404. Only url, intent and a hasPrd flag are stored: the
  // credentials for the application under test stay in memory for the run's lifetime.
  await store.insertRun({
    id: parsed.runId,
    userId: parsed.userId,
    url: state.url,
    intent: parsed.intent,
    hasPrd: Boolean(parsed.prdText),
    status: "running",
    startedAt: state.startedAt,
    ...(parsed.tier ? { tier: parsed.tier } : {}),
    maxLlmCalls: parsed.budget.maxLlmCalls,
    maxFlows: parsed.maxFlows,
  });

  /**
   * A paid-for run that never got as far as a plan gave the person nothing, so what it was
   * paid with goes back to their wallet: a credit, never money. Best-effort, like recording.
   */
  const refundIfNoPlan = async (planned: boolean) => {
    if (!parsed.tier || planned) return;
    try {
      await store.refundSlot(parsed.userId, parsed.tier);
      bus.log("orchestrator", `the run ended before a plan was produced; its ${parsed.tier} run was returned to the account`);
    } catch (err) {
      bus.log("orchestrator", `could not refund the run: ${(err as Error).message}`);
    }
  };

  // A run whose process dies would say "running" forever. Each finished node stamps a
  // heartbeat, and the store reports a running record with a stale heartbeat as
  // interrupted. Fire and forget: a slow store must not stall the graph.
  const unsubscribe = bus.subscribe((e) => {
    if (e.type === "node_end") void store.touchRun(parsed.runId).catch(() => {});
  });

  bus.emit({ type: "agent_log", agent: "orchestrator", message: `run ${parsed.runId} started for ${parsed.url}` });

  const config = { configurable: { thread_id: parsed.runId }, recursionLimit: 100 };

  /**
   * Drives the graph to completion. `invoke` returns early at either approval interrupt; the
   * loop then parks until the person acts, writes their answer into the checkpoint as the
   * gate node's own output (which marks the node executed, so its body never runs), and
   * resumes from there. Time spent parked is added to `pausedMs`, which the minutes budget
   * does not count: a person reading the plan is not the run burning its allowance.
   */
  const deps: NodeDeps = { bus, llm, headless };
  const drive = async (): Promise<RunState> => {
    let s = (await graph.invoke(state, config)) as RunState;
    for (;;) {
      const next = (await graph.getState(config)).next;
      if (next.includes(REVIEW_NODE)) {
        bus.emit({ type: "node_start", node: REVIEW_NODE, data: { flows: s.plan.length } });
        bus.log("orchestrator", `plan ready: ${s.plan.length} flows held for review`);
        await record(store, bus, parsed.runId, { status: "awaiting_review" });
        const pausedAt = Date.now();
        const plan = await new Promise<Flow[]>((resolve) => gates.set(parsed.runId, { node: REVIEW_NODE, state: s, deps, added: [], resume: resolve }));
        await record(store, bus, parsed.runId, { status: "running" });
        bus.log("orchestrator", `review submitted: ${plan.length} flows approved`);
        bus.decision({ node: REVIEW_NODE, reason: `reviewer approved ${plan.length} flow(s)`, evidence: plan.map((f) => f.id), next: plan.length ? "generate" : "report", at: now() });
        writeOutput(parsed.runId, "plan.json", plan);
        await graph.updateState(config, { plan, pausedMs: s.pausedMs + (Date.now() - pausedAt) }, REVIEW_NODE);
        bus.emit({ type: "node_end", node: REVIEW_NODE, data: { flows: plan.length } });
      } else if (next.includes(CONFIRM_NODE)) {
        bus.emit({ type: "node_start", node: CONFIRM_NODE, data: { defects: s.defects.length } });
        // Written now rather than by the report, so the confirmation screen and the triage
        // agent have the candidates to read while the run waits on them.
        writeOutput(parsed.runId, "defects.json", s.defects);
        const pausedAt = Date.now();
        if (undecided(s.defects, readVerdicts(parsed.runId)).length > 0) {
          bus.log("orchestrator", `${s.defects.length} candidate defect(s) waiting for confirmation`);
          await record(store, bus, parsed.runId, { status: "awaiting_confirmation" });
          try {
            await opts.onCandidates?.(parsed.runId, s.defects);
          } catch (err) {
            bus.log("orchestrator", `could not hand the candidates to the triage agent: ${(err as Error).message}`);
          }
          await new Promise<void>((resolve) => gates.set(parsed.runId, { node: CONFIRM_NODE, state: s, resume: resolve }));
          await record(store, bus, parsed.runId, { status: "running" });
        }
        const verdicts = readVerdicts(parsed.runId);
        const confirmed = verdicts.filter((v) => v.verdict === "confirmed").map((v) => v.defectId);
        bus.decision({ node: CONFIRM_NODE, reason: `${confirmed.length} of ${s.defects.length} candidate defect(s) confirmed`, evidence: verdicts.map((v) => `${v.defectId}: ${v.verdict} (${v.by})`), next: "report", at: now() });
        await graph.updateState(config, { pausedMs: s.pausedMs + (Date.now() - pausedAt) }, CONFIRM_NODE);
        bus.emit({ type: "node_end", node: CONFIRM_NODE, data: { confirmed: confirmed.length } });
      } else {
        return s;
      }
      s = (await graph.invoke(null, config)) as RunState;
    }
  };

  const done = drive()
    .then((s) => ({ ...s, llmCalls: Math.max(s.llmCalls, llm.calls) }) as RunState)
    .then(async (s) => {
      unsubscribe();
      // Frames are only meaningful while the run is live, and each hub retains a JPEG per
      // agent; releasing it here keeps a long-lived API process from hoarding one set per run.
      disposeScreencast(parsed.runId);
      runContexts.set(parsed.runId, { url: s.url, loginSteps: s.siteMap?.loginSteps ?? [] });
      await record(store, bus, parsed.runId, summarise(s, state.startedAt));
      await refundIfNoPlan(s.planIterations > 0);
      return s;
    })
    .catch(async (err: Error) => {
      unsubscribe();
      disposeScreencast(parsed.runId);
      gates.delete(parsed.runId);
      const finishedAt = new Date().toISOString();
      await record(store, bus, parsed.runId, {
        status: "failed",
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(state.startedAt),
        partialReason: err.message,
      });
      await refundIfNoPlan(false);
      bus.emit({ type: "error", message: err.message });
      bus.emit({ type: "done", message: "failed" });
      throw err;
    });

  return { runId: parsed.runId, done };
}
