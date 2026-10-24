import { timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  FileDefectInput, ListCandidatesInput, LogMessageInput, RecordVerdictInput, RerunInput, TriageError,
  fileConfirmedDefect, listCandidates, logOwnerMessage, logTriage, recordOwnerVerdict, rerunAffected,
  type TriageDeps,
} from "./tools.js";

/**
 * The defect-triage agent's tools, served as a remote MCP server over Streamable HTTP, which
 * is how an AgenticOrg agent is given custom tools: it connects with a bearer token and
 * discovers them. Stateless: every request gets its own server and transport, so nothing is
 * held between the agent's calls and an API restart loses nothing.
 */
export function triageServer(deps: TriageDeps): McpServer {
  const server = new McpServer({ name: "qa-pilot-triage", version: "1.0.0" });

  /** Every call lands in the run's triage log, refused ones included: the log is the proof of what the agent did. */
  const tool = <S extends z.ZodObject<{ runId: z.ZodString }>>(name: string, description: string, schema: S, fn: (deps: TriageDeps, input: z.infer<S>) => Promise<unknown>) => {
    server.registerTool(name, { description, inputSchema: schema.shape }, (async (input: z.infer<S>) => {
      try {
        const out = await fn(deps, input);
        logTriage(input.runId, { tool: name, input, outcome: "ok", detail: out });
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out as Record<string, unknown> };
      } catch (err) {
        const refused = err instanceof TriageError;
        if (!refused) console.error(`[triage] ${name} failed:`, err);
        logTriage(input.runId, { tool: name, input, outcome: refused ? "refused" : "error", detail: (err as Error).message });
        return { isError: true, content: [{ type: "text", text: refused ? (err as Error).message : "the tool failed; try again later" }] };
      }
    }) as never);
  };

  tool("list_candidate_defects",
    "List a qa-pilot run's candidate defects with their evidence, the classifier's confidence and reasoning, the owner's ruling so far, and any filed ticket. Candidates with needsLook are low confidence and must be presented as 'needs a look'.",
    ListCandidatesInput, listCandidates);
  tool("record_owner_verdict",
    "Record the run owner's own ruling on one candidate defect, exactly as they gave it: confirmed (a real bug), rejected (not a bug), or script (the test is wrong). Never call this without the owner's explicit answer.",
    RecordVerdictInput, recordOwnerVerdict);
  tool("file_confirmed_defect",
    "File a defect the owner confirmed in their connected tracker (Linear or Jira) with repro steps and evidence. Refused unless the owner confirmed it. Filing the same defect twice returns the existing ticket.",
    FileDefectInput, fileConfirmedDefect);
  tool("rerun_tests",
    "Rerun only the named tests of a run, to check whether a filed defect has been fixed.",
    RerunInput, rerunAffected);
  tool("log_owner_message",
    "Record a message sent to or received from the run owner (email, WhatsApp) in the run's triage log.",
    LogMessageInput, logOwnerMessage);
  return server;
}

/** Whether the request carries the agent's bearer token. Constant-time, and false whenever no token is configured. */
export function agentAuthorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return false;
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export async function handleMcp(req: Request, deps: TriageDeps): Promise<Response> {
  const server = triageServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close();
  }
}
