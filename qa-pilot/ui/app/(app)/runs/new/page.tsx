"use client";
import { useCallback, useEffect, useReducer, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button, Card, CardRow, Checkbox, Field, Flash, Icon, Input, Segmented, Spinner, Textarea, Wallpaper } from "@/components/ui";
import { RunTierCard } from "@/components/billing/RunTierCard";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ApiError, getPayment, getWallet, startCheckout, startRun, type Wallet } from "@/lib/api";
import { DEFAULT_DRAFT, formReducer, isValidUrl, runInputFromDraft, snapshotOf, type DraftField, type DraftPatch, type RunDraft } from "@/lib/draft";

/** How long a field the assistant wrote stays ringed. Long enough to catch, short enough to ignore. */
const FLASH_MS = 1600;

/**
 * Where the form waits while the browser is away at the Pine Labs checkout. The snapshot
 * never holds the target app's credentials, so they are typed again after paying.
 */
const STASH_KEY = "qa-pilot:new-run-draft";
/** How long to wait for Pine Labs to confirm a payment the browser came back from. */
const PAYMENT_POLL_MS = 2000;
const PAYMENT_POLL_TRIES = 30;

type PaymentNotice = { tone: "info" | "pass" | "fail"; text: string };

function stash(draft: RunDraft): void {
  try {
    sessionStorage.setItem(STASH_KEY, JSON.stringify(snapshotOf(draft)));
  } catch {
    // Storage blocked: the person retypes the URL after paying, nothing worse.
  }
}

function takeStash(): DraftPatch | null {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    sessionStorage.removeItem(STASH_KEY);
    return raw ? (JSON.parse(raw) as DraftPatch) : null;
  } catch {
    return null;
  }
}

export default function NewRunPage() {
  const router = useRouter();
  const [{ draft, flash }, dispatch] = useReducer(formReducer, { draft: DEFAULT_DRAFT, flash: [] });
  const [chatId, setChatId] = useState<string | null>(null);
  const [prdMode, setPrdMode] = useState<"upload" | "paste">("upload");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [payment, setPayment] = useState<PaymentNotice | null>(null);
  const params = useSearchParams();
  const canRun = wallet !== null && (!wallet.freeRunUsed || wallet.paidCredits > 0);

  const loadWallet = useCallback(() => {
    getWallet().then((w) => { setWallet(w); setWalletError(null); }).catch((err) => setWalletError((err as Error).message));
  }, []);
  useEffect(() => { loadWallet(); }, [loadWallet]);

  // Coming back from the checkout: restore the form, then wait for Pine Labs to confirm. The
  // return URL only says what the browser saw; the wallet is what decides.
  const returned = params.get("payment");
  const ref = params.get("ref");
  useEffect(() => {
    if (!returned) return;
    let cancelled = false;
    (async () => {
      const saved = takeStash();
      if (saved) dispatch({ kind: "load", patch: saved });
      router.replace("/runs/new", { scroll: false });
      if (returned === "failed" || !ref) {
        setPayment({ tone: "fail", text: "The payment did not go through. Nothing was charged; try again." });
        return;
      }
      setPayment({ tone: "info", text: "Waiting for Pine Labs to confirm the payment." });
      for (let i = 0; i < PAYMENT_POLL_TRIES && !cancelled; i++) {
        const status = await getPayment(ref).catch(() => "created" as const);
        if (status === "paid") {
          setPayment({ tone: "pass", text: "Payment received. Your paid run is ready to start." });
          loadWallet();
          return;
        }
        if (status === "failed") {
          setPayment({ tone: "fail", text: "The payment did not go through. Try again." });
          return;
        }
        await new Promise((r) => setTimeout(r, PAYMENT_POLL_MS));
      }
      if (!cancelled) setPayment({ tone: "info", text: "Pine Labs has not confirmed the payment yet. Your run will be available here as soon as it does." });
    })();
    return () => { cancelled = true; };
  }, [returned, ref, router, loadWallet]);

  async function pay() {
    setError(null);
    setBusy(true);
    try {
      const { redirectUrl } = await startCheckout();
      stash(draft);
      window.location.assign(redirectUrl);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const lit = (field: DraftField) => flash.includes(field);
  const edit = (fields: Partial<RunDraft>) => dispatch({ kind: "edit", fields });

  useEffect(() => {
    if (flash.length === 0) return;
    const timer = setTimeout(() => dispatch({ kind: "clearFlash" }), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  async function readPrdFile(file: File) {
    setError(null);
    try {
      edit({ prdText: await file.text(), prdName: file.name });
    } catch {
      edit({ prdName: "" });
      setError(`Could not read ${file.name}. Try again or paste the PRD instead.`);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const runId = await startRun(runInputFromDraft(draft, chatId ?? undefined));
      // A fresh run has nothing but its crawl, so it opens on Sources - the stage that is
      // actually running - rather than on a Test Runs screen with an empty table.
      router.push(`/runs/${encodeURIComponent(runId)}/sources`);
    } catch (err) {
      // Another tab may have spent the last run since the wallet was read.
      if (err instanceof ApiError && err.status === 402) loadWallet();
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen">
      <form onSubmit={submit} className="flex min-h-screen min-w-0 flex-1 flex-col">
        <Wallpaper name="prism" />
        <PageHeader
          crumbs={[{ label: "Runs", href: "/" }, { label: "New run" }]}
          title="Start a run"
          subtitle="Tell AEGIS what to test, in the form or in the chat. It explores the app and writes a plan for you to approve, then generates Playwright tests, runs them, and asks you to confirm each defect it finds."
        />

        <div className="mx-auto w-full max-w-[960px] flex-1 space-y-4 px-6 pb-32 pt-5">
          <Card title="Target">
            <CardRow>
              <Field label="URL" required help="The URL of the app AEGIS should test.">
                <Flash on={lit("url")}>
                  <Input value={draft.url} onChange={(e) => edit({ url: e.target.value })} placeholder="https://app.example.com" required />
                </Flash>
              </Field>
            </CardRow>
            <CardRow>
              <Field label="Intent" help="Natural-language scoping, for example: focus on auth and checkout. Leave blank to let the planner cover the whole app.">
                <Flash on={lit("intent")}>
                  <Input value={draft.intent} onChange={(e) => edit({ intent: e.target.value })} placeholder="focus on auth and checkout" />
                </Flash>
              </Field>
            </CardRow>
          </Card>

          <Card title="Sign in to the target app">
            <CardRow>
              <div className="space-y-4 py-4">
                <Flash on={lit("requiresSignIn")} className="-m-1 p-1">
                  <Checkbox
                    checked={draft.requiresSignIn} onChange={(v) => edit({ requiresSignIn: v })} label="Require sign in?"
                    help="Check this if parts of the app are behind a login. AEGIS signs in with a test account so it can reach those flows. These credentials are used for the run and are never stored."
                  />
                </Flash>
                {draft.requiresSignIn && (
                  <div className="grid gap-2.5 pl-7 sm:grid-cols-2">
                    <Input value={draft.username} onChange={(e) => edit({ username: e.target.value })} placeholder="username or email" autoComplete="off" aria-label="Target app username" />
                    <Input value={draft.password} onChange={(e) => edit({ password: e.target.value })} type="password" placeholder="password" autoComplete="off" aria-label="Target app password" />
                  </div>
                )}
              </div>
            </CardRow>
          </Card>

          <Card title="Add sources">
            <CardRow>
              <Field label="Add sources" help="AEGIS extracts requirements from the document and maps each one onto a planned flow, then reports the ones nothing covers.">
                <div className="space-y-3">
                  <Flash on={lit("prd")}>
                    <div className="rounded-box border border-line bg-inset p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-[13.5px] font-medium tracking-[0.2px] text-fg">Product Requirements Doc (PRD)</p>
                          <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted">
                            <Icon name="sparkles" size={12} /> Strongly recommended
                          </p>
                        </div>
                        <Segmented
                          options={[{ value: "upload", label: "Upload" }, { value: "paste", label: "Paste" }]}
                          value={prdMode} onChange={setPrdMode}
                        />
                      </div>

                      <div className="mt-4">
                        {prdMode === "upload" ? (
                          <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-input border border-line-strong px-3.5 text-sm font-medium tracking-[0.2px] text-fg transition-colors hover:bg-selected">
                            <Icon name="download" size={13} className="rotate-180" />
                            {draft.prdName || "Upload PRD"}
                            <input
                              type="file" accept=".md,.txt,.markdown,text/plain,text/markdown" className="sr-only"
                              onChange={(e) => { const f = e.target.files?.[0]; if (f) void readPrdFile(f); }}
                            />
                          </label>
                        ) : (
                          <Textarea
                            value={draft.prdText} onChange={(e) => edit({ prdText: e.target.value, prdName: "" })}
                            className="h-32" placeholder="Paste the requirements here"
                          />
                        )}
                      </div>
                    </div>
                  </Flash>
                </div>
              </Field>
            </CardRow>
          </Card>

          <RunTierCard wallet={wallet} error={walletError} />
        </div>

        {/* Sticky action bar. The primary stays disabled until the URL parses, so the bar is
            also the validity readout - and the one place a run can be started from. */}
        <div className="sticky bottom-0 z-20 border-t border-line bg-surface/90 px-6 py-3.5 backdrop-blur-md">
          {payment && (
            <p role="status" className={`mx-auto mb-3 flex max-w-[960px] items-center gap-2 rounded-input border px-3 py-2 text-[13px] ${
              payment.tone === "pass" ? "border-pass/25 bg-pass/10 text-pass" : payment.tone === "fail" ? "border-fail/25 bg-fail/10 text-fail" : "border-info/25 bg-info/10 text-info"
            }`}>
              {payment.tone === "info" ? <Spinner /> : <Icon name={payment.tone === "pass" ? "check" : "alert"} size={14} />} {payment.text}
            </p>
          )}
          {error && (
            <p role="alert" className="mx-auto mb-3 flex max-w-[960px] items-center gap-2 rounded-input border border-fail/25 bg-fail/10 px-3 py-2 text-[13px] text-fail">
              <Icon name="alert" size={14} /> {error}
            </p>
          )}
          <div className="mx-auto flex max-w-[960px] items-center justify-between gap-3">
            <p className="hidden text-[12.5px] text-muted sm:block">
              {!isValidUrl(draft.url) ? "Enter a valid http(s) URL to continue."
                : wallet && !canRun ? "Pay for a run to start it. You come back here afterwards."
                : "Ready. AEGIS will explore, then wait for you to approve the plan."}
            </p>
            <div className="flex flex-1 justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => router.push("/")}>Cancel</Button>
              {wallet && !canRun ? (
                <Button type="button" onClick={pay} disabled={busy || !isValidUrl(draft.url)}>
                  {busy ? <><Spinner /> Opening checkout</> : <>Pay ₹{wallet.priceInr}</>}
                </Button>
              ) : (
                <Button type="submit" disabled={busy || !canRun || !isValidUrl(draft.url)}>
                  {busy ? <><Spinner /> starting</> : "Start run"}
                </Button>
              )}
            </div>
          </div>
        </div>
      </form>

      {/*
        Outside the form on purpose: the composer's Enter key and the panel's buttons must
        never be able to submit a run. Only the action bar above starts one.
      */}
      <ChatPanel
        draft={draft}
        chatId={chatId}
        onChatId={setChatId}
        onPatch={(patch) => dispatch({ kind: "patch", patch })}
        onLoadDraft={(patch) => dispatch({ kind: "load", patch })}
        onCredentials={(next) => edit(next)}
      />
    </div>
  );
}
