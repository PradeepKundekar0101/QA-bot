"use client";
import { useEffect, useState } from "react";
import { Button, Icon, Spinner } from "@/components/ui";
import { agentHandoff, fileUrl, getDefects, getTriageLog, submitVerdicts, type AgentHandoff, type Defect, type DefectVerdict } from "@/lib/api";
import { artifactRel } from "@/lib/cases";
import { useRun } from "@/lib/run-context";

type Verdict = DefectVerdict["verdict"];

const CHOICES: { value: Verdict; label: string; help: string }[] = [
  { value: "confirmed", label: "Real bug", help: "File it" },
  { value: "rejected", label: "Not a bug", help: "The app is right" },
  { value: "script", label: "Test is wrong", help: "Fix the test, not the app" },
];

/** The agent runs after the gate opens and takes a few seconds; the sheet checks back for this long. */
const AGENT_POLL_MS = 3000;
const AGENT_POLL_TRIES = 40;

/**
 * What the AgenticOrg triage agent drafted for the owner. It has no way to rule or file -
 * AgenticOrg runs only read-only tools from a custom agent - so its work arrives here as a
 * message to send, and the rulings stay with the person below.
 */
function AgentPanel({ runId }: { runId: string }) {
  const [handoff, setHandoff] = useState<AgentHandoff | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let i = 0; i < AGENT_POLL_TRIES && !cancelled; i++) {
        const found = agentHandoff(await getTriageLog(runId).catch(() => []));
        if (found) { if (!cancelled) setHandoff(found); break; }
        await new Promise((r) => setTimeout(r, AGENT_POLL_MS));
      }
      if (!cancelled) setWaiting(false);
    })();
    return () => { cancelled = true; };
  }, [runId]);

  if (handoff?.state === "off" || (!handoff && !waiting)) return null;
  return (
    <section className="rounded-box border border-line bg-inset p-4" aria-label="Triage agent">
      <p className="flex items-center gap-2 text-[13px] font-medium tracking-[0.2px] text-fg">
        <Icon name="sparkles" size={13} className="text-info" /> Triage agent on AgenticOrg
      </p>
      {!handoff ? (
        <p className="mt-2 flex items-center gap-2 text-[12.5px] text-muted"><Spinner /> Drafting a message to the run&apos;s owner</p>
      ) : handoff.state === "held" ? (
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted">The agent&apos;s message is waiting for approval in AgenticOrg&apos;s approval queue.</p>
      ) : handoff.state === "failed" ? (
        <p className="mt-2 text-[12.5px] leading-relaxed text-fail">The agent could not draft a message: {handoff.reason}</p>
      ) : (
        <>
          <p className="mt-2 whitespace-pre-wrap rounded-input border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed text-body">{handoff.text}</p>
          <div className="mt-2 flex items-center gap-3">
            <Button
              type="button" variant="outline" size="sm"
              onClick={() => { void navigator.clipboard.writeText(handoff.text).then(() => setCopied(true)).catch(() => {}); }}
            >
              <Icon name={copied ? "check" : "clipboard"} size={12} /> {copied ? "Copied" : "Copy message"}
            </Button>
            <span className="text-[12px] text-subtle">Send it to whoever owns the app; their answers go in below.</span>
          </div>
        </>
      )}
    </section>
  );
}

const SEVERITY: Record<Defect["severity"], string> = {
  critical: "bg-defect/12 text-defect", high: "bg-defect/12 text-defect", medium: "bg-flaky/12 text-flaky", low: "bg-inset text-env",
};

/**
 * Shown while the run is parked at defect confirmation. Every candidate the classifier
 * escalated is laid out with what it saw - the failure screenshot, the evidence, the
 * reasoning, the trace - and the owner rules on each one. Nothing is filed until they do, and
 * the run's report waits for the last ruling. The triage agent can relay a ruling too; those
 * arrive here already decided.
 */
export function ConfirmDefectsModal() {
  const { runId } = useRun();
  const [defects, setDefects] = useState<Defect[] | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [decidedBy, setDecidedBy] = useState<Record<string, DefectVerdict["by"]>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDefects(runId)
      .then((r) => {
        if (cancelled) return;
        setDefects(r.defects);
        setVerdicts(Object.fromEntries(r.verdicts.map((v) => [v.defectId, v.verdict])));
        setDecidedBy(Object.fromEntries(r.verdicts.map((v) => [v.defectId, v.by])));
      })
      .catch((err) => { if (!cancelled) setLoadError((err as Error).message); });
    return () => { cancelled = true; };
  }, [runId]);

  const list = defects ?? [];
  const decided = list.filter((d) => verdicts[d.id]).length;
  const confirmed = list.filter((d) => verdicts[d.id] === "confirmed").length;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await submitVerdicts(runId, list.map((d) => ({ defectId: d.id, verdict: verdicts[d.id] })));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-6 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="animate-palette-in flex max-h-full w-full max-w-[1020px] flex-col overflow-hidden rounded-card border border-line bg-surface">
        <header className="flex items-start gap-3 border-b border-line px-6 py-4">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-box border border-line bg-inset text-human">
            <Icon name="bug" size={16} />
          </span>
          <div>
            <h2 id="confirm-title" className="text-[17px] font-medium tracking-[0.2px] text-fg">Confirm the defects</h2>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
              {defects === null ? "Loading what the classifier found." : `${list.length} ${list.length === 1 ? "failure looks" : "failures look"} like a bug in the app. Rule on each one; nothing is filed until you confirm it.`}
            </p>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
          {!loadError && <AgentPanel runId={runId} />}
          {loadError ? (
            <p role="alert" className="flex items-center gap-2 p-6 text-[13px] text-fail"><Icon name="alert" size={14} /> {loadError}</p>
          ) : defects === null ? (
            <div className="flex justify-center p-10"><Spinner size={20} /></div>
          ) : list.map((d) => {
            const shot = artifactRel(d.screenshot, runId);
            const trace = artifactRel(d.attachments[0], runId);
            return (
              <article key={d.id} className="rounded-box border border-line bg-app p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11.5px] font-medium ${SEVERITY[d.severity]}`}>{d.severity}</span>
                  {d.needsLook && <span className="rounded-full bg-flaky/12 px-2 py-0.5 text-[11.5px] font-medium text-flaky">needs a look</span>}
                  {d.confidence !== undefined && <span className="font-mono text-[11.5px] text-subtle">confidence {d.confidence.toFixed(2)}</span>}
                  <span className="font-mono text-[11.5px] text-subtle">{d.flow}</span>
                </div>
                <h3 className="mt-2 text-[14.5px] font-medium leading-snug text-fg">{d.title}</h3>

                <div className={`mt-3 grid gap-4 ${shot ? "md:grid-cols-[minmax(0,1fr)_17rem]" : ""}`}>
                  <div className="min-w-0 space-y-2.5 text-[13px] leading-relaxed">
                    {d.rationale && <p className="text-body">{d.rationale}</p>}
                    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1">
                      <dt className="text-subtle">Expected</dt><dd className="break-words text-body">{d.expected}</dd>
                      <dt className="text-subtle">Actual</dt><dd className="break-words font-mono text-[12px] text-body">{d.actual}</dd>
                    </dl>
                    {d.evidence.length > 0 && (
                      <ul className="space-y-0.5">
                        {d.evidence.slice(0, 5).map((e, i) => (
                          <li key={i} className="flex gap-2 text-[12.5px] text-muted"><span className="text-subtle">-</span><span className="min-w-0 break-words">{e}</span></li>
                        ))}
                      </ul>
                    )}
                    {trace && (
                      <a href={fileUrl(runId, trace)} download className="inline-flex items-center gap-1 text-[12.5px] font-medium text-info hover:underline">
                        <Icon name="download" size={12} /> Playwright trace
                      </a>
                    )}
                  </div>
                  {shot && (
                    <a href={fileUrl(runId, shot)} target="_blank" rel="noreferrer" className="block self-start overflow-hidden rounded-input border border-line bg-inset">
                      {/* eslint-disable-next-line @next/next/no-img-element -- served by the API with the session cookie, not by Next */}
                      <img src={fileUrl(runId, shot)} alt={`The page where ${d.flow} failed`} className="aspect-[16/10] w-full object-contain" />
                    </a>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3" role="radiogroup" aria-label={`Ruling on ${d.title}`}>
                  {CHOICES.map((c) => {
                    const on = verdicts[d.id] === c.value;
                    return (
                      <button
                        key={c.value} type="button" role="radio" aria-checked={on}
                        onClick={() => { setVerdicts((v) => ({ ...v, [d.id]: c.value })); setDecidedBy((b) => { const next = { ...b }; delete next[d.id]; return next; }); }}
                        className={`flex h-9 items-center gap-1.5 rounded-input border px-3 text-[13px] font-medium transition-colors ${on ? "border-line-strong bg-selected text-fg" : "border-line text-muted hover:bg-selected hover:text-fg"}`}
                      >
                        {on && <Icon name="check" size={12} />} {c.label}
                        <span className="hidden text-[11.5px] font-normal text-subtle sm:inline">{c.help}</span>
                      </button>
                    );
                  })}
                  {decidedBy[d.id] === "agent" && <span className="text-[12px] text-subtle">relayed by the triage agent</span>}
                </div>
              </article>
            );
          })}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-line px-6 py-3.5">
          <p className="text-[12.5px] leading-relaxed text-muted">
            <span className="font-mono text-fg">{decided}</span> of {list.length} decided, <span className="font-mono text-fg">{confirmed}</span> confirmed. The report is written once every candidate has a ruling.
          </p>
          <div className="flex items-center gap-3">
            {error && <p role="alert" className="flex items-center gap-1.5 text-[13px] text-fail"><Icon name="alert" size={14} /> {error}</p>}
            <Button onClick={submit} disabled={busy || list.length === 0 || decided < list.length}>
              {busy ? <><Spinner /> Saving</> : <><Icon name="check" size={13} /> Save rulings</>}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
