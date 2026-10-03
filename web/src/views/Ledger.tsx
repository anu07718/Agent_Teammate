import { PlugZap, RefreshCw, RotateCcw, Waves } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, cx } from "../components/ui";
import { inr } from "../lib/format";
import { refresh, toast, useUI } from "../store";
import { ImportCard, RazorpayCard } from "./FeedCards";

const SOURCE: Record<string, string> = { razorpay_test: "Razorpay test", import: "Imported", demo: "Demo bank" };
const SYSTEMS = ["UPI switch", "Core banking", "Refund engine", "CRM", "Wallet ledger", "Dispute desk", "Card & UPI control", "Messaging"];

export function LedgerView() {
  const [data, setData] = useState<any>(null);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const theme = useUI((s) => s.theme);
  const rev = useUI((s) => s.events.filter((e) => e.kind === "rail.event" || e.kind === "rail.reset" || e.kind === "case.finished" || e.kind === "approval.granted").length);
  const load = () => api.ledger().then(setData).catch((e) => toast(e.message, "bad"));
  useEffect(() => { void load(); }, [rev]);

  useEffect(() => {
    if (!data || !box.current) return;
    let dispose: (() => void) | null = null;
    let cancelled = false;
    // Univer gets a node React does not manage, so neither removes the other's children
    const el = document.createElement("div");
    el.style.width = "100%";
    el.style.height = "100%";
    box.current.appendChild(el);
    import("./univerSheet").then(({ mountWorkbook }) => {
      if (cancelled) return;
      try {
        dispose = mountWorkbook(el, [
          { id: "txns", name: "Transactions", header: ["Source", "Txn", "Customer", "Account (token)", "Amount ₹", "Merchant", "UTR", "UPI switch", "Debit", "Reversal", "Refund", "Dispute", "Version"],
            widths: [100, 150, 80, 130, 90, 150, 120, 90, 80, 90, 90, 80, 70],
            rows: data.transactions.map((t: any) => [SOURCE[t.source] ?? "Demo bank", t.id, t.customer_id, t.account, t.amount, t.merchant, t.utr, t.npci_status, t.debit_status, t.reversal, t.refund, t.dispute ?? "", t.version]) },
          { id: "accts", name: "Accounts", header: ["Account (token)", "Customer", "Balance ₹", "Version"], widths: [150, 90, 120, 80],
            rows: data.accounts.map((a: any) => [a.account, a.customer_id, a.balance, a.version]) },
          { id: "credits", name: "Credits & disputes", header: ["Id", "Customer / Txn", "Kind", "Amount ₹", "Status"], widths: [80, 120, 150, 100, 100],
            rows: [...data.wallet_credits.map((w: any) => [w.id, w.customer_id, w.reason, w.amount, w.status]),
                   ...data.disputes.map((d: any) => [d.id, d.txn_id, d.kind, "", d.status]),
                   ...data.blocks.map((b: any) => [b.id, b.customer_id, `block ${b.instrument}`, "", b.status])] },
          { id: "payouts", name: "Payouts", header: ["Payout", "To", "Email", "Phone", "Amount ₹", "For", "Status", "Task"], widths: [80, 120, 150, 110, 90, 150, 110, 80],
            rows: (data.payouts ?? []).map((p: any) => [p.id, p.to?.name ?? "", p.to?.email ?? "", p.to?.phone ?? "", p.amount, p.reason ?? "",
                                                         p.simulated ? `${p.status} (simulated)` : p.status, p.op_id]) },
        ], theme === "dark");
      } catch {
        setFailed(true);
      }
    }).catch(() => setFailed(true));
    return () => {
      cancelled = true;
      try { dispose?.(); } catch { /* already torn down */ }
      el.remove();
    };
  }, [data, theme]);

  const counts: Record<string, number> = {};
  for (const t of data?.transactions ?? []) counts[t.source ?? "demo"] = (counts[t.source ?? "demo"] ?? 0) + 1;

  const outage = async (s: string, down: boolean) => {
    await api.outage(s, down);
    toast(down ? `${s} is now failing. Watch the breaker open after 3 calls.` : `${s} restored`, down ? "warn" : "good");
    await load();
    await refresh();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2.5">
        <h2 className="page-title mr-2 text-[22px]">Ledger</h2>
        <span className="text-[12px] text-muted" data-testid="ledger-sources">
          {Object.entries(counts).map(([k, n]) => `${SOURCE[k] ?? k} ${n}`).join(" · ") || "No payments yet"}
        </span>
        <Button size="sm" onClick={load}><RefreshCw size={13} /> Refresh</Button>
        <Button size="sm" variant="ghost" onClick={async () => { await api.resetWorld(); toast("The demo bank is back to its seeded state; what you fed in stays", "info"); await load(); }}><RotateCcw size={13} /> Reset world</Button>
        <span className="mx-1 h-5 w-px bg-line" />
        <PlugZap size={13} className="text-muted" />
        {SYSTEMS.map((s) => {
          const down = data?.down?.includes(s);
          return (
            <button key={s} onClick={() => outage(s, !down)} title={down ? "Restore" : "Simulate an outage"}
              className={cx("caps h-7 cursor-pointer rounded-full border px-2.5", down ? "border-escalate/40 bg-escalate/15 text-escalate" : "border-line-strong text-muted hover:border-fg hover:text-fg")}>
              {s}{down ? " · down" : ""}
            </button>
          );
        })}
      </div>
      <div className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[1fr_360px]">
        <div className="min-h-[420px] overflow-hidden rounded-lg border border-line bg-panel">
          {failed ? <div className="p-4 text-[12.5px] text-muted">The spreadsheet view could not load; the tables are on the right.</div> : <div ref={box} className="h-full w-full" />}
        </div>
        <div className="min-h-0 space-y-3 overflow-y-auto">
          <RazorpayCard onChange={load} />
          <ImportCard onChange={load} />
          <Card title="Move the ground" pad>
            <p className="mb-2 text-[12px] text-muted">Demo bank only. Change the live ledger under a parked case, then try to approve it. The Seal will not match, so the old approval is not applied.</p>
            <ul className="space-y-1.5">
              {data?.transactions.filter((t: any) => (t.source ?? "demo") === "demo").map((t: any) => (
                <li key={t.id} className="flex items-center gap-2 text-[12px]">
                  <span className="w-14 font-mono">{t.id}</span>
                  <span className="flex-1 truncate text-muted">{inr(t.amount)} · {t.merchant}</span>
                  <Button size="sm" variant="ghost" disabled={!t.can} aria-label={`Move the ground on ${t.id}`}
                    title={t.can === "reversal_lands" ? "The bank's auto-reversal lands" : t.can === "merchant_refund" ? "The merchant's refund lands" : "Already reversed or refunded"}
                    onClick={async () => {
                      try {
                        const r = await api.railEvent(t.id, "auto");
                        toast(`${t.id}: ${r.event === "merchant_refund" ? "the merchant's refund" : "the bank's auto-reversal"} landed (version ${r.version})`, "warn");
                        await load();
                      } catch (e) { toast((e as Error).message, "bad"); }
                    }}><Waves size={12} /></Button>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Accounts">
            <ul className="space-y-1 text-[12px]">
              {data?.float && <li className="flex justify-between gap-2" data-testid="float"><span className="text-muted">Float (payouts)</span><span className="tabular">{inr(data.float.balance, true)}</span><Badge>{data.float.version.split("@")[1] ? `v${data.float.version.split("@")[1]}` : ""}</Badge></li>}
              {data?.accounts.map((a: any) => (
                <li key={a.account} className="flex justify-between gap-2"><span className="font-mono text-muted">{a.account}</span><span className="tabular">{inr(a.balance, true)}</span><Badge>v{a.version}</Badge></li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
