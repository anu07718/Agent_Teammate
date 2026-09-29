import { ShieldCheck, ShieldX } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, Mono } from "../components/ui";
import { clock, short } from "../lib/format";
import { openCase, toast, useUI } from "../store";

export function TrailView() {
  const [rows, setRows] = useState<any[]>([]);
  const [v, setV] = useState<any>(null);
  const n = useUI((s) => s.events.length);
  useEffect(() => { api.trail(400).then(setRows); }, [Math.floor(n / 10)]);
  const verify = async (tamper?: number) => {
    const r = await api.verify(tamper);
    setV(r);
    if (tamper) toast(r.ok ? "Unexpected: tampering went unnoticed" : `Tampering with entry #${tamper} breaks the chain at #${r.broken_at}`, r.ok ? "bad" : "good");
  };
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Ledger Trail</h2>
            <p className="text-[12.5px] text-muted">Every decision, tool call, approval and policy change, each entry hashed together with the one before it. Changing any past entry breaks every hash after it.</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => verify()}><ShieldCheck size={13} /> Verify chain</Button>
            <Button variant="ghost" disabled={rows.length < 3} onClick={() => verify(rows[Math.floor(rows.length / 2)]?.seq)}><ShieldX size={13} /> Tamper test</Button>
          </div>
        </div>
        {v && (
          <div className={`rounded-lg border px-3.5 py-2.5 text-[12.5px] ${v.ok ? "border-act/30 bg-act/10" : "border-escalate/30 bg-escalate/10"}`}>
            {v.ok ? <>Chain intact: {v.entries} entries, head <Mono>{short(v.head, 16)}</Mono>.</>
              : <>Chain broken at entry #{v.broken_at}{v.simulated_tamper ? ` (a copy with entry #${v.simulated_tamper} altered; the real trail is untouched)` : ""}.</>}
          </div>
        )}
        <Card title={`${rows.length} most recent entries`} pad={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[12px]">
              <thead className="text-[11px] uppercase tracking-wider text-faint"><tr><th className="px-3.5 py-2 font-medium">#</th><th className="font-medium">Time</th><th className="font-medium">Case</th><th className="font-medium">Event</th><th className="font-medium">By</th><th className="font-medium">Detail</th><th className="font-medium">Hash</th></tr></thead>
              <tbody>
                {[...rows].reverse().map((r) => (
                  <tr key={r.seq} className="border-t border-line align-top">
                    <td className="px-3.5 py-1.5 font-mono text-faint">{r.seq}</td>
                    <td className="text-muted">{clock(r.ts)}</td>
                    <td>{r.case_id !== "-" ? <button className="font-mono hover:underline cursor-pointer" onClick={() => openCase(r.case_id)}>{r.case_id}</button> : <span className="text-faint">system</span>}</td>
                    <td><Badge>{r.kind}</Badge></td>
                    <td className="text-muted">{r.actor}</td>
                    <td className="max-w-[340px] truncate font-mono text-[11px] text-faint" title={JSON.stringify(r.payload)}>{JSON.stringify(r.payload)}</td>
                    <td className="font-mono text-[11px] text-faint">{short(r.hash, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
