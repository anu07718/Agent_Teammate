import { Check, CheckCheck, ClipboardList, ExternalLink, FileSpreadsheet, Forward, Inbox, Phone, RotateCcw, ShieldAlert, ThumbsDown, ThumbsUp, Workflow, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, apiLink } from "../api";
import { ApprovalCard, DiffTable } from "../components/ApprovalCard";
import { Badge, Button, Card, Empty, KV, Mono, RouteBadge, StatusDot, Tabs, cx } from "../components/ui";
import { ACTION_LABEL, INTENT_LABEL, ago, clock, inr, pct, short } from "../lib/format";
import { oapi, type Op, type OfficeSnap } from "../office/data";
import { closeCase, openCase, setState, toast, useUI, EMPTY } from "../store";
import { showFlow } from "../flows/api";
import { capi, CHANNEL_LABEL, type Conv } from "../channels/api";
import type { CaseDetail, Score } from "../types";

const GROUPS: { id: string; label: string; test: (c: any) => boolean }[] = [
  { id: "approval", label: "Needs approval", test: (c) => c.pending },
  { id: "running", label: "Running", test: (c) => c.status === "running" },
  { id: "resolved", label: "Resolved", test: (c) => c.status === "resolved" },
  { id: "refused", label: "Refused", test: (c) => c.status === "refused" },
];

function CaseList({ className }: { className?: string }) {
  const cases = useUI((s) => s.app?.cases ?? EMPTY);
  const active = useUI((s) => s.activeCase);
  const [q, setQ] = useState("");
  const filtered = cases.filter((c) => !q || `${c.id} ${c.customer_name} ${c.intent} ${c.preview}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <aside className={cx("w-full shrink-0 flex-col border-r border-line bg-panel md:flex md:w-[280px]", className)}>
      <div className="border-b border-line p-2.5">
        <input aria-label="Filter cases" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter cases…"
          className="h-8 w-full rounded-md border border-line-strong bg-panel-2 px-2.5 text-[12.5px] outline-none focus:border-accent" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {GROUPS.map((g) => {
          const items = filtered.filter((c) => g.test(c) && (g.id === "approval" || !c.pending));
          if (!items.length) return null;
          return (
            <div key={g.id} className="mb-1">
              <div className="flex items-center justify-between px-3 py-1.5 caps text-faint">
                {g.label}<span>{items.length}</span>
              </div>
              {items.map((c) => (
                <button key={c.id} onClick={() => openCase(c.id)}
                  className={cx("flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left", active === c.id ? "bg-accent/12" : "hover:bg-panel-2")}>
                  <StatusDot status={c.pending ? "parked" : c.status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[11.5px]">{c.id}</span>
                      <span className="truncate text-[12px] text-muted">{c.customer_name}</span>
                    </div>
                    <div className="truncate text-[11.5px] text-faint">{c.intent ? INTENT_LABEL[c.intent] ?? c.intent : c.route === "REFUSE" ? "Refused at intake" : c.step}{c.amount ? ` · ${inr(c.amount)}` : ""}{c.opened_by ? ` · ${c.opened_by}` : ""}</div>
                  </div>
                  <RouteBadge route={c.route} />
                </button>
              ))}
            </div>
          );
        })}
        {!cases.length && <Empty title="No cases yet">Open the Office and send a message.</Empty>}
      </div>
    </aside>
  );
}

function ScoreBar({ s }: { s: Score }) {
  const lam = s.threshold.act.lambda, hed = s.threshold.hedge.lambda;
  // zoom into the part of the scale where decisions happen
  const lo = Math.max(0, Math.min(s.calibrated, lam ?? 1, hed ?? 1) - 0.05);
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / (1 - lo)) * 100))}%`;
  return (
    <div className="relative mt-2 h-7">
      <div className="absolute inset-x-0 top-3 h-1.5 rounded-full bg-panel-2" />
      {hed !== null && <div className="absolute top-3 h-1.5 rounded-l-full bg-hedge/40" style={{ left: pos(hed), right: lam !== null ? `calc(100% - ${pos(lam)})` : 0 }} />}
      {lam !== null && <div className="absolute top-3 h-1.5 rounded-r-full bg-act/45" style={{ left: pos(lam), right: 0 }} />}
      <div className="absolute top-1 h-5 w-0.5 rounded bg-fg" style={{ left: pos(s.calibrated) }} title={`calibrated ${s.calibrated}`} />
      <div className="absolute -bottom-0.5 text-[10px] text-faint" style={{ left: 0 }}>{lo.toFixed(2)}</div>
      <div className="absolute -bottom-0.5 right-0 text-[10px] text-faint">1.00</div>
    </div>
  );
}

function DecisionTab({ c }: { c: CaseDetail }) {
  if (!c.scores?.length) return <Empty title="No scored actions">This case was refused before any action was proposed.</Empty>;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {c.scores.map((s, i) => {
        const d = c.decisions[i];
        return (
          <Card key={i} title={<span className="flex items-center gap-2">{ACTION_LABEL[s.action] ?? s.action} {d && <RouteBadge route={d.route} />}{d?.committed && <Badge tone="good">committed</Badge>}{d?.undone && <Badge tone="warn">undone</Badge>}</span>}>
            <div className="flex items-baseline gap-4">
              <div><div className="caps text-faint">Calibrated</div><div className="serif text-[28px] leading-tight">{s.calibrated.toFixed(4)}</div></div>
              <div><div className="caps text-faint">Model stated</div><div className="serif text-[28px] leading-tight text-muted line-through decoration-escalate/60">{s.stated.toFixed(2)}</div></div>
              <div className="ml-auto text-right text-[11.5px] text-muted">α {pct(s.threshold.alpha, 2)} · {s.threshold.band} band<br />act λ {s.threshold.act.lambda?.toFixed(4) ?? "∞"} · hedge λ {s.threshold.hedge.lambda?.toFixed(4) ?? "∞"}</div>
            </div>
            <ScoreBar s={s} />
            <p className="mt-2 text-[12px] text-muted">{d?.why ?? s.why}</p>
            <details className="mt-2">
              <summary className="cursor-pointer text-[11.5px] text-faint">Features the score is built on</summary>
              <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px]">
                {Object.entries(s.features).map(([k, v]) => <div key={k} className="flex justify-between"><span className="text-muted">{k}</span><span className="tabular">{v}</span></div>)}
              </div>
            </details>
          </Card>
        );
      })}
    </div>
  );
}

function CaseAction({ kind, caseId, defaultTo, onDone }: { kind: "forward" | "call"; caseId: string; defaultTo: string; onDone: () => void }) {
  const [to, setTo] = useState(defaultTo);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form className="flex flex-wrap items-center gap-2 border-b border-line bg-panel-2 px-4 py-2 text-[12.5px]" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        if (kind === "forward") { const r = await capi.forward(caseId, to.trim(), note.trim()); toast(`Forwarded ${caseId} to ${r.to}`, "good"); }
        else { await capi.call(caseId, to.trim(), note.trim()); toast(`Calling ${to || "the customer"}…`, "good"); }
        onDone();
      } catch (x) { toast((x as Error).message, "bad"); } finally { setBusy(false); }
    }}>
      <span className="font-medium">{kind === "forward" ? "Forward by email to" : "Call"}</span>
      <input aria-label={kind === "forward" ? "Forward to" : "Phone number"} value={to} onChange={(e) => setTo(e.target.value)}
        placeholder={kind === "forward" ? "the escalation address, or anyone@example.com" : "the customer's number, e.g. +91 98765 43210"}
        className="h-8 min-w-60 flex-1 rounded-md border border-line-strong bg-panel px-2.5" />
      <input aria-label={kind === "forward" ? "Note" : "What to say"} value={note} onChange={(e) => setNote(e.target.value)}
        placeholder={kind === "forward" ? "a note (optional)" : "what the agent says first (optional: the case's last reply)"}
        className="h-8 min-w-48 flex-1 rounded-md border border-line-strong bg-panel px-2.5" />
      <Button type="submit" variant="primary" disabled={busy}>{kind === "forward" ? "Forward" : "Call now"}</Button>
      <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
    </form>
  );
}

function CaseView({ id }: { id: string }) {
  const version = useUI((s) => s.events.filter((e) => e.case_id === id || e.case?.id === id).length);
  const [c, setC] = useState<CaseDetail | null>(null);
  const [tab, setTab] = useState<"overview" | "evidence" | "decision" | "seal" | "trail">("overview");
  const [approval, setApproval] = useState<any>(null);
  const [chan, setChan] = useState<Conv | null>(null);
  const [act, setAct] = useState<null | "forward" | "call">(null);
  const channels = useUI((s) => s.app?.channels);
  const chanVersion = useUI((s) => s.events.filter((e) => e.kind === "channel.message" && e.message?.case_id === id).length);

  useEffect(() => {
    let live = true;
    api.caseDetail(id).then((d) => live && setC(d)).catch((e) => toast(e.message, "bad"));
    return () => { live = false; };
  }, [id, version]);
  useEffect(() => {
    let live = true;
    capi.caseChannel(id).then((d) => live && setChan(d)).catch(() => live && setChan(null));
    return () => { live = false; };
  }, [id, version, chanVersion]);
  useEffect(() => {
    if (c?.pending) api.approvals().then((a) => setApproval(a.find((x) => x.case.id === id) ?? null));
    else setApproval(null);
  }, [c?.pending, id, version]);

  if (!c) return <Empty title="Loading…" />;
  const hedged = c.decisions.some((d) => d.route === "HEDGE" && d.committed && !d.undone);
  const autonomous = c.decisions.some((d) => (d.route === "ACT" || d.route === "HEDGE") && d.committed);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-3">
        <StatusDot status={c.pending ? "parked" : c.status} />
        <h2 className="font-mono text-[14px] font-semibold">{c.id}</h2>
        <RouteBadge route={c.route} />
        <span className="text-[12.5px] text-muted">{c.customer_name} · {c.customer_id} · {c.channel}</span>
        {c.intent && <Badge>{INTENT_LABEL[c.intent] ?? c.intent}</Badge>}
        {c.txn && <span className="text-[12.5px] tabular">{inr(c.txn.amount)} · <Mono>{c.txn.id}</Mono> · {c.txn.merchant}</span>}
        {c.first_reply_s != null && <Badge tone="accent">first reply {c.first_reply_s}s</Badge>}
        <div className="ml-auto flex flex-wrap gap-1.5">
          {hedged && <Button size="sm" onClick={() => api.undo(c.id).then(() => toast("Undone", "info"))}><RotateCcw size={13} /> Undo</Button>}
          {autonomous && !c.pending && <>
            <Button size="sm" variant="ghost" title="Audit: this autonomous decision was right" onClick={() => api.audit(c.id, true).then(() => toast("Labelled correct", "good"))}><ThumbsUp size={13} /></Button>
            <Button size="sm" variant="ghost" title="Audit: this autonomous decision was wrong" onClick={() => api.audit(c.id, false).then(() => toast("Labelled wrong; the drift monitor counts it", "warn"))}><ThumbsDown size={13} /></Button>
          </>}
          {channels?.email?.enabled && <Button size="sm" variant={act === "forward" ? "primary" : "ghost"} onClick={() => setAct(act === "forward" ? null : "forward")}><Forward size={13} /> Forward</Button>}
          {channels?.voice?.enabled && <Button size="sm" variant={act === "call" ? "primary" : "ghost"} onClick={() => setAct(act === "call" ? null : "call")}><Phone size={13} /> Call</Button>}
          <a {...apiLink(api.previewUrl(c.id))} target="_blank" rel="noreferrer"><Button size="sm" variant="ghost"><ExternalLink size={13} /> Packet</Button></a>
          <a {...apiLink(api.exportUrl(c.id), `${c.id}.xlsx`)}><Button size="sm"><FileSpreadsheet size={13} /> Export .xlsx</Button></a>
        </div>
      </div>
      {act && <CaseAction kind={act} caseId={c.id} defaultTo={act === "call" ? (chan && ["whatsapp", "voice"].includes(chan.channel) ? chan.address : "") : ""} onDone={() => setAct(null)} />}
      {c.seal_broken && (
        <div className="flex items-center gap-2 border-b border-hedge/30 bg-hedge/10 px-4 py-2 text-[12.5px]">
          <ShieldAlert size={14} className="text-hedge" /> Seal broken: {c.seal_broken.why}. Old seal <Mono>{short(c.seal_broken.old_seal, 12)}</Mono>. The case was re-checked against the live ledger.
        </div>
      )}
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: "overview", label: "Timeline" }, { id: "evidence", label: "Evidence" }, { id: "decision", label: "Decision" },
        { id: "seal", label: c.pending ? "Seal · needs approval" : "Shadow & Seal" }, { id: "trail", label: "Trail & checkpoints" },
      ]} />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "overview" && (
          <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
            <Card title="Supersteps" pad={false}>
              <ol className="divide-y divide-line">
                {c.supersteps.map((s, i) => (
                  <li key={i} className="flex gap-3 px-3.5 py-2.5">
                    <span className="mt-0.5 w-5 shrink-0 text-right font-mono text-[11px] text-faint">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[12.5px] font-medium capitalize">{s.name}</span>
                        <span className="text-[11.5px] text-faint">{s.agents.join(", ")}</span>
                        {s.ended && <span className="ml-auto font-mono text-[11px] text-faint">{((s.ended - s.started) * 1000).toFixed(0)} ms</span>}
                      </div>
                      {s.note && <div className="mt-0.5 text-[12px] text-muted">{s.note}</div>}
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
            <Card title={<span>Conversation {c.pii?.length ? <Badge tone="gold">{c.pii.length} identifier(s) tokenised</Badge> : null}</span>}>
              <div className="space-y-2.5">
                {c.conversation.map((m, i) => (
                  <div key={i} className={cx("max-w-[90%] rounded-lg px-3 py-2 text-[12.5px] leading-relaxed", m.role === "customer" ? "bg-panel-2" : "ml-auto bg-accent/14")}>
                    <div className="mb-0.5 caps text-faint">{m.role === "customer" ? c.customer_name : "Nirnaya"} · {clock(m.ts)}</div>
                    {m.text}
                  </div>
                ))}
                {c.guard && <div className="text-[11.5px] text-muted">Promise Guard: {c.guard.ok ? "passed" : "blocked"} · {c.guard.claims_checked} claim(s) checked against the evidence</div>}
              </div>
            </Card>
            {chan && (
              <Card title={<span className="flex items-center gap-2">On {CHANNEL_LABEL[chan.channel] ?? chan.channel} <Mono className="text-faint">{chan.address}</Mono></span>}
                actions={<Button size="sm" variant="ghost" onClick={() => setState({ view: "channels" })}>Open in Channels</Button>} className="xl:col-span-2">
                <ul className="space-y-1 text-[12px]" data-testid="case-channel">
                  {chan.messages.filter((m) => !m.case_id || m.case_id === c.id).slice(-12).map((m, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="w-16 shrink-0 font-mono text-[11px] text-faint">{clock(m.ts)}</span>
                      <span className={cx("w-6 shrink-0", m.dir === "in" ? "text-accent" : "text-act")}>{m.dir === "in" ? "←" : "→"}</span>
                      <span className="min-w-0 flex-1 truncate" title={m.text}>{m.text}</span>
                      {m.status && <Badge tone={m.status === "failed" ? "bad" : m.status === "read" || m.status === "delivered" ? "good" : "muted"}>{m.status}</Badge>}
                    </li>
                  ))}
                </ul>
                {chan.messages.some((m) => m.status === "failed") && <p className="mt-2 text-[11.5px] text-escalate">{chan.messages.filter((m) => m.status === "failed").at(-1)?.error}</p>}
              </Card>
            )}
          </div>
        )}
        {tab === "evidence" && (
          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Sentry and understanding">
              <KV rows={[
                ["Sentry", c.sentry ? <span><RouteBadge route={c.sentry.verdict === "block" ? "REFUSE" : c.sentry.verdict === "adjudicate" ? "ESCALATE" : "ACT"} /> risk {c.sentry.risk} · {c.sentry.latency_ms} ms</span> : "—"],
                ["Rules hit", c.sentry?.reasons.length ? c.sentry.reasons.map((r) => r.detail).join("; ") : "none"],
                ["Intent", c.understanding ? `${INTENT_LABEL[c.understanding.intent] ?? c.understanding.intent} · ${c.understanding.confidence} (${c.understanding.source})` : "—"],
                ["Details", c.understanding ? <Mono>{JSON.stringify(c.understanding.entities)}</Mono> : "—"],
                ["Matched", c.match?.txn_id ? `${c.match.txn_id} · ${c.match.why.join(", ")} · ${c.match.confidence}` : "no transaction"],
              ]} />
            </Card>
            <Card title="Facts (every claim in the reply comes from here)">
              <ul className="space-y-1 text-[12.5px]">{(c.plan?.facts ?? []).map((f, i) => <li key={i}>· {f}</li>)}</ul>
            </Card>
            <Card title="Live systems (read-only)">
              <div className="space-y-2 text-[12px]">
                {(["upi", "debit", "refund", "profile"] as const).map((k) => c.evidence?.[k] ? (
                  <div key={k}><div className="caps text-faint">{k}</div><Mono className="break-all text-muted">{JSON.stringify(c.evidence[k])}</Mono></div>
                ) : null)}
                {c.evidence?.errors?.map((e, i) => <div key={i} className="text-escalate">{e}</div>)}
              </div>
            </Card>
            <Card title="Similar past cases (what held)">
              {c.evidence?.memory?.length ? (
                <ul className="space-y-1.5 text-[12px]">
                  {c.evidence.memory.map((m) => (
                    <li key={m.case_id} className="flex items-center gap-2">
                      <Mono className="text-muted">{m.case_id}</Mono>
                      <Badge tone={m.state === "rejected" ? "bad" : m.state === "accepted" ? "good" : "accent"}>{m.state}</Badge>
                      <span className="truncate text-muted">{ACTION_LABEL[m.action] ?? m.action}</span>
                      {m.ground_moved && <Badge tone="warn">ground moved</Badge>}
                      <span className="ml-auto tabular text-faint">{m.score}</span>
                    </li>
                  ))}
                </ul>
              ) : <div className="text-[12px] text-faint">No similar cases.</div>}
            </Card>
          </div>
        )}
        {tab === "decision" && <DecisionTab c={c} />}
        {tab === "seal" && (
          <div className="grid gap-4 xl:grid-cols-2">
            {approval ? <Card title="Waiting for your decision" className="xl:col-span-2"><ApprovalCard item={approval} /></Card> : null}
            <Card title="Shadow ledger diff"><DiffTable diff={c.shadow?.diff ?? []} /></Card>
            <Card title="Recheck against live">
              {c.recheck ? (
                <div className="space-y-1 text-[12px]">
                  <div>Baseline <Mono>{c.recheck.baseline}</Mono></div>
                  {c.recheck.tries.map((t) => <div key={t.try}>Try {t.try}: live <Mono>{t.live}</Mono> {t.ok ? <Badge tone="good">match</Badge> : <Badge tone="bad">moved</Badge>}</div>)}
                </div>
              ) : "—"}
            </Card>
          </div>
        )}
        {tab === "trail" && (
          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Audit trail for this case" pad={false}>
              <ul className="divide-y divide-line">
                {(c.trail ?? []).map((t) => (
                  <li key={t.seq} className="px-3.5 py-2 text-[12px]">
                    <div className="flex items-center gap-2"><Mono className="text-faint">#{t.seq}</Mono><span className="font-medium">{t.kind}</span><span className="text-muted">{t.actor}</span><span className="ml-auto text-faint">{clock(t.ts)}</span></div>
                    <div className="mt-0.5 text-faint"><Mono>{short(t.prev_hash, 8)} → {short(t.hash, 12)}</Mono></div>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Checkpoint chain (Continuum)" pad={false}>
              <ul className="divide-y divide-line">
                {(c.checkpoints ?? []).map((cp) => (
                  <li key={cp.id} className="px-3.5 py-2 text-[12px]">
                    <div className="flex items-center gap-2"><Mono>{cp.id}</Mono><span className="capitalize">{cp.superstep}</span><Badge tone={cp.status === "parked" ? "bad" : cp.status === "done" ? "good" : "muted"}>{cp.status}</Badge><span className="ml-auto text-faint">{ago(cp.created_at)}</span></div>
                    <div className="mt-0.5 text-faint">prev <Mono>{cp.prev_id ?? "—"}</Mono> · graph <Mono>{cp.graph_hash}</Mono> · policy <Mono>{cp.policy_hash}</Mono></div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkspaceView() {
  const open = useUI((s) => s.openCases);
  const active = useUI((s) => s.activeCase);
  const cases = useUI((s) => s.app?.cases ?? EMPTY);
  const byId = useMemo(() => Object.fromEntries(cases.map((c) => [c.id, c])), [cases]);
  const onPhone = useUI((s) => s.caseOnPhone && !!s.activeCase);
  useEffect(() => {
    if (!active && cases.length) openCase(cases[0].id, false);
  }, [active, cases]);
  return (
    <div className="flex h-full min-h-0">
      <CaseList className={onPhone ? "hidden" : "flex"} />
      <div className={cx("min-w-0 flex-1 flex-col md:flex", onPhone ? "flex" : "hidden")}>
        <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-line bg-panel px-1">
          <button className="mb-1 mr-1 flex shrink-0 cursor-pointer items-center rounded px-1.5 py-1 text-[12px] text-accent hover:bg-panel-2 md:hidden"
            onClick={() => setState({ caseOnPhone: false })} aria-label="Back to the cases">◂ Cases</button>
          {open.map((id) => (
            <div key={id} className={cx("group flex h-8 items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-[12px]", active === id ? "border-line bg-bg" : "border-transparent text-muted hover:text-fg")}>
              <button className="flex cursor-pointer items-center gap-1.5" onClick={() => setState({ activeCase: id })}>
                <StatusDot status={byId[id]?.pending ? "parked" : byId[id]?.status ?? "idle"} />
                <span className="font-mono">{id}</span>
              </button>
              <button aria-label={`Close ${id}`} className="cursor-pointer rounded p-0.5 opacity-60 hover:bg-panel-2 hover:opacity-100" onClick={() => closeCase(id)}><X size={12} /></button>
            </div>
          ))}
        </div>
        <div className="min-h-0 flex-1">{active ? <CaseView key={active} id={active} /> : <Empty icon={<Inbox size={28} />} title="Pick a case">Cases open here as tabs.</Empty>}</div>
      </div>
    </div>
  );
}

function OpItem({ op, onDone }: { op: Op; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const agents = useUI((s) => s.app?.agents ?? EMPTY);
  const who = agents.find((a) => a.id === op.agent)?.name ?? op.agent;
  const go = async (yes: boolean) => {
    setBusy(true);
    try {
      if (yes) await oapi.approveOp(op.id); else await oapi.rejectOp(op.id, note);
      toast(yes ? `${op.id} approved: ${who} is running it` : `${op.id} won't run`, yes ? "good" : "info");
      onDone();
    } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  return (
    <Card title={<span className="flex items-center gap-2"><ClipboardList size={14} className="text-accent" /><Mono>{op.id}</Mono> {op.title}</span>}
      actions={<span className="text-[11.5px] text-muted">{who}{op.by && !["you", "routine"].includes(op.by) ? ` · asked by ${op.by}` : op.routine ? " · routine" : ""}</span>}>
      <p className="text-[12.5px]">{op.ask ?? `“${op.title}” is ready. Run it?`}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="good" disabled={busy} onClick={() => go(true)}><Check size={14} /> Approve</Button>
        <input aria-label={`Note for ${op.id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why not? (optional)"
          className="h-8 min-w-40 flex-1 rounded-md border border-line-strong bg-panel-2 px-2.5 text-[12.5px]" />
        <Button variant="danger" disabled={busy} onClick={() => go(false)}><X size={14} /> Reject</Button>
      </div>
    </Card>
  );
}

function FlowItem({ w, onDone }: { w: OfficeSnap["flow_waits"][number]; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (yes: boolean) => {
    setBusy(true);
    try { await oapi.decideFlow(w.run_id, w.node, yes, note); toast(`“${w.flow}” carries on: ${yes ? "yes" : "no"}`, "good"); onDone(); }
    catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  return (
    <Card title={<span className="flex items-center gap-2"><Workflow size={14} className="text-accent" />{w.flow} <Mono className="text-faint">{w.run_id}</Mono></span>}
      actions={<Button size="sm" variant="ghost" onClick={() => showFlow(w.flow_id)}>Open flow</Button>}>
      <p className="text-[12.5px]">{w.question}</p>
      <p className="mt-1 text-[11.5px] text-faint">Started by {w.by} · waiting {ago(w.since)}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="good" disabled={busy} onClick={() => go(true)}><Check size={14} /> Yes</Button>
        <input aria-label={`Note for ${w.run_id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note (optional)"
          className="h-8 min-w-40 flex-1 rounded-md border border-line-strong bg-panel-2 px-2.5 text-[12.5px]" />
        <Button variant="danger" disabled={busy} onClick={() => go(false)}><X size={14} /> No</Button>
      </div>
    </Card>
  );
}

export function ApprovalsView() {
  const [items, setItems] = useState<any[] | null>(null);
  const [snap, setSnap] = useState<OfficeSnap | null>(null);
  const version = useUI((s) => s.app?.stats.pending_approvals);
  const evs = useUI((s) => s.events.filter((e) => e.kind === "op.updated" || e.kind === "flow.run" || e.kind.startsWith("approval")).length);
  const load = () => Promise.all([api.approvals().then(setItems), oapi.snap().then(setSnap)]).catch((e) => toast(e.message, "bad"));
  useEffect(() => { void load(); }, [version, evs]);
  if (!items) return <Empty title="Loading…" />;
  const ops = (snap?.ops ?? []).filter((o) => o.state === "waiting");
  const flows = snap?.flow_waits ?? [];
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-4xl space-y-4">
        <div>
          <h2 className="page-title">Approvals</h2>
          <p className="text-[12.5px] text-muted">Each item is sealed to the exact ledger state it was prepared on. If anything moves before you approve, the seal no longer matches and the case is re-checked; your approval never lands on a different state.</p>
        </div>
        {!items.length && !ops.length && !flows.length && <Card><Empty icon={<CheckCheck size={24} />} title="Nothing is waiting">Cases Nirnaya is not certified to finish alone appear here with their evidence, with department tasks and flows that need a person's OK.</Empty></Card>}
        {items.map((it) => (
          <Card key={it.case.id} title={<span className="flex items-center gap-2"><Mono>{it.case.id}</Mono> {it.case.customer_name} · {INTENT_LABEL[it.case.intent] ?? it.case.intent} {it.case.amount ? `· ${inr(it.case.amount)}` : ""}</span>}
            actions={<Button size="sm" variant="ghost" onClick={() => openCase(it.case.id)}>Open case</Button>}>
            <ApprovalCard item={it} onDone={load} />
          </Card>
        ))}
        {ops.length > 0 && <h3 className="caps pt-2 text-faint">Department tasks waiting for an OK</h3>}
        {ops.map((op) => <OpItem key={op.id} op={op} onDone={load} />)}
        {flows.length > 0 && <h3 className="caps pt-2 text-faint">Flows asking a person</h3>}
        {flows.map((w) => <FlowItem key={w.run_id + w.node} w={w} onDone={load} />)}
      </div>
    </div>
  );
}
