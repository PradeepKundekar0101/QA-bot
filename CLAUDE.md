# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

qa-pilot: paste a web app URL, approve a test plan, get real bugs instead of red tests.
It started as the Bessemer Tech Catalyst submission (autonomous test orchestration, spec in `problem_explanation_9dm9yp4f98s.pdf`).
The current target is the Airtribe x Pine Labs AI Builders Day edition, spec in `docs/2026-10-24-prd-ai-builders-day.md`, build plan in `docs/superpowers/plans/2026-10-24-ai-builders-day.md`.
The main differences from the original spec: a human approves the plan and confirms every defect, runs are tiered and paid through Pine Labs, healing is off on web runs, and a defect-triage agent runs on AgenticOrg.

## Layout

All code lives in `qa-pilot/`, an npm workspace (Node 22+, TypeScript, ESM).

- `orchestrator/` - the LangGraph pipeline, the Hono API, the CLI, storage, billing and the triage agent's tools.
- `ui/` - the Next.js web app (read `ui/AGENTS.md`: this Next.js version differs from older ones).
- `runner/` - the Playwright runner package.
- `targets/mini-shop/` - a small Express shop used as the test target, with a `/__chaos` switch that breaks things on purpose.
- `output/<runId>/` - everything a run writes: plan, specs, results, traces, `defects.json`, `verdicts.json`, `triage-log.jsonl`, `decisions.jsonl`, the report.

## Commands

Run from `qa-pilot/`.

- `npm install`, then `npm rebuild better-sqlite3` if Node was upgraded (the checkpointer is native).
- `npm test` - vitest across orchestrator, mini-shop and ui; the graph tests drive real Chromium against mini-shop.
- `npm run typecheck` and, in `ui/`, `npx eslint`.
- `npm run shop` (port 3005), `npm run api` (port 4000), `npm run ui` (port 3000).
- `QA_PILOT_STORE=memory npm run api` runs without MongoDB; data is lost on restart.
- `npm run qa-pilot -- <url>` - the CLI, which keeps its own flags for flows, budget and healing.

Configuration is in `qa-pilot/.env`; `qa-pilot/.env.example` lists every setting.

## Pipeline

`orchestrator/src/graph.ts`: explore -> plan -> evaluate_coverage -> review -> generate -> run -> classify -> await_defect_confirmation -> report, with heal and rerun loops after classify.
Every branch writes a `Decision` to the event bus; that stream is the live view and must stay explicit.
`review` and `await_defect_confirmation` are interrupt nodes; `run.ts` parks the run at each and resumes it when the API receives the person's answer.

Rules to keep:
- The web API (`POST /run`) sets the flow cap, budget, plan review and healing from the account's tier (`billing/tiers.ts`); a client cannot choose them.
- No defect is filed without a `confirmed` ruling; `integrations/file.ts` enforces this for both the owner and the agent.
- The classifier's rules set the label; the model may move a confidence by at most 0.2.

## Integrations

- Payments: `billing/pinelabs.ts` (hosted checkout, Standard Webhooks signature check), routes `/checkout`, `/webhooks/pinelabs`, `/checkout/return`. A payment grants one credit exactly once.
- Triage agent: qa-pilot serves its tools as a remote MCP server at `/mcp` (`triage/mcp.ts`, bearer `QA_PILOT_AGENT_TOKEN`) and runs the custom AgenticOrg agent through `POST /api/v1/agents/{id}/run` (`triage/agenticorg.ts`) when a run holds candidates. AgenticOrg's A2A endpoint only runs its built-in agent types. The run is synchronous on their side, so it is never awaited while a run is paused.
- Trackers: Linear and Jira through Composio (`integrations/`).

The Pine Labs response fields are not pinned down by their docs, so that client reads them defensively. The triage agent lives on the hackathon deployment, https://agenticorg.hackathon.pinelabs.com (agent "QA Triage", connector `mcp_qapilot_triage`); it is granted only `list_candidate_defects` and drafts the owner's message. AgenticOrg is source-available (github.com/mishrasanjeev/agentic-org); its source is the reference for request shapes and key scopes.
