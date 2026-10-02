import { FlaskConical, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, Empty, Stat } from "../components/ui";
import { ago, pct } from "../lib/format";
import { toast } from "../store";

export function BenchmarkView() {
  const [k, setK] = useState(3);
  const [run, setRun] = useState<any>(null);
  const [hist, setHist] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const load = () => api.benchmarkRuns().then(setHist);
  useEffect(() => { void load(); }, []);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.runBenchmark(k);
      setRun(r);
      toast(`pass^${k} = ${pct(r.pass_k)} · ${r.wrong_autonomous} wrong autonomous action(s)`, r.wrong_autonomous ? "bad" : "good");
      await load();
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="page-title">Simulated customers</h2>
            <p className="text-[12.5px] text-muted">Each scenario is phrased k different ways and run on a fresh copy of the world. pass^k counts a scenario only if every phrasing is handled right, which is what a lucky demo hides. Every run is archived with the α settings it used, so threshold experiments can be compared.</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[12px] text-muted" htmlFor="k">k</label>
            <select id="k" value={k} onChange={(e) => setK(Number(e.target.value))} className="h-8 rounded-md border border-line-strong bg-panel-2 px-2 text-[12.5px]">
              {[1, 2, 3].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <Button variant="primary" disabled={busy} onClick={go}><Play size={13} /> {busy ? "Running…" : "Run benchmark"}</Button>
          </div>
        </div>
        {run && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label={`pass^${run.k}`} value={pct(run.pass_k)} sub={`${run.scenarios} scenarios`} tone={run.pass_k > 0.9 ? "good" : "warn"} />
              <Stat label="pass^1" value={pct(run.pass_1)} sub={`${run.runs} runs`} />
              <Stat label="Handled alone" value={pct(run.autonomy)} sub="of non-refused runs" tone="accent" />
              <Stat label="Wrong autonomous actions" value={run.wrong_autonomous} sub={`${run.seconds}s`} tone={run.wrong_autonomous ? "bad" : "good"} />
            </div>
            <Card title="Scenarios" pad={false}>
              <ul className="divide-y divide-line">
                {run.detail.map((s: any) => (
                  <li key={s.id} className="px-3.5 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[12px]">{s.id}</span>
                      <Badge tone={s.pass_k ? "good" : "bad"}>{s.pass_k ? "pass" : "fail"}</Badge>
                      <span className="ml-auto text-[11.5px] text-muted">{s.runs.filter((r: any) => r.ok).length}/{s.runs.length} phrasings</span>
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {s.runs.map((r: any, i: number) => (
                        <li key={i} className="flex gap-2 text-[11.5px]">
                          <span className={r.ok ? "text-act" : "text-escalate"}>{r.ok ? "✓" : "✗"}</span>
                          <span className="flex-1 truncate text-muted">{r.phrasing}</span>
                          <span className="text-faint">{r.route}</span>
                          {!r.ok && <span className="text-escalate">{r.reasons.join("; ")}</span>}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </Card>
          </>
        )}
        <Card title="Experiment history" pad={false}>
          {hist.length ? (
            <table className="w-full text-left text-[12px]">
              <thead className="caps text-faint"><tr><th className="px-3.5 py-2 font-medium">Run</th><th className="font-medium">When</th><th className="font-medium">k</th><th className="font-medium">pass^k</th><th className="font-medium">Alone</th><th className="font-medium">Wrong alone</th><th className="font-medium">Policy</th></tr></thead>
              <tbody>
                {hist.map((h) => (
                  <tr key={h.id} className="border-t border-line">
                    <td className="px-3.5 py-2 font-mono">{h.id}{h.label ? ` · ${h.label}` : ""}</td>
                    <td className="text-muted">{ago(h.ts)}</td><td>{h.k}</td><td className="tabular">{pct(h.pass_k)}</td>
                    <td className="tabular">{pct(h.autonomy)}</td><td className="tabular">{h.wrong_autonomous}</td><td className="font-mono text-faint">{h.policy_hash}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty icon={<FlaskConical size={24} />} title="No runs yet">Run the benchmark to create the first experiment.</Empty>}
        </Card>
      </div>
    </div>
  );
}
