// How the agents are working, right now: every customer case goes through the same ten steps, each step
// is a desk (or two), and each case lights up the steps it has passed. Department tasks and flow runs sit
// beside it. Everything refreshes from the live event stream.
import { ArrowRight, ExternalLink, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Empty, RouteBadge, cx } from "../components/ui";
import { INTENT_LABEL, ago, inr } from "../lib/format";
import { onEvents, openCase, useUI, EMPTY } from "../store";
import { fapi, type Pipeline } from "./api";

const STEP_LABEL: Record<string, string> = {
  intake: "Intake", understand: "Understand", evidence: "Evidence", plan: "Plan", calibrate: "Calibrate",
  shadow: "Shadow run", route: "Route", commit: "Commit", respond: "Reply", learn: "Learn",
};
const STEP_WHAT: Record<string, string> = {
  intake: "screen and tokenise", understand: "what is this about", evidence: "read the bank's systems", plan: "the specialist proposes",
  calibrate: "a score you can trust", shadow: "dry-run on a copy", route: "act, hedge or ask a person", commit: "sealed, exactly once",
  respond: "a reply, checked", learn: "trail and drift",
};

export function usePipeline() {
  const [p, setP] = useState<Pipeline | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => fapi.pipeline().then((d) => live && setP(d)).catch(() => {});
    void load();
    const off = onEvents((ev) => {
      if (!["superstep", "case.created", "case.finished", "op.updated", "flow.run", "approval.granted", "approval.rejected"].includes(ev.kind)) return;
      if (timer.current) return;
      timer.current = setTimeout(() => { timer.current = null; void load(); }, 300);
    });
    return () => { live = false; off(); if (timer.current) clearTimeout(timer.current); };
  }, []);
  return p;
}

export function Live({ onOpenFlow }: { onOpenFlow: (flowId: string) => void }) {
  const p = usePipeline();
  const agents = useUI((s) => s.app?.agents ?? EMPTY);
  const [pick, setPick] = useState<string | null>(null);
  const name = (id: string) => (id === "specialist" ? "the specialist" : agents.find((a) => a.id === id)?.name ?? id);
  const chosen = useMemo(() => p?.cases.find((c) => c.id === pick) ?? null, [p, pick]);
  if (!p) return <Empty title="Loading…" />;
  const flying = p.cases.filter((c) => c.status === "running");
  const lit = (step: string) => (chosen ? (chosen.passed.includes(step) ? "done" : chosen.status === "running" && chosen.step === step ? "now" : "todo") : null);

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-[1400px] space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">How the agents are working</h2>
            <p className="text-[12.5px] text-muted">Every customer case goes through the same ten steps; each step is a desk in the office. Pick a case to see how far it has come.</p>
          </div>
          <div className="flex flex-wrap gap-2 text-[12px]">
            <Badge tone={flying.length ? "accent" : "muted"}>{flying.length} case(s) in flight</Badge>
            <Badge tone={p.ops.doing ? "accent" : "muted"}>{p.ops.doing + p.ops.next} task(s) running</Badge>
            <Badge tone={p.ops.waiting ? "warn" : "muted"}>{p.ops.waiting} task(s) waiting for an OK</Badge>
            <Badge tone={p.runs.length ? "accent" : "muted"}>{p.runs.length} flow run(s) going</Badge>
          </div>
        </div>

        <Card title={<span className="flex items-center gap-2">The case pipeline {chosen && <><ArrowRight size={13} className="text-faint" /><span className="font-mono">{chosen.id}</span> <span className="text-muted">{Math.round(chosen.progress * 100)}% done</span></>}</span>}
          actions={chosen ? <Button size="sm" variant="ghost" onClick={() => setPick(null)}>Show all</Button> : null}>
          <div className="fl-pipe" data-testid="pipeline">
            {p.steps.map((s, i) => {
              const state = lit(s.name);
              const busy = s.here.length > 0;
              return (
                <div key={s.name} className="fl-pipe-cell">
                  <div className={cx("fl-step", busy && "busy", state && `lit-${state}`)} data-step={s.name}>
                    <div className="flex items-center justify-between">
                      <span className="text-[10.5px] font-medium uppercase tracking-wider text-faint">{i + 1}</span>
                      {busy && <span className="fl-here" title={s.here.join(", ")}>{s.here.length} here</span>}
                    </div>
                    <div className="mt-0.5 text-[13px] font-semibold">{STEP_LABEL[s.name] ?? s.name}</div>
                    <div className="text-[11px] text-muted">{STEP_WHAT[s.name]}</div>
                    <div className="mt-1.5 truncate text-[11.5px]" title={s.agents.map(name).join(", ")}>{s.agents.map(name).join(" · ")}</div>
                    <div className="mt-1 flex justify-between text-[10.5px] text-faint"><span>{s.done} done</span>{s.avg_ms != null && <span>{s.avg_ms < 1000 ? `${Math.round(s.avg_ms)} ms` : `${(s.avg_ms / 1000).toFixed(1)} s`}</span>}</div>
                  </div>
                  {i < p.steps.length - 1 && <div className={cx("fl-link", (busy || p.steps[i + 1].here.length > 0) && "flow")} aria-hidden />}
                </div>
              );
            })}
          </div>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
          <Card title="Cases, newest first" pad={false}>
            {p.cases.length ? (
              <ul className="divide-y divide-line">
                {p.cases.slice(0, 18).map((c) => (
                  <li key={c.id}>
                    <button className={cx("flex w-full cursor-pointer items-center gap-3 px-3.5 py-2 text-left", pick === c.id ? "bg-accent/10" : "hover:bg-panel-2")}
                      onClick={() => setPick(pick === c.id ? null : c.id)} data-case={c.id}>
                      <span className="w-16 shrink-0 font-mono text-[12px]">{c.id}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px]">{c.customer_name} · {c.intent ? INTENT_LABEL[c.intent] ?? c.intent : c.route === "REFUSE" ? "refused at intake" : "reading…"}{c.amount ? ` · ${inr(c.amount)}` : ""}{c.opened_by ? <span className="text-faint"> · {c.opened_by}</span> : null}</div>
                        <div className="fl-segs mt-1" aria-label={`${Math.round(c.progress * 100)}% done`}>
                          {p.steps.map((s) => <i key={s.name} className={c.passed.includes(s.name) ? "d" : c.status === "running" && c.step === s.name ? "n" : ""} title={STEP_LABEL[s.name]} />)}
                        </div>
                      </div>
                      <span className="w-10 shrink-0 text-right text-[11.5px] tabular text-muted">{Math.round(c.progress * 100)}%</span>
                      {c.pending ? <Badge tone="warn">waiting</Badge> : <RouteBadge route={c.route} />}
                    </button>
                  </li>
                ))}
              </ul>
            ) : <Empty title="No cases yet">Send a customer message from the office, or run a flow with a Customer message in it.</Empty>}
            {chosen && <div className="border-t border-line px-3.5 py-2"><Button size="sm" onClick={() => openCase(chosen.id)}><ExternalLink size={12} /> Open {chosen.id}</Button></div>}
          </Card>

          <div className="space-y-4">
            <Card title="Department tasks">
              <div className="grid grid-cols-5 gap-2 text-center">
                {([["scheduled", "booked"], ["next", "next"], ["doing", "doing"], ["waiting", "waiting"], ["done", "done"]] as const).map(([k, l]) => (
                  <div key={k} className="rounded-md bg-panel-2 px-1 py-2"><div className={cx("text-lg font-semibold tabular", k === "waiting" && p.ops[k] ? "text-hedge" : "")}>{p.ops[k] ?? 0}</div><div className="text-[10.5px] uppercase tracking-wider text-faint">{l}</div></div>
                ))}
              </div>
            </Card>
            <Card title={<span className="flex items-center gap-2"><Workflow size={14} /> Flow runs going now</span>} pad={false}>
              {p.runs.length ? (
                <ul className="divide-y divide-line">
                  {p.runs.map((r) => (
                    <li key={r.id}>
                      <button className="w-full cursor-pointer px-3.5 py-2.5 text-left hover:bg-panel-2" onClick={() => onOpenFlow(r.flow_id)}>
                        <div className="flex items-center gap-2 text-[12.5px]"><span className="font-medium">{r.name}</span><span className="font-mono text-faint">{r.id}</span>
                          <Badge tone={r.state === "waiting" ? "warn" : "accent"}>{r.state}</Badge><span className="ml-auto text-muted">{r.by} · {ago(r.started_at)}</span></div>
                        <div className="fl-bar mt-1.5"><i style={{ width: `${Math.max(4, r.progress * 100)}%` }} /></div>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <div className="px-3.5 py-3 text-[12px] text-faint">No flow is running. Open the Builder to draw one, or run an example.</div>}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
