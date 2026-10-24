/**
 * Starts the AgenticOrg triage agent once, outside any run, and prints what came back. A
 * live check of the whole chain - qa-pilot to AgenticOrg, and the agent back to qa-pilot's
 * /mcp - before a real run depends on it.
 *
 *   npx tsx scripts/triage-probe.ts [runId]
 */
import "../src/env.js";
import { agenticOrgFromEnv, startTriageTask, triageTask } from "../src/triage/agenticorg.js";

const cfg = agenticOrgFromEnv();
if (!cfg) {
  console.error("AGENTICORG_API_KEY and AGENTICORG_AGENT_ID must be set in qa-pilot/.env");
  process.exit(1);
}
const runId = process.argv[2] ?? `probe-${Date.now()}`;
const task = triageTask(runId, "http://localhost:3005", null, [], process.env.QA_PILOT_UI_ORIGIN ?? "http://localhost:3000");
const started = Date.now();
try {
  console.log(JSON.stringify({ runId, ...(await startTriageTask(cfg, task)), ms: Date.now() - started }));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
