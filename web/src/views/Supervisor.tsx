import { Activity, Play, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { LineChart } from "../components/charts";
import { Badge, Button, Card, Empty, Stat, cx } from "../components/ui";
import { ACTION_LABEL, ago, inr, pct } from "../lib/format";
import { toast, useUI } from "../store";

const RUNGS = ["Suggest", "Hedge", "Act"];

function ActionRow({ a, onChange }: { a: any; onChange: (patch: { alpha?: number; rung?: number }) => void }) {
  const [alpha, setAlpha] = useState((a.alpha * 100).toFixed(2));
  useEffect(() => setAlpha((a.alpha * 100).toFixed(2)), [a.alpha]);
  const cell = (band: string) => {
    const t = a.thresholds?.[band];
    if (!t) return <td className="px-2 text-faint">—</td>;
    if (!a.moves_money && band !== "small") return <td className="px-2 text-faint">same</td>;
    return (
      <td className="px-2 py-2 align-top text-[11.5px]">
        {t.act.lambda !== null ? <div><Badge tone="good">act ≥ {t.act.lambda.toFixed(3)}</Badge> <span className="text-muted">{pct(t.act.acted)} of cases</span></div>
          : <div><Badge tone="bad">never alone</Badge> <span className="text-faint">{(t.act.n ?? 0) < (t.act.n_needed ?? 0) ? `needs ${t.act.n_needed}+ labelled cases (has ${t.act.n})` : "error stays above α at every threshold"}</span></div>}
        {a.reversible && <div className="mt-1">{t.hedge.lambda !== null ? <Badge tone="warn">hedge ≥ {t.hedge.lambda.toFixed(3)}</Badge> : <span className="text-faint">no hedge</span>}</div>}
        <div className="mt-0.5 text-faint">α {pct(t.alpha, 2)}</div>
      </td>
    );
  };
  return (
    <tr className="border-t border-line">
      <td className="py-2 pl-3.5 pr-2 align-top">
        <div className="text-[12.5px] font-medium">{a.label}</div>
        <div className="text-[11px] text-faint">{a.moves_money ? `moves money · cap ${inr(a.policy_cap)}` : "no money moves"}{a.reversible ? " · undoable" : ""}</div>
      </td>
      <td className="px-2 py-2 align-top">
        <div className="flex items-center gap-1">
          <input aria-label={`Error ceiling for ${a.label}`} type="number" step="0.1" min="0.05" max="25" value={alpha}
            onChange={(e) => setAlpha(e.target.value)} onBlur={() => Number(alpha) / 100 !== a.alpha && onChange({ alpha: Number(alpha) / 100 })}
            className="h-7 w-16 rounded border border-line-strong bg-panel-2 px-1.5 text-right text-[12px] tabular" />
          <span className="text-[11.5px] text-muted">%</span>
        </div>
      </td>
      <td className="px-2 py-2 align-top">
        <div className="inline-flex overflow-hidden rounded-md border border-line-strong" role="radiogroup" aria-label={`Autonomy for ${a.label}`}>
          {RUNGS.map((r, i) => (
            <button key={r} role="radio" aria-checked={a.rung === i} onClick={() => a.rung !== i && onChange({ rung: i })}
              className={cx("h-7 cursor-pointer px-2 text-[11.5px]", a.rung === i ? "bg-accent/15 text-accent" : "text-muted hover:text-fg")}>{r}</button>
          ))}
        </div>
      </td>
      {cell("small")}{cell("medium")}{cell("large")}
    </tr>
  );
}

export function SupervisorView() {
  const [d, setD] = useState<any>(null);
  const [focus, setFocus] = useState("reverse_failed_debit");
  const [busy, setBusy] = useState(false);
  const policyHash = useUI((s) => s.app?.policy_hash);
  const drift = useUI((s) => s.app?.drift);
  const done = useUI((s) => s.app?.stats.done);
  // only the newest answer is shown: a reload that started before your last change must not undo it on screen
  const seq = useRef(0);
  const load = () => { const n = ++seq.current; return api.supervisor().then((x) => { if (n === seq.current) setD(x); }).catch((e) => toast(e.message, "bad")); };
  useEffect(() => { void load(); }, [policyHash, drift?.alarm, done]);
  if (!d) return <Empty title="Loading…" />;
  const cal = d.calibration;
  const st = d.stats;
  const act = d.actions.find((a: any) => a.id === focus) ?? d.actions[0];
  const lam = act.thresholds?.small?.act?.lambda;
  const op = lam !== null && lam !== undefined && act.curve?.length
    ? act.curve.reduce((a: any, b: any) => (Math.abs(b.lambda - lam) < Math.abs(a.lambda - lam) ? b : a), act.curve[0]) : null;

  const change = async (id: string, patch: { alpha?: number; rung?: number }) => {
    // show the new setting at once; the server's re-certified thresholds replace it when they arrive
    setD((prev: any) => ({ ...prev, actions: prev.actions.map((a: any) => (a.id === id ? { ...a, ...patch } : a)) }));
    const n = ++seq.current;
    try {
      const x = await api.setPolicy(id, patch);
      if (n === seq.current) setD(x);
      toast(`${ACTION_LABEL[id] ?? id}: policy updated; sealed approvals under the old policy will be re-validated`, "info");
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };
  const run = async (fn: () => Promise<any>, msg: string) => {
    setBusy(true);
    try { await fn(); toast(msg, "good"); await load(); } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="page-title">Supervisor console</h2>
            <p className="text-[12.5px] text-muted">Set the error ceiling (α) and the autonomy rung per action. Thresholds are re-certified on every change: with 95% confidence, wrong autonomous actions stay under α. Policy <span className="font-mono">{d.policy_hash}</span>.</p>
          </div>
          <Button disabled={busy} onClick={() => run(api.recalibrate, "Recalibrated with every human decision so far")}><RefreshCw size={13} /> Recalibrate with {st.labels} label(s)</Button>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Resolved with no human" value={pct(st.autonomy)} sub={`${st.done} case(s) handled`} tone="good" />
          <Stat label="Cost per case" value={st.cost_per_case !== null ? inr(st.cost_per_case, true) : "—"} sub={`vs ${inr(st.human_only_cost_per_case)} all-human`} tone="accent" />
          <Stat label="First reply" value={st.avg_first_reply_s !== null ? `${st.avg_first_reply_s}s` : "—"} sub="average, all channels" />
          <Stat label="Waiting on a human" value={st.pending_approvals} sub="sealed approvals" tone={st.pending_approvals ? "bad" : undefined} />
          <Stat label="Calibration error" value={cal.ece_calibrated.toFixed(3)} sub={`stated confidence ${cal.ece_stated.toFixed(3)}`} tone="good" />
          <Stat label="Drift (PSI)" value={d.drift.psi.toFixed(2)} sub={d.drift.alarm ? "alarm: failing closed" : "within range"} tone={d.drift.alarm ? "bad" : undefined} />
        </div>

        <Card title="Autonomy dial" pad={false} actions={<span className="text-[11.5px] text-muted">Bigger amounts get a stricter ceiling: small ×1 · medium ×½ · large ×¼</span>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left">
              <thead className="caps text-faint">
                <tr><th className="py-2 pl-3.5 font-medium">Action</th><th className="px-2 font-medium">α ceiling</th><th className="px-2 font-medium">Autonomy</th><th className="px-2 font-medium">Up to ₹2,000</th><th className="px-2 font-medium">₹2,000–₹20,000</th><th className="px-2 font-medium">Above ₹20,000</th></tr>
              </thead>
              <tbody>{d.actions.map((a: any) => <ActionRow key={a.id} a={a} onChange={(p) => change(a.id, p)} />)}</tbody>
            </table>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Is a 0.9 really right nine times in ten?">
            <LineChart ariaLabel="Reliability diagram: stated versus calibrated confidence against observed accuracy"
              xLabel="Confidence" yLabel="Observed accuracy" diagonal xDomain={[0, 1]} yDomain={[0, 1]}
              series={[
                { id: "stated", label: "Model's stated confidence", color: "var(--series-2)", labelAt: 0.6, labelPos: "below", points: cal.reliability_stated.map((p: any) => ({ x: p.confidence, y: p.accuracy, n: p.count })) },
                { id: "calibrated", label: "Nirnaya calibrated", color: "var(--series-1)", labelAt: 0.35, labelPos: "above", points: cal.reliability_calibrated.map((p: any) => ({ x: p.confidence, y: p.accuracy, n: p.count })) },
              ]} />
            <p className="mt-2 text-[12px] text-muted">On {cal.n_test.toLocaleString("en-IN")} held-out cases the stated confidence is off by {cal.ece_stated.toFixed(3)} on average; after calibration, {cal.ece_calibrated.toFixed(3)}. Routing only ever uses the calibrated score. {cal.real_labels ? `${cal.real_labels} real human label(s) included.` : "Labels are synthetic until pilot data arrives; every approval, rejection and undo adds a real one."}</p>
          </Card>
          <Card title="How much can it handle alone, and how right is it?" actions={
            <select aria-label="Action" value={focus} onChange={(e) => setFocus(e.target.value)} className="h-7 rounded border border-line-strong bg-panel-2 px-1.5 text-[12px]">
              {d.actions.map((a: any) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>}>
            <LineChart ariaLabel={`Deflection versus precision for ${act.label}`} xLabel="Share handled alone" yLabel="Share right"
              xDomain={[0, 1]} yDomain={[Math.max(0, Math.min(...(act.curve ?? [{ precision: 0.8 }]).map((p: any) => p.precision)) - 0.02), 1]}
              fmtX={(v) => pct(v)} fmtY={(v) => pct(v, 1)}
              series={[{ id: "curve", label: act.label, color: "var(--series-1)", points: (act.curve ?? []).map((p: any) => ({ x: p.deflection, y: p.precision })).sort((a: any, b: any) => a.x - b.x) }]}
              marker={op ? { x: op.deflection, y: op.precision, label: `certified operating point (λ ${lam.toFixed(3)})` } : null} />
            <p className="mt-2 text-[12px] text-muted">{op ? `At the certified threshold, ${act.label.toLowerCase()} handles about ${pct(op.deflection)} of these cases alone at ${pct(op.precision, 2)} precision (small band).` : `No threshold can be certified for ${act.label.toLowerCase()} yet, so it always goes to a human.`}</p>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={<span className="flex items-center gap-2">Drift monitor {d.drift.alarm ? <Badge tone="bad"><ShieldAlert size={11} /> failing closed</Badge> : <Badge tone="good"><ShieldCheck size={11} /> stable</Badge>}</span>}
            actions={<>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(api.injectDrift, "Injected 30 unfamiliar cases into the monitor")}><Activity size={13} /> Inject drift</Button>
              <Button size="sm" disabled={busy || !d.drift.alarm} onClick={() => run(api.clearDrift, "Drift cleared by a person; thresholds restored")}>Clear</Button>
            </>}>
            <LineChart ariaLabel="Population stability index over time" xLabel="Check" yLabel="PSI" height={170}
              xDomain={[0, Math.max(1, d.drift_history.length - 1)]} yDomain={[0, Math.max(0.5, ...d.drift_history.map((h: any) => h.psi)) * 1.1]}
              fmtX={(v) => v.toFixed(0)} fmtY={(v) => v.toFixed(2)} hLine={{ y: 0.25, label: "alarm at 0.25" }}
              series={[{ id: "psi", label: "PSI", color: "var(--series-1)", points: d.drift_history.map((h: any, i: number) => ({ x: i, y: h.psi })) }]} />
            <p className="mt-2 text-[12px] text-muted">{d.drift.alarm ? `${d.drift.reason}. Every α is halved and autonomy is capped at Hedge until a person clears it.` : "Live scores look like the calibration set. If they stop looking like it, or humans start overturning autonomous actions, Nirnaya gets more careful, never less."}</p>
          </Card>
          <Card title="Routines" pad={false}>
            <ul className="divide-y divide-line">
              {d.routines.map((r: any) => (
                <li key={r.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium">{r.name}</div>
                    <div className="text-[11.5px] text-muted">{r.desc}{r.paused ? " · paused" : ""} · last {r.last ? ago(r.last) : "never"}{r.result ? ` · ${typeof r.result === "string" ? r.result : JSON.stringify(r.result)}` : ""}</div>
                  </div>
                  <Button size="sm" disabled={busy} onClick={() => run(() => api.runRoutine(r.id), `${r.name} ran`)}><Play size={12} /> Run</Button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
