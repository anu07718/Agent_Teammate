// Outreach: the agents pay someone, ask them for money, message them or call them, from one sentence typed to
// Intake (or said in any agent's chat). This card holds its limits and the name on its messages, shows which
// channel goes where (sent from Nirnaya, or through the n8n workflow), and tests the n8n workflow with a dry run.
import { Send } from "lucide-react";
import { useEffect, useState } from "react";
import { apiReq } from "../api";
import { Badge, Button, Card } from "../components/ui";
import { inr } from "../lib/format";
import { toast } from "../store";

interface OutreachState {
  settings: { from_name: string; upi_id: string; pay_cap: number; daily_pay_cap: number; request_cap: number; per_contact_hour: number };
  routes: Record<string, "native" | "n8n" | null>;
  people: { name: string; email: string; phone: string; last: number | null }[];
  float: number;
  paid_today: number;
}

const CH: Record<string, string> = { email: "Email", whatsapp: "WhatsApp", call: "Calls", sms: "SMS" };
const inputCls = "h-8 w-full rounded-md border border-line-strong bg-panel-2 px-2.5 text-[12.5px] outline-none focus:border-accent";
const EXAMPLES = [
  "Pay ₹500 to anushka@example.com for dinner",
  "Ask Rahul +91 98765 43210 for ₹1,200 on WhatsApp and call him if he hasn't paid in 2 hours",
  "Email priya@example.com: your refund of ₹349 is processed",
  "anushka ko 500 bhej do",
];

export function OutreachCard() {
  const [s, setS] = useState<OutreachState | null>(null);
  const [d, setD] = useState<OutreachState["settings"] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => apiReq<OutreachState>("/api/outreach").then((x) => { setS(x); setD(x.settings); }).catch(() => setS(null));
  useEffect(() => { void load(); }, []);
  if (!s || !d) return null;

  const save = async () => {
    setBusy(true);
    try {
      await apiReq("/api/outreach", { method: "PUT", body: JSON.stringify(d) });
      toast("Outreach settings saved", "good");
      await load();
    } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true);
    try {
      const r = await apiReq<{ ok: boolean; error?: string }>("/api/outreach/test", { method: "POST" });
      if (r.ok) toast("n8n answered the dry run: the token matches and nothing was sent", "good");
      else toast(r.error || "n8n did not answer", "bad");
    } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  const field = (k: keyof OutreachState["settings"], label: string, num = false, ph = "") => (
    <label className="block text-[11.5px] text-muted">
      {label}
      <input aria-label={label} className={inputCls} value={String(d[k] ?? "")} placeholder={ph} inputMode={num ? "numeric" : undefined}
        onChange={(e) => setD({ ...d, [k]: num ? Number(e.target.value.replace(/[^\d.]/g, "")) || 0 : e.target.value })} />
    </label>
  );

  return (
    <Card title="Outreach · pay, ask, message, call" className="lg:col-span-2">
      <p className="mb-3 text-[12px] text-muted">
        Type it to Intake in the office, or say it in any agent's chat. The agents ask for whatever is missing (who, how much,
        an email or a phone number), the right desks do each part, a payment out always waits for your OK and is sealed, and
        the message goes out from Nirnaya or through your n8n workflow. Only messages about money are sent.
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-1.5" data-testid="outreach-routes">
        {Object.entries(s.routes).map(([c, r]) => (
          <Badge key={c} tone={r ? "good" : "muted"}>{CH[c]}: {r === "native" ? "from Nirnaya" : r === "n8n" ? "via n8n" : "not set up"}</Badge>
        ))}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void test()}><Send size={12} /> Test n8n</Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {field("from_name", "Name on messages", false, "Nirnaya")}
        {field("upi_id", "Your UPI ID (requests without Razorpay)", false, "you@bank")}
        {field("pay_cap", "Most for one payment (₹)", true)}
        {field("daily_pay_cap", "Most paid out a day (₹)", true)}
        {field("request_cap", "Most for one request (₹)", true)}
        {field("per_contact_hour", "Messages to one person an hour", true)}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-muted">
        <Button size="sm" disabled={busy} onClick={() => void save()}>Save</Button>
        <span>Float {inr(s.float)} · paid out today {inr(s.paid_today)} (simulated payouts)</span>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div>
          <div className="caps mb-1 text-faint">Try</div>
          <ul className="space-y-1 text-[12px]">{EXAMPLES.map((x) => <li key={x} className="font-mono text-[11.5px]">{x}</li>)}</ul>
        </div>
        <div>
          <div className="caps mb-1 text-faint">People the agents know</div>
          {s.people.length ? (
            <ul className="space-y-0.5 text-[12px]" data-testid="outreach-people">
              {s.people.slice(0, 8).map((p) => <li key={p.name}><b>{p.name}</b> <span className="text-muted">{[p.email, p.phone].filter(Boolean).join(" · ")}</span></li>)}
            </ul>
          ) : <p className="text-[12px] text-muted">Nobody yet: a task's email or phone is remembered for next time.</p>}
        </div>
      </div>
    </Card>
  );
}
