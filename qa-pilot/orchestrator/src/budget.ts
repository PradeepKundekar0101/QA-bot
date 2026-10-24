import type { RunState } from "./state.js";

export function budgetExceeded(state: RunState): string | null {
  if (state.llmCalls > state.budget.maxLlmCalls) return `llm calls ${state.llmCalls} > ${state.budget.maxLlmCalls}`;
  // Time spent waiting on a person at an approval gate is theirs, not the run's.
  const minutes = (Date.now() - Date.parse(state.startedAt) - state.pausedMs) / 60_000;
  if (minutes > state.budget.maxMinutes) return `minutes ${minutes.toFixed(1)} > ${state.budget.maxMinutes}`;
  return null;
}
