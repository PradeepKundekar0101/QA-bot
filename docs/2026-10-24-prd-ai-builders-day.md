# PRD - qa-pilot: paste a URL, get a tested app (AI Builders Day edition)

Oct 24, 2026 · @Conch Dev

## Overview

qa-pilot takes a web app URL, explores it, proposes a test plan for the developer to approve, generates and runs Playwright tests, and returns a report that separates real defects from broken scripts, with a human confirming every defect before it is filed.

**Problem.**
AI tools can plan, write and heal tests, but none decide when to do each, whether the output is good enough, or whether a red test is a script problem or an app bug.
Developers still do that coordination by hand, and most apps shipped in a day ship with no tests at all.
The track sheet names "testing, code review, docs, deploys" as the wall every shipper hits.

**Context.**
Built on 24 Oct 2026 for Airtribe × Pine Labs AI Builders Day, Track 03 "AI for Builders", starting point "Dev workflow: testing".
Hard requirements: live product, at least one agent on AgenticOrg with a human in the loop, a Pine Labs payment flow, 20 real free users or 5 paying users at submission, a ≤2-minute demo video, public LinkedIn and X/Instagram posts.

**What changed from the original [qa-pilot spec](https://github.com/PradeepKundekar0101/qa-pilot)**

| Original (Bessemer spec) | This edition | Why |
| --- | --- | --- |
| Fully autonomous, "no human step in between" | Human approves the plan and confirms each defect | The track scores human approval where a mistake costs real money or reputation |
| No pricing | Pay-per-run via Pine Labs; first run free | Payment flow is a hard requirement; the run budget already exists in the spec |
| No AgenticOrg | Defect-triage and follow-up agent runs on AgenticOrg | At least one agent doing a real job must live there |
| Auto-heal up to 2 attempts, re-plan loop up to 3 | Heal cut to P2; one re-plan at most | One-day scope; healing is the hardest part to demo well |
| 40-minute default budget, 12 flows | 5-minute demo budget, 6 flows; 15 minutes and 12 flows on paid runs | A 2-minute video and a queue of walk-up users |
| CLI first | Web app first, CLI optional | Walk-up users in the room paste a URL, they do not install a CLI |

**Pitch line for the video.**
"Paste your URL. Approve the plan. Get real bugs, not red tests."

## Target users

Every team in the room will have a deployed URL and no tests by mid-afternoon, so the first 20 users are a walk away.

| Persona | Who they are | What they need from qa-pilot | Why they pay |
| --- | --- | --- | --- |
| Hackathon team (day-one primary) | 3–5 builders with a live URL and 2 hours to submission | A defect list they can fix before the jury checks the app live | Avoiding a public failure in Round 2 |
| Solo developer or SDET (primary after today) | Running web app, no suite, no time to write one | A passing Playwright suite committed to their repo and a report they trust | Hours of test writing replaced by one run |
| Vibe-coder or non-technical founder | Shipped with Lovable or Replit, cannot read a stack trace | A plain-language bug list with screenshots, and a human-readable test plan | Confidence before showing customers |

Out of scope for the day: native mobile apps, apps behind SSO or MFA, APIs without a UI, cross-browser matrices.

## Goals, non-goals and success metrics

The day is won if one other team from the room runs qa-pilot on their live URL, approves the plan, confirms a real defect, and fixes it before the jury's live check.

**Goals**

1. One builder from the room completes URL → approved plan → report → confirmed defect end to end (Deliverable 2).
2. 20 real signups with at least one run each by Round 1 submission; 5 paid runs is the stretch.
3. Every run shows its orchestrator decisions live; the jury sees why the agent chose to generate, rerun or escalate.
4. Zero defects filed without a human confirming them.

**Non-goals for 24 Oct**

- Auto-healing broken tests (P2; shown as a proposed fix the user accepts, if at all).
- Fixing application code or opening pull requests against the target app.
- CI integration, cross-browser runs, apps that need MFA or OAuth-only login.
- Any hand-written test; all specs come from the pipeline.

**Success metrics**

| Metric | Round 1 target | Round 2 target (7 PM) |
| --- | --- | --- |
| Real signups with one run | 20 | 40 |
| Paid runs (Pine Labs, test mode allowed) | 3 | 5 |
| Runs that reach a report | 80 % of starts | 90 % |
| Median time URL → plan ready for approval | under 3 min | under 2 min |
| Median time approval → report | under 5 min | under 5 min |
| Confirmed real defects found in other teams' apps | 10 | 25 |
| Generated tests passing on first run | 70 % | 80 % |

## User journey

(Embedded diagram in the original: user journey - 9 steps, 2 human decisions.)

The agent explores and proposes; the developer approves the plan before any test is generated and confirms each defect before the AgenticOrg agent files it; flaky tests rerun once, and a flow added in plain words goes back through the planner.

## Functional requirements

P0 is the demo path and must work by 2 PM; P1 lands if P0 is stable; P2 is mentioned in the video, not shown.

| ID | Module | Requirement | Priority |
| --- | --- | --- | --- |
| F1 | Intake | Sign up with email and password (no Google sign-in); submit a URL, optional credentials, optional intent text ("focus on checkout"), optional PRD upload | P0 |
| F2 | Explorer | Same-origin BFS crawl, depth ≤ 3, max 20 pages; records routes, forms, buttons, gated pages into a site map | P0 |
| F3 | Planner | Produces up to 6 flows (12 on paid runs) with category, priority, steps and expected states; every step references an element seen in a snapshot | P0 |
| F4 | Coverage check | Scores the plan against forms, gated routes, intent and PRD; one re-plan if score < 0.75 | P1 |
| F5 | Plan approval | User sees the plan as a checklist, can untick flows or add one in plain words, then approves; nothing is generated before this | P0 |
| F6 | Generator | One flow → one `.spec.ts`; selectors validated live against the app before the file is saved | P0 |
| F7 | Runner | Runs the suite with traces and screenshots; parses the JSON report; captures console and network errors | P0 |
| F8 | Classifier | Labels each failure script / defect / flaky / env with a confidence and the evidence used | P0 |
| F9 | Defect confirmation | Each candidate defect is shown with screenshot, trace and classifier reasoning; the user confirms, rejects or marks "script bug" | P0 |
| F10 | AgenticOrg triage agent | Files confirmed defects, writes the repro steps, and follows up with the owner (see its section) | P0 |
| F11 | Live view | Decision stream and browser screenshots update in real time during the run | P0 |
| F12 | Report | Markdown + HTML report, downloadable zip of specs and traces | P1 |
| F13 | Payment | First run free; paid runs via Pine Labs checkout before the run starts | P0 |
| F14 | Budget | Every run has a cap in minutes and model calls; exceeding it ends the run with a partial report | P0 |
| F15 | Repo export | "Push tests to my repo" via a GitHub token, as a branch | P2 |
| F16 | Healer | Proposes a repair for script failures; user accepts before it is applied; never weakens an assertion | P2 |
| F17 | Dashboard | User's runs, defects, spend, and the public share link for a report | P1 |

## Pricing, payment flow and run budget

The first run is free so the 20-user bar is easy; every later run is paid up front through Pine Labs, which is also where the human commits money and the budget gets fixed.

| Tier | Price | Budget | Flows | Who |
| --- | --- | --- | --- | --- |
| Free run | ₹0, one per account | 5 min, 60 model calls | 6 | Everyone in the room |
| Paid run | ₹99 (test mode on the free route) | 15 min, 200 model calls | 12 | Teams before the jury's live check |
| Team day pass | ₹499 | 5 paid runs | 12 each | Stretch, only if checkout is stable |

**Payment flow**

1. User submits a URL. If they have a free run left, the run starts; otherwise they see the price and a Pine Labs checkout.
2. Pine Labs webhook confirms payment; the run record moves to `paid` and the budget is written on it.
3. The orchestrator reads the budget from the run record and enforces it; a run that exceeds it returns `partial: true` and the report says so.
4. A run that fails before the plan is produced is refunded as a credit, not money, to keep the day simple.

Prices are placeholders in ₹ for the room; the open question on currency and the Pine Labs product issued at kickoff is in the risks section.

## AgenticOrg agent: defect triage and follow-up

The AgenticOrg agent is qa-pilot's QA lead: it owns every confirmed defect from filing to follow-up.
Switch it off and no bug reaches the developer, which is the flyer's test for a real job.

| Field | Value |
| --- | --- |
| Trigger | A run finishes classification (webhook from the qa-pilot API) |
| Inputs | Candidate defects with confidence, evidence (screenshot, trace link, console errors), the run owner's contact |
| Job | Write a plain-language repro for each candidate; send the owner a confirmation request; on confirmation, file the defect (GitHub issue, Linear ticket or email, whichever the owner connected); follow up after 2 hours if unfixed; rerun only the affected tests on request |
| Tools | qa-pilot defects API (read, mark confirmed or rejected), GitHub or Linear issue creation, email or WhatsApp |
| Human in the loop | No defect is filed until the owner confirms it; candidates below 0.6 confidence are shown as "needs a look" and never auto-filed |
| Output | Filed issues with repro steps and evidence links; follow-up messages; a resolution log |
| Log | Every message, confirmation and filing with timestamps (the jury asks for agent logs) |

**Human approval points across the product**

1. Plan approval: the developer unticks or adds flows before any test is generated. This is where wasted budget would happen.
2. Defect confirmation: a human decides script bug vs real bug before anything is filed. This is where a false alarm costs a teammate's time and the team's credibility.
3. Paid run: the user pays a fixed price before the run; the budget is fixed by that payment.
4. Heal acceptance (P2): a proposed script fix is applied only when the user accepts it.

Optional second agent if time allows: an onboarding agent that messages signups who have not started a run after 30 minutes, which also helps the Round 2 count.

## Orchestrator decisions and failure classification

The orchestrator is a LangGraph state machine whose every branch writes a `Decision {node, reason, evidence, next}` to the run; that stream is the live view and the demo.

**Nodes.**
explore → plan → evaluate\_coverage → await\_plan\_approval → generate → run → classify → await\_defect\_confirmation → report.
`heal` sits between classify and run as P2.

**Conditional edges**

| After node | Condition | Next |
| --- | --- | --- |
| evaluate\_coverage | score ≥ 0.75, or already re-planned once | await\_plan\_approval |
| evaluate\_coverage | score < 0.75 and no re-plan yet | plan, with the gap list injected |
| await\_plan\_approval | user approves | generate, only ticked flows |
| await\_plan\_approval | user adds a flow in plain words | plan, for that flow only, then back to approval |
| classify | any flaky | run, only those tests, once |
| classify | any candidate defect | await\_defect\_confirmation |
| classify | all passed, or only script failures | report |
| await\_defect\_confirmation | user confirms or rejects all | report; AgenticOrg agent files the confirmed ones |
| any | budget exceeded | report with partial: true |

**Failure classification**

| Label | Signals | Default confidence | What happens |
| --- | --- | --- | --- |
| defect | Assertion on app behaviour fails; console or network error present; element found but wrong state | 0.7, raised by matching console or 5xx evidence | Candidate shown to the user with evidence |
| script | Selector not found; timeout before interaction; element exists under a different role or name in the snapshot | 0.8 | Listed as "test needs a fix"; heal proposal in P2 |
| flaky | Passes on rerun; timing-related error text | 0.6 | Rerun once; reported as flaky if it passes |
| env | Target unreachable; auth wall; rate limit | 0.9 | Run paused with a plain message to the user |

Rules first, model second: deterministic signals (selector missing, HTTP status, rerun result) set the label; the model writes the reasoning sentence and may adjust confidence by at most ±0.2.
The jury sees the signals, not just a verdict.

## Architecture and tech stack

(Embedded diagram in the original: architecture - 9 components.)

The API owns run state, budgets and both approvals; the worker is stateless per run and only explores, generates and runs; the AgenticOrg agent is the only path from a confirmed defect to the owner's tracker.

| Layer | Choice | Reason |
| --- | --- | --- |
| Web app | Next.js on Vercel or Cloudflare Pages; SSE for the decision stream | Live view is a goal; SSE is enough for one viewer per run |
| API and data | Node API (Hono), MongoDB for accounts, sessions, runs, wallets and payments; traces and screenshots on the API host | Already built and tested; every record is timestamped for proof |
| Orchestrator | LangGraph with a Postgres checkpointer, as in the original spec | Pause and resume at the two human approval nodes |
| Browser tools | Playwright MCP for explore, selector validation and healing; Playwright CLI for the suite | Same stack as the original spec; MCP snapshots keep selectors grounded |
| Worker hosting | One VM with headless Chromium, one run per account at a time, queue in Postgres | Walk-up load on the day; container per run is a later step |
| Agent | AgenticOrg defect-triage agent, webhooks to the API | Track requirement |
| Payments | Pine Labs checkout and webhook on the run record | Track requirement; budget fixed at payment |
| Model calls | Claude via the Agent SDK or API for planner, generator, classifier reasoning | Budget counted in calls per run |
| Proof | MongoDB `users` collection, Pine Labs dashboard, AgenticOrg logs, decisions.jsonl per run | The jury asks for all of them, timestamped |

## Hackathon deliverables and day plan

One teammate owns users, posts and video from the first hour; the rest build the P0 path.
Walk the room with a QR code the moment a free run reaches a report.

| Track requirement | How qa-pilot meets it | Owner |
| --- | --- | --- |
| Live product URL | Next.js web app with the live run view | Frontend owner |
| 1+ agent on AgenticOrg with a human in the loop | Defect-triage agent; files only after owner confirmation | Agent owner |
| Pine Labs payment flow | Paid run checkout before the run starts (test mode acceptable) | Backend owner |
| 20 free or 5 paying real users | One free run per account; every team in the room has a URL | Growth owner |
| One builder end to end | A volunteer team's live URL run on camera, plan approved, one defect confirmed | Growth owner |
| Demo video ≤ 2 min | Decision stream + browser view + defect confirmation on a real app | Growth owner |
| LinkedIn + X/Instagram posts tagging Airtribe and Pine Labs | Posted with a public report link from a real run | Growth owner |
| Proof: signup and payment dashboards, agent logs, timestamps | MongoDB `users` collection, Pine Labs dashboard, AgenticOrg logs, decisions.jsonl per run | Backend owner |

**Build order on the day**

1. Hour 0–1: repo, MongoDB connection and email sign-up, deploy pipeline for qa-pilot itself; Playwright MCP wired to the worker; AgenticOrg access and agent draft.
2. Hour 1–3: explore → plan → plan approval UI (F1–F3, F5). Open free signups once a plan renders for a real URL.
3. Hour 3–5: generate → run → classify → defect confirmation (F6–F9); decision stream in the UI (F11); budget enforcement (F14).
4. Hour 5–6: AgenticOrg triage agent end to end (F10); Pine Labs paid run (F13).
5. Hour 6–7: run against 5 other teams' apps, fix what breaks, report page (F12).
6. Hour 7–8: volunteer run on camera, video, posts, submission form.
7. After submission to 7 PM: dashboard (F17), coverage re-plan (F4), onboarding agent, Round 2 user push.

## Risks and open questions

The biggest technical risk is generated tests that fail for script reasons on apps built that same day; the biggest product risk is spending the morning on the orchestrator and reaching 2 PM with no users.

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Generated specs fail on first run because of selectors | High | High | Validate every selector live before saving; prefer role and name locators; cap at 6 flows on free runs |
| Target apps are half-built and change mid-run | High | Medium | Snapshot the site map at run start; label mismatches as env, not defect; short runs |
| Login-gated apps cannot be explored | Medium | Medium | Accept plain-text login steps; skip gated routes with a note in the plan |
| Classifier calls a script bug a defect | Medium | High | Rules set the label; human confirms before filing; show evidence |
| Playwright worker is slow or crashes under walk-up load | Medium | High | One run per account at a time; queue with a visible position; 5-minute budget |
| AgenticOrg agent feels bolted on | Medium | Medium | Make it the only path by which a defect reaches the owner; show its log in the video |
| Pine Labs integration slips | Medium | High | Start in hour 1 with the help desk; free runs carry the user count regardless |
| Fewer than 20 real signups | Low | High | Free run, no install, QR code at tables, results shareable |
