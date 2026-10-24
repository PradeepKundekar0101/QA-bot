"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui";
import { getWallet, type Wallet } from "@/lib/api";

/**
 * What the account can still run: the free first run, paid runs bought and not yet used, or
 * nothing until the next payment. The limits behind each kind are the server's; this card
 * only reports what is left and points at the start form, where paying happens.
 */
export function BudgetCard() {
  const [wallet, setWallet] = useState<Wallet | null>(null);

  useEffect(() => {
    getWallet().then(setWallet).catch(() => setWallet(null));
  }, []);

  if (!wallet) return null;
  const line = !wallet.freeRunUsed ? "Your first run is free."
    : wallet.paidCredits > 0 ? `${wallet.paidCredits} paid ${wallet.paidCredits === 1 ? "run" : "runs"} left.`
    : `No runs left. A run costs ₹${wallet.priceInr}.`;

  return (
    <div className="space-y-1.5 rounded-box border border-line bg-surface p-3">
      <p className="flex items-center gap-1.5 text-[12px] font-medium tracking-[0.2px] text-fg">
        <Icon name="bolt" size={13} className="text-muted" /> Runs
      </p>
      <p className="text-[11.5px] leading-relaxed text-muted">{line}</p>
      {wallet.freeRunUsed && wallet.paidCredits === 0 && (
        <Link href="/runs/new" className="inline-flex text-[11.5px] font-medium text-info hover:underline">Buy a run</Link>
      )}
    </div>
  );
}
