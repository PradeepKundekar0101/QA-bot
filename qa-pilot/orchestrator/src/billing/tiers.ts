/**
 * What a run is allowed to spend, fixed by how it was paid for.
 *
 * A web run never chooses its own budget or flow cap: the account's first run is free and
 * small, every later one is paid for up front and gets the larger allowance. The numbers are
 * the PRD's (AI Builders Day edition, "Pricing, payment flow and run budget"). The CLI is the
 * operator's own tool and keeps its flags.
 */
export type Tier = "free" | "paid";

export type TierLimits = {
  /** What the run costs, in rupees. */
  priceInr: number;
  maxFlows: number;
  budget: { maxMinutes: number; maxLlmCalls: number };
};

export const TIERS: Record<Tier, TierLimits> = {
  free: { priceInr: 0, maxFlows: 6, budget: { maxMinutes: 5, maxLlmCalls: 60 } },
  paid: { priceInr: 99, maxFlows: 12, budget: { maxMinutes: 15, maxLlmCalls: 200 } },
};

/** The price of one paid run in paisa, the unit payment gateways take. */
export const PAID_RUN_PAISA = TIERS.paid.priceInr * 100;
