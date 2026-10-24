"use client";
import { Card, CardRow, Icon, Spinner } from "@/components/ui";
import type { Wallet } from "@/lib/api";

/**
 * What the next run will be: the free first run, a paid run already bought, or nothing until
 * the person pays. The limits come from the server, which is what enforces them; this card
 * only says what they are. Paying is the action bar's job, like starting a run.
 */
export function RunTierCard({ wallet, error }: { wallet: Wallet | null; error: string | null }) {
  return (
    <Card title="Run">
      <CardRow>
        <div className="space-y-3 py-4">
          {!wallet ? (
            error ? (
              <p className="flex items-center gap-2 text-[13px] text-fail"><Icon name="alert" size={14} /> {error}</p>
            ) : (
              <p className="flex items-center gap-2 text-[13px] text-muted"><Spinner /> Checking your runs</p>
            )
          ) : !wallet.freeRunUsed ? (
            <TierLine icon="sparkles" title="Your first run is free" limits={wallet.tiers.free} />
          ) : wallet.paidCredits > 0 ? (
            <TierLine
              icon="bolt"
              title={`${wallet.paidCredits} paid ${wallet.paidCredits === 1 ? "run" : "runs"} available`}
              limits={wallet.tiers.paid}
            />
          ) : (
            <TierLine icon="bolt" title={`Your free run is used. A run costs ₹${wallet.priceInr}, paid with Pine Labs.`} limits={wallet.tiers.paid} />
          )}
          <p className="text-[12.5px] leading-relaxed text-muted">
            You approve the test plan before any test is generated, and you confirm each defect before it is filed.
          </p>
        </div>
      </CardRow>
    </Card>
  );
}

function TierLine({ icon, title, limits }: { icon: "sparkles" | "bolt"; title: string; limits: { maxFlows: number; maxMinutes: number } }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-input border border-line bg-inset text-info">
        <Icon name={icon} size={12} />
      </span>
      <div>
        <p className="text-[13.5px] font-medium tracking-[0.2px] text-fg">{title}</p>
        <p className="mt-0.5 text-[12.5px] text-muted">
          Up to <span className="font-mono text-fg">{limits.maxFlows}</span> flows and <span className="font-mono text-fg">{limits.maxMinutes}</span> minutes.
        </p>
      </div>
    </div>
  );
}
