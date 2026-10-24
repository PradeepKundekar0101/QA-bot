import { z } from "zod";
import { readOutput, writeOutput } from "../output.js";
import { DefectVerdictSchema, type Defect, type DefectVerdict } from "../state.js";

/**
 * A person's rulings on a run's candidate defects, kept in `verdicts.json` beside
 * `defects.json`. On disk rather than in graph state because a ruling can arrive after the
 * run has ended (a partial run still has defects to decide), from the UI or from the triage
 * agent relaying the owner's answer, and it must survive an API restart either way.
 */
const FILE = "verdicts.json";

export const VerdictSubmissionSchema = z.object({
  verdicts: z.array(DefectVerdictSchema.pick({ defectId: true, verdict: true, note: true })).min(1),
});
export type VerdictSubmission = z.infer<typeof VerdictSubmissionSchema>;

export function readDefects(runId: string): Defect[] {
  try {
    return JSON.parse(readOutput(runId, "defects.json") ?? "[]") as Defect[];
  } catch {
    return [];
  }
}

export function readVerdicts(runId: string): DefectVerdict[] {
  try {
    return z.array(DefectVerdictSchema).parse(JSON.parse(readOutput(runId, FILE) ?? "[]"));
  } catch {
    return [];
  }
}

export class UnknownDefectError extends Error {
  constructor(ids: string[]) {
    super(`not a candidate defect of this run: ${ids.join(", ")}`);
    this.name = "UnknownDefectError";
  }
}

/**
 * Records rulings, the newest one per defect winning, and says which candidates are still
 * undecided. A ruling on an id the run never produced is refused as a whole, so a typo
 * cannot half-apply a batch.
 */
export function recordVerdicts(
  runId: string,
  incoming: VerdictSubmission["verdicts"],
  by: DefectVerdict["by"],
  at: string = new Date().toISOString(),
): { verdicts: DefectVerdict[]; undecided: string[] } {
  const defects = readDefects(runId);
  const known = new Set(defects.map((d) => d.id));
  const unknown = incoming.map((v) => v.defectId).filter((id) => !known.has(id));
  if (unknown.length) throw new UnknownDefectError(unknown);
  const byId = new Map(readVerdicts(runId).map((v) => [v.defectId, v]));
  for (const v of incoming) byId.set(v.defectId, { ...v, by, at });
  const verdicts = defects.map((d) => byId.get(d.id)).filter((v): v is DefectVerdict => Boolean(v));
  writeOutput(runId, FILE, verdicts);
  return { verdicts, undecided: undecided(defects, verdicts) };
}

export function undecided(defects: Defect[], verdicts: DefectVerdict[]): string[] {
  const decided = new Set(verdicts.map((v) => v.defectId));
  return defects.map((d) => d.id).filter((id) => !decided.has(id));
}
