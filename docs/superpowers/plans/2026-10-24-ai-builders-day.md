# AI Builders Day edition - build plan

Spec: [`docs/2026-10-24-prd-ai-builders-day.md`](../../2026-10-24-prd-ai-builders-day.md).
The Bessemer build in `qa-pilot/` already covers explore, plan, coverage, generate, run, classify, report, live view and budgets.
This plan lists only the deltas, in the order they land.

## Decisions

- Storage and accounts stay on MongoDB with email and password sign-up. Supabase and Google sign-in are dropped (decided 24 Oct).
- The web API decides tier, budget, flow cap and plan review on the server; the client can no longer choose its own budget.
  The CLI keeps its flags.
- Healing becomes opt-in (`heal: false` by default on web runs), because the PRD makes heal acceptance a human decision (P2).

## Steps

1. **Tiers and limits (F3, F14).**
   `billing/tiers.ts` defines free (5 min, 60 calls, 6 flows) and paid (15 min, 200 calls, 12 flows).
   `POST /run` resolves the tier: the first run on an account is free, later runs need a paid credit, otherwise `402` with the price.
   `RunRecord` gains `tier`.
   One re-plan at most (`MAX_PLAN_ITERATIONS = 2`), one flaky rerun (`MAX_RERUNS = 1`).
2. **Plan approval always on (F5).**
   Web runs always pause at review.
   `POST /runs/:id/review/flows` takes a flow described in plain words, plans and dry-walks just that flow against the run's site map, and returns it for the checklist.
3. **Heal opt-in (F16).**
   `RunInput.heal` defaults to false; with heal off a script failure is reported as "test needs a fix" and never patched.
4. **Defect confirmation gate (F9).**
   New graph node `await_defect_confirmation`, interrupted before like `review`.
   The classifier's candidate defects are written to `defects.json`; the run records `awaiting_confirmation`.
   `POST /runs/:id/defects` takes a verdict per defect (`confirmed`, `rejected`, `script`); when every candidate has one, the run resumes into the report.
   Candidates under 0.6 confidence carry `needsLook: true`.
   The model may move a confidence by at most ±0.2.
5. **AgenticOrg hand-off (F10).**
   After classification, the API posts candidates to the AgenticOrg agent's trigger URL; the agent reads and confirms defects through an API-key-authenticated defects API and logs every filing.
   No defect is filed by qa-pilot itself without a confirmed verdict.
6. **Pine Labs paid runs (F13).**
   `POST /checkout` creates a Pine Labs order and returns the hosted checkout URL; the webhook verifies the signature and grants one paid credit.
7. **UI.**
   Start form without budget fields and with tier and price; plan checklist with "add a flow"; defect confirmation cards with screenshot, trace and reasoning; checkout redirect.

Each step lands with tests, and the full suite stays green between steps.
