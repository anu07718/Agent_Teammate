// Ledger → where the data comes from: real UPI payments from Razorpay's free test mode, and your own
// customers and payments from a CSV, checked row by row before anything is kept.
import { CreditCard, ExternalLink, FileUp, RefreshCw, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { apiBase, apiLink, apiReq } from "../api";
import { Badge, Button, Card, cx } from "../components/ui";
import { ago } from "../lib/format";
import { refresh, toast, useUI, EMPTY } from "../store";

interface PgState { enabled: boolean; key_id: string; key_secret_set: boolean; webhook_secret_set: boolean; api_url: string; locked: string[]; ready: boolean; payments: number; last_sync: { at: number; seen: number; changed: number } | null }
const input = "h-8 w-full rounded-md border border-line-strong bg-panel-2 px-2.5 text-[12.5px]";
const put = (b: unknown) => apiReq<PgState>("/api/pg", { method: "PUT", body: JSON.stringify(b) });
const post = <T,>(p: string, b?: unknown) => apiReq<T>(p, { method: "POST", body: b === undefined ? undefined : JSON.stringify(b) });

export function RazorpayCard({ onChange }: { onChange: () => void }) {
  const [pg, setPg] = useState<PgState | null>(null);
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [hook, setHook] = useState("");
  const [busy, setBusy] = useState(false);
  const [publicUrl, setPublicUrl] = useState("");
  const customers = useUI((s) => s.app?.customers ?? EMPTY) as { id: string; name: string }[];
  const [cid, setCid] = useState("");
  const [amount, setAmount] = useState("349");
  const [merchant, setMerchant] = useState("CafeBrew");
  const [link, setLink] = useState<string | null>(null);
  const load = () => apiReq<PgState>("/api/pg").then((p) => { setPg(p); setKeyId((k) => k || p.key_id); }).catch(() => setPg(null));
  useEffect(() => {
    void load();
    apiReq<{ config: { public_url: string } }>("/api/channels").then((c) => setPublicUrl(c.config?.public_url || "")).catch(() => undefined);
  }, []);
  useEffect(() => { if (!cid && customers[0]) setCid(customers[0].id); }, [customers, cid]);
  const act = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); } };
  if (!pg) return <Card title="Real UPI payments · Razorpay test mode">—</Card>;
  const hookUrl = `${publicUrl || apiBase() || window.location.origin}/api/pg/razorpay/webhook`;
  return (
    <Card title="Real UPI payments · Razorpay test mode" pad>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]" data-testid="pg-status">
        {pg.ready ? <Badge tone="good">connected</Badge> : <Badge>not set up</Badge>}
        <span className="text-muted">{pg.payments} payment(s) from Razorpay{pg.last_sync ? ` · synced ${ago(pg.last_sync.at)}` : ""}</span>
      </div>
      <p className="mb-2 text-[11.5px] text-muted">
        Free, no KYC: Razorpay's test mode is the real gateway API with real payment and refund objects. No real money
        moves and nothing reaches NPCI. Only test keys (rzp_test_…) are accepted. Every refund on these payments asks a
        person first, because a gateway refund cannot be undone.{" "}
        <a className="inline-flex items-center gap-1 text-fg underline" href="https://dashboard.razorpay.com/app/website-app-settings/api-keys" target="_blank" rel="noreferrer">Get test keys <ExternalLink size={11} /></a>
      </p>
      <div className="grid gap-1.5">
        <input aria-label="Razorpay Key Id" className={input} value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="rzp_test_…" disabled={pg.locked.includes("key_id")} />
        <input aria-label="Razorpay Key Secret" type="password" autoComplete="new-password" className={input} value={secret} onChange={(e) => setSecret(e.target.value)}
          placeholder={pg.key_secret_set ? "Key Secret saved (type to replace)" : "Key Secret"} disabled={pg.locked.includes("key_secret")} />
        <input aria-label="Razorpay webhook secret" type="password" autoComplete="new-password" className={input} value={hook} onChange={(e) => setHook(e.target.value)}
          placeholder={pg.webhook_secret_set ? "Webhook secret saved (type to replace)" : "Webhook secret (optional, for live updates)"} />
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" disabled={busy} onClick={() => void act(async () => {
            setPg(await put({ enabled: true, key_id: keyId.trim(), ...(secret ? { key_secret: secret } : {}), ...(hook ? { webhook_secret: hook } : {}) }));
            setSecret(""); setHook(""); toast("Razorpay test keys saved", "good"); void refresh();
          })}>Save</Button>
          <Button size="sm" variant="primary" disabled={busy || !pg.ready} onClick={() => void act(async () => { await post("/api/pg/test"); toast("Razorpay answered: the test keys work", "good"); })}>Test</Button>
          <Button size="sm" disabled={busy || !pg.ready} onClick={() => void act(async () => {
            const r = await post<{ seen: number; changed: number }>("/api/pg/sync");
            toast(`Synced: ${r.seen} payment(s) on Razorpay, ${r.changed} new or changed`, "good"); await load(); onChange(); void refresh();
          })}><RefreshCw size={12} /> Sync now</Button>
        </div>
      </div>
      {pg.ready && (
        <div className="mt-3 space-y-1.5 border-t border-line pt-3" data-testid="pg-pay">
          <div className="caps text-faint">Make a test payment</div>
          <div className="grid grid-cols-[1fr_80px] gap-1.5">
            <select aria-label="Test payment customer" className={input} value={cid} onChange={(e) => setCid(e.target.value)}>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.id}</option>)}
            </select>
            <input aria-label="Test payment amount" className={input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <input aria-label="Test payment merchant" className={input} value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="Merchant" />
          <Button size="sm" disabled={busy || !cid} onClick={() => void act(async () => {
            const r = await post<{ short_url: string }>("/api/pg/link", { customer_id: cid, amount: Number(amount), merchant });
            setLink(r.short_url); window.open(r.short_url, "_blank", "noopener");
          })}><CreditCard size={12} /> Create a payment link</Button>
          {link && <p className="text-[11.5px] text-muted" data-testid="pg-link">Opened <a className="text-fg underline" href={link} target="_blank" rel="noreferrer">{link}</a>. Pay by UPI with <b>success@razorpay</b> (or <b>failure@razorpay</b> for a failed payment), then <b>Sync now</b>. Pay twice for a "charged twice" case.</p>}
          <div className="caps pt-2 text-faint">Live updates (optional)</div>
          <p className="text-[11.5px] text-muted">In Razorpay → Webhooks (test mode), add <code className="break-all font-mono text-fg">{hookUrl}</code> with the payment and refund events and the secret above. {publicUrl ? "" : "It needs a public address: Channels → Public address."}</p>
          <button className="cursor-pointer text-[11px] text-faint underline hover:text-escalate" onClick={() => void act(async () => {
            setPg(await put({ enabled: false, key_secret: null, webhook_secret: null, key_id: "" })); setKeyId(""); void refresh();
          })}>Remove the keys</button>
        </div>
      )}
    </Card>
  );
}

interface Row { line: number; ok: boolean; errors: string[]; raw: Record<string, string> }
interface Check { kind: string; rows: Row[]; ok: number; rejected: number; problems: string[]; batch?: string | null; imported?: number }
interface Batch { batch: string; file: string; customers: number; transactions: number }

export function ImportCard({ onChange }: { onChange: () => void }) {
  const [kind, setKind] = useState<"transactions" | "customers">("transactions");
  const [text, setText] = useState("");
  const [file, setFile] = useState("pasted.csv");
  const [res, setRes] = useState<Check | null>(null);
  const [data, setData] = useState<{ demo: boolean; batches: Batch[]; max_amount: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => apiReq<{ demo: boolean; batches: Batch[]; max_amount: number }>("/api/data").then(setData).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  const act = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); } };
  const tpl = `${apiBase()}/api/data/template/${kind}.csv`;
  return (
    <Card title="Feed your own data" pad>
      <label className="mb-2 flex cursor-pointer items-center gap-2 text-[12px]">
        <input type="checkbox" aria-label="Demo bank data" checked={!!data?.demo} disabled={!data || busy} onChange={(e) => void act(async () => {
          const on = e.target.checked;
          await post(`/api/data/demo?on=${on}`); toast(on ? "The demo bank's customers and payments are back" : "Demo data hidden: only what you fed in is left", "info");
          await load(); onChange(); void refresh();
        })} />
        <span>The demo bank's customers and payments <span className="text-faint">(simulated)</span></span>
      </label>
      <p className="mb-2 text-[11.5px] text-muted">
        Import customers first, then their UPI payments. Each row is checked: a 12-digit UTR, a real UPI ID, a 10-digit mobile,
        an amount up to ₹{(data?.max_amount ?? 100000).toLocaleString("en-IN")}, no future dates, no duplicates, no spreadsheet
        formulas and no instructions hidden in text. Preview first; Import keeps only the rows that pass.
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <select aria-label="What to import" className={cx(input, "w-auto")} value={kind} onChange={(e) => { setKind(e.target.value as never); setRes(null); }}>
          <option value="transactions">UPI payments</option>
          <option value="customers">Customers</option>
        </select>
        <a {...apiLink(tpl, `nirnaya-${kind}.csv`)} className="caps text-fg underline">Template</a>
        <label className="caps inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-line-strong px-2.5 hover:border-fg">
          <FileUp size={12} /> Choose a CSV
          <input type="file" accept=".csv,text/csv" className="hidden" aria-label="CSV file" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 1_000_000) { toast("That file is over 1 MB; split it", "bad"); return; }
            setFile(f.name); setText(await f.text()); setRes(null);
          }} />
        </label>
      </div>
      <textarea aria-label="CSV text" className="mt-1.5 h-24 w-full rounded-md border border-line-strong bg-panel-2 p-2 font-mono text-[11px]" value={text}
        onChange={(e) => { setText(e.target.value); setRes(null); }} placeholder={kind === "transactions" ? "txn_id,customer,amount,merchant,date,utr,status,debited,refund_status" : "customer_id,name,phone,upi_id,email,segment"} />
      <div className="flex gap-1.5">
        <Button size="sm" disabled={busy || !text.trim()} onClick={() => void act(async () => { setRes(await post<Check>("/api/data/preview", { kind, csv: text, filename: file })); })}>Preview</Button>
        <Button size="sm" variant="primary" disabled={busy || !res || res.ok === 0 || res.problems.length > 0 || res.batch !== undefined} onClick={() => void act(async () => {
          const r = await post<Check>("/api/data/import", { kind, csv: text, filename: file });
          setRes(r); toast(`Imported ${r.imported} row(s)${r.rejected ? `, refused ${r.rejected}` : ""}`, r.imported ? "good" : "warn");
          await load(); onChange(); void refresh();
        })}><Upload size={12} /> Import {res && !res.problems.length ? res.ok : ""} row(s)</Button>
      </div>
      {res && (
        <div className="mt-2 text-[11.5px]" data-testid="import-result">
          {res.problems.map((p) => <p key={p} className="text-escalate">{p}</p>)}
          {!res.problems.length && <p><b className="text-act">{res.ok} pass</b> · <b className={res.rejected ? "text-escalate" : "text-muted"}>{res.rejected} refused</b>{res.imported !== undefined ? ` · ${res.imported} imported` : ""}</p>}
          <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto">
            {res.rows.filter((r) => !r.ok).slice(0, 30).map((r) => (
              <li key={r.line} data-line={r.line}><span className="font-mono text-faint">line {r.line}</span> <span className="text-escalate">{r.errors.join("; ")}</span></li>
            ))}
          </ul>
        </div>
      )}
      {!!data?.batches.length && (
        <div className="mt-3 border-t border-line pt-2">
          <div className="caps mb-1 text-faint">Imported</div>
          <ul className="space-y-1 text-[12px]">
            {data.batches.map((b) => (
              <li key={b.batch} className="flex items-center gap-2" data-batch={b.batch}>
                <span className="flex-1 truncate">{b.file} <span className="text-faint">· {b.customers} customer(s), {b.transactions} payment(s)</span></span>
                <Button size="sm" variant="ghost" aria-label={`Remove ${b.file}`} disabled={busy} onClick={() => void act(async () => {
                  await apiReq(`/api/data/import/${b.batch}`, { method: "DELETE" }); toast(`Removed ${b.file}`, "info"); await load(); onChange(); void refresh();
                })}><Trash2 size={12} /></Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
