import { Check, Lock, Pencil, ShieldAlert, Waves, X } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { ACTION_LABEL, inr, short } from "../lib/format";
import { refresh, toast } from "../store";
import { Badge, Button, Mono } from "./ui";

export function DiffTable({ diff }: { diff: { field: string; before: unknown; after: unknown }[] }) {
  if (!diff?.length) return <div className="text-[12px] text-faint">No change to the ledger.</div>;
  const fmt = (v: unknown) =>
    typeof v === "number" ? inr(v, true) : v && typeof v === "object" ? (v as any).status ?? JSON.stringify(v) : String(v ?? "—");
  return (
    <table className="w-full text-[12px]">
      <thead className="text-left text-faint">
        <tr><th className="py-1 font-medium">Field</th><th className="font-medium">Before</th><th className="font-medium">After (shadow)</th></tr>
      </thead>
      <tbody>
        {diff.map((d, i) => (
          <tr key={i} className="border-t border-line">
            <td className="py-1.5 font-mono text-[11.5px]">{d.field}</td>
            <td className="text-muted">{fmt(d.before)}</td>
            <td className="text-act">{fmt(d.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The evidence packet a human decides on: facts, the sealed actions, the shadow diff and the seal itself. */
export function ApprovalCard({ item, onDone }: { item: { case: any; pending: any; facts: string[]; decisions: any[]; text?: string }; onDone?: () => void }) {
  const { pending } = item;
  const [edit, setEdit] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, number>>(() =>
    Object.fromEntries(pending.actions.filter((a: any) => a.amount).map((a: any) => [a.type, a.amount])));
  const [busy, setBusy] = useState<string | null>(null);
  const txn = item.case.txn_id;

  const act = async (kind: "approve" | "reject" | "move") => {
    setBusy(kind);
    try {
      if (kind === "approve") {
        const res = await api.approve(item.case.id, edit ? amounts : undefined);
        // a broken seal is announced by the event stream; only confirm the clean path here
        if (!res.seal_broken) toast(`${item.case.id} approved and committed exactly once`, "good", item.case.id);
      } else if (kind === "reject") {
        await api.reject(item.case.id);
        toast(`${item.case.id} rejected; the decision became a label`, "info", item.case.id);
      } else if (txn) {
        await api.railEvent(txn, item.case.intent === "unauthorized" ? "merchant_refund" : "reversal_lands");
        toast(`The live ledger moved under ${item.case.id}. Try approving now.`, "warn", item.case.id);
      }
      await refresh();
      onDone?.();
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };

  const esc = item.decisions.filter((d: any) => d.route === "ESCALATE");
  return (
    <div className="space-y-3">
      {item.text && <div className="rounded-md bg-panel-2 px-3 py-2 text-[12.5px] text-muted">“{item.text}”</div>}
      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Evidence</div>
        <ul className="space-y-1 text-[12.5px]">
          {item.facts.map((f, i) => <li key={i} className="flex gap-2"><Check size={13} className="mt-0.5 shrink-0 text-act" />{f}</li>)}
        </ul>
      </div>
      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Sealed for your decision</div>
        <ul className="space-y-1.5">
          {pending.actions.map((a: any, i: number) => {
            const d = esc.find((x: any) => x.action.type === a.type);
            return (
              <li key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-2.5 py-2">
                <span className="text-[12.5px] font-medium">{ACTION_LABEL[a.type] ?? a.type}</span>
                {a.amount ? (edit ? (
                  <input type="number" aria-label={`Amount for ${a.type}`} value={amounts[a.type] ?? a.amount}
                    onChange={(e) => setAmounts((m) => ({ ...m, [a.type]: Number(e.target.value) }))}
                    className="h-7 w-28 rounded border border-line-strong bg-panel-2 px-2 text-[12.5px] tabular" />
                ) : <span className="tabular text-[12.5px]">{inr(a.amount)}</span>) : null}
                {d && <span className="text-[11.5px] text-muted">score {d.score.toFixed(4)} · {d.why}</span>}
              </li>
            );
          })}
        </ul>
      </div>
      {pending.shadow?.diff && (
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Shadow run (nothing live has changed)</div>
          <DiffTable diff={pending.shadow.diff} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-gold/10 px-2.5 py-2 text-[11.5px]">
        <Lock size={13} className="text-gold" />
        <span className="text-muted">Seal</span><Mono>{short(pending.seal, 16)}</Mono>
        <span className="text-muted">· ledger</span><Mono>{pending.ledger_version ?? "—"}</Mono>
        <span className="text-muted">· policy</span><Mono>{pending.policy_hash}</Mono>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="good" disabled={!!busy} onClick={() => act("approve")}><Check size={14} /> {edit ? "Approve edited" : "Approve"}</Button>
        <Button disabled={!!busy} onClick={() => setEdit((v) => !v)}><Pencil size={13} /> {edit ? "Cancel edit" : "Edit"}</Button>
        <Button variant="danger" disabled={!!busy} onClick={() => act("reject")}><X size={14} /> Reject</Button>
        {txn && (
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => act("move")} title="Simulate the live ledger changing before you approve">
            <Waves size={13} /> Move the ground
          </Button>
        )}
        {item.case.seal_broken && <Badge tone="warn"><ShieldAlert size={11} /> re-validated after a seal break</Badge>}
      </div>
    </div>
  );
}
