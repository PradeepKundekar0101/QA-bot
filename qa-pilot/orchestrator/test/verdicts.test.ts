import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOutput } from "../src/output.js";
import { readVerdicts, recordVerdicts, UnknownDefectError } from "../src/defects/verdicts.js";

const defect = (id: string) => ({ id, title: id, severity: "high", flow: id, repro_steps: [], expected: "", actual: "", evidence: [], attachments: [] });

beforeEach(() => {
  process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-verdicts-")) + "/";
  writeOutput("r", "defects.json", [defect("DEF-1-a"), defect("DEF-1-b")]);
});

describe("recordVerdicts", () => {
  it("records rulings, keeps the newest per defect, and reports what is still undecided", () => {
    let out = recordVerdicts("r", [{ defectId: "DEF-1-a", verdict: "rejected" }], "owner", "2026-10-24T10:00:00.000Z");
    expect(out.undecided).toEqual(["DEF-1-b"]);
    out = recordVerdicts("r", [{ defectId: "DEF-1-a", verdict: "confirmed", note: "real" }, { defectId: "DEF-1-b", verdict: "script" }], "agent", "2026-10-24T10:01:00.000Z");
    expect(out.undecided).toEqual([]);
    expect(readVerdicts("r")).toEqual([
      { defectId: "DEF-1-a", verdict: "confirmed", note: "real", by: "agent", at: "2026-10-24T10:01:00.000Z" },
      { defectId: "DEF-1-b", verdict: "script", by: "agent", at: "2026-10-24T10:01:00.000Z" },
    ]);
  });

  it("refuses a batch naming a defect the run never produced, and applies none of it", () => {
    expect(() => recordVerdicts("r", [{ defectId: "DEF-1-a", verdict: "confirmed" }, { defectId: "DEF-9-z", verdict: "confirmed" }], "owner")).toThrow(UnknownDefectError);
    expect(readVerdicts("r")).toEqual([]);
  });
});
