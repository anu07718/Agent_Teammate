// The dashboard: how many cases the agents accepted, rejected or left waiting for a person, the tokens the
// language model used and what they would cost, and, for any case or task you click, every agent that worked on it.
// Numbers come from /api/dashboard (outcomes per day, tokens per day and per job) and /api/dashboard/item/{id}.
import { Bot, ChevronRight, Coins, ExternalLink, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiReq } from "../api";
import { BarList, ColumnChart, type ColSeries } from "../components/charts";
import { Badge, Button, Card, Empty, Stat, cx } from "../components/ui";
import { ago, pct } from "../lib/format";
import { onEvents, openCase, toast } from "../store";

type Outcome = "accepted" | "rejected" | "waiting" | "running";
interface Day { day: string; accepted: number; rejected: number; waiting: number; running: number }
interface UsageDay { day: string; calls: number; in: number; out: number; total: number; cost: number }
interface Item { id: string; type: "case" | "task"; title: string; who: string | null; outcome: Outcome; how: string; created_at: number; agents: number; people: number; tokens: number; cost: number }
interface Dash {
  days: Day[];
  cases: Record<Outcome | "total", number> & { how: Record<string, number>; acceptance: number | null };
  tasks: Record<Outcome | "total", number>;
  usage: { model: { name: string; runtime: string; price_in: number; price_out: number }; calls: number; in: number; out: number; total: number; cost: number;
    estimated_calls: number; days: UsageDay[]; jobs: { job: string; label: string; calls: number; total: number; cost: number }[] };
  per_case: { tokens: number; cost: number };
  items: Item[];
  price_note: string;
}
interface Agent { id: string; name: string; emoji: string; department: string | null }
interface Detail {
  id: string; type: "case" | "task"; title: string; who: string | null; outcome: Outcome; how: string; agents: Agent[];
  steps: { step: string; agents: Agent[]; started: number | null; ended: number | null; note: string }[];
  people: { name: string; did: string }[];
  tokens: { calls: number; in: number; out: number; total: number; cost: number; jobs: { job: string; label: string; tokens: number }[] };
}

const OUT: Record<Outcome, { label: string; color: string }> = {
  accepted: { label: "Accepted", color: "var(--out-ok)" },
  waiting: { label: "Waiting for a person", color: "var(--out-wait)" },
  rejected: { label: "Rejected", color: "var(--out-no)" },
  running: { label: "Running", color: "var(--out-run)" },
};
const RANGES = [7, 14, 30] as const;
const num = (v: number) => v.toLocaleString("en-IN");
const compact = (v: number) => v >= 1e7 ? `${(v / 1e7).toFixed(1)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(1)}L` : v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}K` : String(v);
/** small amounts keep their paise: ₹0.0042 reads as ₹0.004, not ₹0 */
export const rupees = (v: number) => v === 0 ? "₹0" : v < 0.01 ? `₹${v.toFixed(4)}` : v < 1 ? `₹${v.toFixed(3)}` : `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const dayLabel = (d: string) => new Date(d + "T00:00:00").toLocaleDateString([], { day: "numeric", month: "short" });

function OutcomeTag({ o }: { o: Outcome }) {
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px]"><span className="h-2 w-2 rounded-full" style={{ background: OUT[o].color }} />{OUT[o].label}</span>;
}

function ModelCard({ d, onSaved }: { d: Dash; onSaved: () => void }) {
  const m = d.usage.model;
  const [f, setF] = useState(m);
  const [open, setOpen] = useState(false);
  useEffect(() => setF(m), [m.name, m.runtime, m.price_in, m.price_out]);
  const save = async () => {
    try {
      await apiReq("/api/usage", { method: "PUT", body: JSON.stringify({ ...f, price_in: Number(f.price_in), price_out: Number(f.price_out) }) });
      toast("Model and prices saved", "good");
      setOpen(false);
      onSaved();
    } catch (e) { toast((e as Error).message, "bad"); }
  };
  const input = "h-8 w-full rounded-md border border-line-strong bg-panel-2 px-2.5 text-[12.5px] outline-none focus:border-accent";
  return (
    <Card title="Model" actions={<Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>{open ? "Close" : "Edit"}</Button>}>
      <div className="flex items-center gap-3" data-testid="dash-model">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-line bg-panel-2"><Bot size={18} /></span>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold">{m.name}</div>
          <div className="text-[12px] text-muted">{m.runtime} · {num(d.usage.calls)} call{d.usage.calls === 1 ? "" : "s"}</div>
        </div>
      </div>
      <p className="mt-3 text-[11.5px] text-muted">
        Cost is estimated at ₹{m.price_in} per million tokens in and ₹{m.price_out} out. {m.runtime === "Ollama" ? "Ollama on your own computer bills nothing; this is what the same tokens would cost from a hosted model." : ""}
        {d.usage.estimated_calls > 0 && ` ${num(d.usage.estimated_calls)} call(s) did not report a count, so theirs is estimated.`}
      </p>
      {open && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="text-[11.5px] text-muted">Model<input aria-label="Model name" className={input} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="text-[11.5px] text-muted">Runs on<input aria-label="Runs on" className={input} value={f.runtime} onChange={(e) => setF({ ...f, runtime: e.target.value })} /></label>
          <label className="text-[11.5px] text-muted">₹ per 1M tokens in<input aria-label="Price in" inputMode="decimal" className={input} value={f.price_in} onChange={(e) => setF({ ...f, price_in: e.target.value as any })} /></label>
          <label className="text-[11.5px] text-muted">₹ per 1M tokens out<input aria-label="Price out" inputMode="decimal" className={input} value={f.price_out} onChange={(e) => setF({ ...f, price_out: e.target.value as any })} /></label>
          <div className="col-span-2"><Button size="sm" onClick={() => void save()}>Save</Button></div>
        </div>
      )}
    </Card>
  );
}

function DetailPanel({ id, stamp, onClose }: { id: string; stamp: unknown; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const shown = useRef<string | null>(null);
  // a new case starts blank; the same case refreshes in place whenever the dashboard reloads (prices, new steps)
  useEffect(() => {
    if (shown.current !== id) { setD(null); setErr(null); shown.current = id; }
    let live = true;
    apiReq<Detail>(`/api/dashboard/item/${id}`).then((x) => { if (live) setD(x); }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [id, stamp]);
  if (err) return <Card title={id}><p className="text-[12.5px] text-muted">{err}</p></Card>;
  if (!d) return <Card title={id}><p className="text-[12.5px] text-muted">Loading…</p></Card>;
  return (
    <Card title={`${d.id} · ${d.type}`} actions={<>
      {d.type === "case" && <Button size="sm" variant="ghost" onClick={() => openCase(d.id)}><ExternalLink size={12} /> Open</Button>}
      <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close details">✕</Button>
    </>}>
      <div data-testid="dash-detail">
        <p className="text-[12.5px]">{d.title || "—"}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-muted"><OutcomeTag o={d.outcome} /> · {d.how}{d.who ? ` · ${d.who}` : ""}</div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg border border-line px-2 py-2"><div className="serif text-[24px] leading-none" data-testid="dash-agent-count">{d.agents.length}</div><div className="caps mt-1 text-faint">agents</div></div>
          <div className="rounded-lg border border-line px-2 py-2"><div className="serif text-[24px] leading-none">{num(d.tokens.total)}</div><div className="caps mt-1 text-faint">tokens</div></div>
          <div className="rounded-lg border border-line px-2 py-2"><div className="serif text-[24px] leading-none">{rupees(d.tokens.cost)}</div><div className="caps mt-1 text-faint">cost</div></div>
        </div>
        <div className="caps mb-1.5 mt-4 text-faint">Agents who worked on it</div>
        <div className="flex flex-wrap gap-1.5" data-testid="dash-agents">
          {d.agents.map((a) => <span key={a.id} className="inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[12px]"><span aria-hidden>{a.emoji}</span><span>{a.name}</span></span>)}
        </div>
        <div className="caps mb-1.5 mt-4 text-faint">Step by step</div>
        <ol className="space-y-1 text-[12px]">
          {d.steps.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-5 shrink-0 text-right text-faint tabular">{i + 1}</span>
              <span className="min-w-0"><b className="font-medium">{s.agents.map((a) => a.name).join(", ")}</b> <span className="text-muted">· {s.step}{s.note ? ` · ${s.note}` : ""}</span></span>
            </li>
          ))}
        </ol>
        {d.people.length > 0 && <>
          <div className="caps mb-1.5 mt-4 flex items-center gap-1 text-faint"><Users size={11} /> People</div>
          <ul className="text-[12px]">{d.people.map((p, i) => <li key={i}><b className="font-medium">{p.name}</b> <span className="text-muted">{p.did}</span></li>)}</ul>
        </>}
        <div className="caps mb-1.5 mt-4 text-faint">Tokens by job</div>
        {d.tokens.jobs.length
          ? <BarList ariaLabel="Tokens by job for this case" color="var(--fg)" rows={d.tokens.jobs.map((j) => ({ label: j.label, value: j.tokens }))} />
          : <p className="text-[12px] text-muted">No model calls: the rules handled it on their own (0 tokens).</p>}
        {d.tokens.total > 0 && <p className="mt-2 text-[11.5px] text-muted">{num(d.tokens.in)} in · {num(d.tokens.out)} out · {d.tokens.calls} call{d.tokens.calls === 1 ? "" : "s"}</p>}
      </div>
    </Card>
  );
}

export function DashboardView() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(14);
  const [d, setD] = useState<Dash | null>(null);
  const [loading, setLoading] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Outcome>("all");
  const [tables, setTables] = useState({ cases: false, tokens: false });
  const seq = useRef(0);
  const load = () => {
    const n = ++seq.current;
    setLoading(true);
    return apiReq<Dash>(`/api/dashboard?days=${days}`).then((x) => { if (n === seq.current) setD(x); })
      .catch((e) => toast(e.message, "bad")).finally(() => { if (n === seq.current) setLoading(false); });
  };
  useEffect(() => { void load(); }, [days]);
  // live: a case or task that moves changes the numbers (at most once a second)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = onEvents((ev) => {
      if (!/^(case\.(created|finished)|op\.updated|approval\.(granted|rejected)|op\.removed)$/.test(ev.kind)) return;
      if (!t) t = setTimeout(() => { t = null; void load(); }, 1000);
    });
    return () => { off(); if (t) clearTimeout(t); };
  }, [days]);

  const caseSeries: ColSeries[] = useMemo(() => {
    const s: ColSeries[] = [{ key: "accepted", label: OUT.accepted.label, color: OUT.accepted.color },
      { key: "waiting", label: OUT.waiting.label, color: OUT.waiting.color }, { key: "rejected", label: OUT.rejected.label, color: OUT.rejected.color }];
    if (d?.days.some((x) => x.running)) s.push({ key: "running", label: OUT.running.label, color: OUT.running.color });
    return s;
  }, [d]);

  if (!d) return <div className="h-full"><Empty title="Loading…" /></div>;
  const c = d.cases, u = d.usage;
  const items = d.items.filter((i) => filter === "all" || i.outcome === filter);
  const byPerson = c.how["approved by a person"] ?? 0, byAgents = c.how["resolved by the agents"] ?? 0;
  const refusedByAgents = c.how["refused by the agents"] ?? 0, rejectedByPerson = c.how["rejected by a person"] ?? 0;
  const tokenDays = u.days.slice(-days);

  return (
    <div className="h-full overflow-y-auto">
    <div className={cx("mx-auto max-w-[1400px] space-y-4 p-4 transition-opacity", loading && "opacity-90")} data-testid="dashboard">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="text-[12.5px] text-muted">What the agents accepted, rejected or left for a person, and the tokens they used on <b className="font-medium text-fg">{u.model.name}</b> · {u.model.runtime}.</p>
        </div>
        <div className="inline-flex overflow-hidden rounded-md border border-line-strong" role="radiogroup" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r} role="radio" aria-checked={days === r} onClick={() => setDays(r)}
              className={cx("h-8 cursor-pointer px-3 text-[12px]", days === r ? "bg-fg/8 font-semibold text-fg" : "text-muted hover:text-fg")}>Last {r} days</button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="dash-kpis">
        <Stat label="Cases" value={num(c.total)} sub={c.acceptance === null ? "none settled yet" : `${pct(c.acceptance)} accepted`} />
        <Stat label="Accepted" value={num(c.accepted)} sub={`${byAgents} by the agents · ${byPerson} approved by a person`} />
        <Stat label="Rejected" value={num(c.rejected)} sub={`${refusedByAgents} refused by the agents · ${rejectedByPerson} by a person`} />
        <Stat label="Waiting for a person" value={num(c.waiting)} tone={c.waiting ? "warn" : undefined} sub={c.waiting ? "sealed, needs your OK" : "nothing waiting"} />
        <Stat label="Tokens used" value={compact(u.total)} sub={`${num(u.in)} in · ${num(u.out)} out · ≈${num(d.per_case.tokens)} a case`} />
        <Stat label="Estimated cost" value={rupees(u.cost)} sub={`≈${rupees(d.per_case.cost)} a case · ${u.model.runtime}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card className="min-w-0" title="Cases per day" actions={<Button size="sm" variant="ghost" onClick={() => setTables({ ...tables, cases: !tables.cases })}>{tables.cases ? "Chart" : "Table"}</Button>}>
          {tables.cases ? (
            <table className="w-full text-[12px]"><thead><tr className="text-left text-faint"><th className="py-1 font-normal">Day</th>{caseSeries.map((s) => <th key={s.key} className="py-1 text-right font-normal">{s.label}</th>)}</tr></thead>
              <tbody>{d.days.map((x) => <tr key={x.day} className="border-t border-line"><td className="py-1">{dayLabel(x.day)}</td>{caseSeries.map((s) => <td key={s.key} className="py-1 text-right tabular">{(x as any)[s.key]}</td>)}</tr>)}</tbody></table>
          ) : (
            <ColumnChart testId="chart-cases" ariaLabel="Cases and tasks per day by outcome" rows={d.days as any} xKey="day" xFmt={dayLabel} series={caseSeries}
              extra={(r) => `${caseSeries.reduce((a, s) => a + (r[s.key] || 0), 0)} in all`} />
          )}
          <p className="mt-2 text-[11.5px] text-muted">Customer cases and office tasks (pay, ask, message, call…) together. Office tasks so far: {d.tasks.accepted} done, {d.tasks.waiting} waiting, {d.tasks.rejected} rejected or failed.</p>
        </Card>
        <Card className="min-w-0" title="Tokens per day" actions={<Button size="sm" variant="ghost" onClick={() => setTables({ ...tables, tokens: !tables.tokens })}>{tables.tokens ? "Chart" : "Table"}</Button>}>
          {u.total === 0 ? (
            <Empty icon={<Coins size={20} />} title="No tokens yet">The rules alone use none. Tokens appear here as soon as the model reads a message, words a reply or answers in a chat.</Empty>
          ) : tables.tokens ? (
            <table className="w-full text-[12px]"><thead><tr className="text-left text-faint"><th className="py-1 font-normal">Day</th><th className="py-1 text-right font-normal">Calls</th><th className="py-1 text-right font-normal">In</th><th className="py-1 text-right font-normal">Out</th><th className="py-1 text-right font-normal">Cost</th></tr></thead>
              <tbody>{tokenDays.map((x) => <tr key={x.day} className="border-t border-line"><td className="py-1">{dayLabel(x.day)}</td><td className="py-1 text-right tabular">{x.calls}</td><td className="py-1 text-right tabular">{num(x.in)}</td><td className="py-1 text-right tabular">{num(x.out)}</td><td className="py-1 text-right tabular">{rupees(x.cost)}</td></tr>)}</tbody></table>
          ) : (
            <ColumnChart testId="chart-tokens" ariaLabel="Tokens per day" rows={tokenDays as any} xKey="day" xFmt={dayLabel} yFmt={compact}
              series={[{ key: "in", label: "In (the prompt)", color: "var(--fg)" }, { key: "out", label: "Out (the answer)", color: "var(--faint)" }]}
              extra={(r) => `${num(r.calls)} calls · ${rupees(r.cost)}`} />
          )}
          <p className="mt-2 text-[11.5px] text-muted">{d.price_note}.</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr_340px]">
        <Card className="min-w-0" title="Tokens by job">
          {u.jobs.length ? <BarList ariaLabel="Tokens by job" color="var(--fg)" fmt={compact}
            rows={u.jobs.map((j) => ({ label: j.label, value: j.total, title: `${num(j.calls)} calls · ${rupees(j.cost)}` }))} sub={(i) => rupees(u.jobs[i].cost)} />
            : <p className="text-[12.5px] text-muted">Nothing yet.</p>}
        </Card>
        <Card className="min-w-0" title="How cases ended">
          <BarList ariaLabel="How cases ended" color="var(--fg)" rows={Object.entries(c.how).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k[0].toUpperCase() + k.slice(1), value: v }))} />
          {!Object.keys(c.how).length && <p className="text-[12.5px] text-muted">No cases yet.</p>}
        </Card>
        <ModelCard d={d} onSaved={() => void load()} />
      </div>

      <div className={cx("grid gap-4", pick && "lg:grid-cols-[1fr_380px]")}>
        <Card className="min-w-0" title="Cases and tasks" pad={false} actions={
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Show">
            {(["all", "accepted", "waiting", "rejected"] as const).map((f) => (
              <button key={f} role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}
                className={cx("caps h-7 cursor-pointer rounded-full border px-2.5", filter === f ? "border-fg text-fg" : "border-line text-muted hover:text-fg")}>
                {f === "all" ? `All ${d.items.length}` : `${OUT[f].label.split(" ")[0]} ${d.items.filter((i) => i.outcome === f).length}`}
              </button>
            ))}
          </div>}>
          {items.length ? (
            <div className="max-h-[520px] overflow-auto">
              <table className="w-full text-[12.5px]" data-testid="dash-items">
                <thead className="sticky top-0 bg-panel"><tr className="text-left text-faint">
                  <th className="px-4 py-2 font-normal">Case</th><th className="px-2 py-2 font-normal">What</th><th className="px-2 py-2 font-normal">Outcome</th>
                  <th className="px-2 py-2 text-right font-normal">Agents</th><th className="px-2 py-2 text-right font-normal">Tokens</th><th className="px-2 py-2 text-right font-normal">Cost</th><th className="px-4 py-2 text-right font-normal">When</th>
                </tr></thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} data-id={i.id} onClick={() => setPick(i.id === pick ? null : i.id)} tabIndex={0}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPick(i.id); } }}
                      className={cx("cursor-pointer border-t border-line hover:bg-panel-2", pick === i.id && "bg-panel-2")}>
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-[11.5px]">{i.id}<span className="ml-1.5 text-faint">{i.type}</span></td>
                      <td className="max-w-[360px] truncate px-2 py-2" title={i.title}>{i.title || "—"}</td>
                      <td className="px-2 py-2"><OutcomeTag o={i.outcome} /></td>
                      <td className="px-2 py-2 text-right tabular">{i.agents}</td>
                      <td className="px-2 py-2 text-right tabular">{num(i.tokens)}</td>
                      <td className="px-2 py-2 text-right tabular">{rupees(i.cost)}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right text-muted">{ago(i.created_at)} <ChevronRight size={12} className="inline text-faint" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty title="Nothing here">Type a customer message or a task to Intake in the office; it shows up here as it runs.</Empty>}
        </Card>
        {pick && <DetailPanel id={pick} stamp={d} onClose={() => setPick(null)} />}
      </div>
      <p className="text-[11px] text-faint">Click a case or task to see every agent that worked on it, the people who decided, and its tokens. <Badge>live</Badge></p>
    </div>
    </div>
  );
}
