// Channels: the agents on real email, WhatsApp and phone calls. The inbox shows every conversation live;
// the other tabs connect a provider (each field says where to find it), show the webhook address to paste
// into the provider, and send a test. Secrets are never shown again after saving, only "saved".
import { Copy, ExternalLink, Inbox, Mail, MessageCircle, Phone, RefreshCw, Send, Trash2, Users, Webhook } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Empty, Mono, Tabs, cx } from "../components/ui";
import { ago, clock } from "../lib/format";
import { openCase, toast, useUI } from "../store";
import { capi, CHANNEL_ICON, CHANNEL_LABEL, type ChannelId, type Conv, type Snapshot } from "./api";

type Tab = "inbox" | "email" | "whatsapp" | "voice" | "hook" | "contacts";
const inputCls = "h-8 w-full rounded-md border border-line-strong bg-panel-2 px-2.5 text-[12.5px] outline-none focus:border-accent disabled:opacity-60";

interface Spec { k: string; label: string; ph?: string; hint?: React.ReactNode; options?: [string, string][]; secret?: boolean; num?: boolean; show?: (d: any) => boolean }

const EMAIL: Spec[] = [
  { k: "address", label: "Support address", ph: "support@yourcompany.com or you@gmail.com" },
  { k: "name", label: "Name on emails", ph: "Nirnaya Support" },
  { k: "receive", label: "Receive mail", options: [["imap", "Read a mailbox (IMAP)"], ["webhook", "A forwarder POSTs each email here"]] },
  { k: "send", label: "Send mail", options: [["smtp", "Through the mailbox (SMTP)"], ["brevo", "Brevo API (300 a day free)"], ["resend", "Resend API (100 a day free)"]],
    hint: "Hosts that block SMTP (Render's and Hugging Face's free tiers) need Brevo or Resend." },
  { k: "username", label: "Mailbox login", ph: "you@gmail.com", show: (d) => d.receive === "imap" || d.send === "smtp" },
  { k: "password", label: "Mailbox password", secret: true, ph: "an app password, not your normal password", show: (d) => d.receive === "imap" || d.send === "smtp",
    hint: <>Gmail: turn on 2-Step Verification, then Google account → Security → <b>App passwords</b>. Paste the 16 letters here.</> },
  { k: "imap_host", label: "IMAP server", ph: "imap.gmail.com", show: (d) => d.receive === "imap" },
  { k: "imap_port", label: "IMAP port", num: true, show: (d) => d.receive === "imap" },
  { k: "folder", label: "Folder", ph: "INBOX", show: (d) => d.receive === "imap" },
  { k: "poll_seconds", label: "Check every (seconds)", num: true, show: (d) => d.receive === "imap" },
  { k: "smtp_host", label: "SMTP server", ph: "smtp.gmail.com", show: (d) => d.send === "smtp" },
  { k: "smtp_port", label: "SMTP port", num: true, show: (d) => d.send === "smtp" },
  { k: "smtp_security", label: "SMTP security", options: [["starttls", "STARTTLS (587)"], ["ssl", "SSL (465)"], ["none", "None (a test server)"]], show: (d) => d.send === "smtp" },
  { k: "api_key", label: "API key", secret: true, show: (d) => d.send === "brevo" || d.send === "resend",
    hint: "Brevo: SMTP & API → API keys. Resend: API Keys. The support address must be a sender they have verified." },
  { k: "inbound_token", label: "Inbound token", secret: true, show: (d) => d.receive === "webhook",
    hint: "Any long random text. The forwarder sends it as X-Nirnaya-Token (or ?token=)." },
  { k: "accept", label: "Answer", options: [["contacts", "Only contacts (recommended)"], ["anyone", "Anyone who writes"]],
    hint: "With “only contacts”, a personal inbox never answers newsletters or strangers. Add people under Contacts." },
  { k: "forward_to", label: "Forward escalations to", ph: "supervisor@yourcompany.com",
    hint: "Gets the sealed summary of every case that needs a person; replying APPROVE or REJECT decides it." },
];
const WHATSAPP: Spec[] = [
  { k: "provider", label: "Provider", options: [["meta", "Meta WhatsApp Cloud API (official)"], ["waha", "WAHA, self-hosted (unofficial)"]] },
  { k: "phone_number_id", label: "Phone number ID", ph: "from WhatsApp → API Setup", show: (d) => d.provider === "meta" },
  { k: "token", label: "Access token", secret: true, show: (d) => d.provider === "meta",
    hint: "API Setup gives a 24-hour token for trying it; a System User token (Business settings) does not expire." },
  { k: "app_secret", label: "App secret", secret: true, show: (d) => d.provider === "meta", hint: "App settings → Basic → App secret. Used to check that webhooks really come from Meta." },
  { k: "verify_token", label: "Verify token", ph: "any text you choose", show: (d) => d.provider === "meta", hint: "Type the same text in Meta's webhook settings." },
  { k: "graph_version", label: "Graph API version", ph: "v23.0", show: (d) => d.provider === "meta" },
  { k: "waha_url", label: "WAHA address", ph: "http://localhost:3000", show: (d) => d.provider === "waha" },
  { k: "waha_session", label: "WAHA session", ph: "default", show: (d) => d.provider === "waha" },
  { k: "waha_api_key", label: "WAHA API key", secret: true, show: (d) => d.provider === "waha", hint: "If you started WAHA with WAHA_API_KEY." },
  { k: "waha_hmac_key", label: "Webhook HMAC key", secret: true, show: (d) => d.provider === "waha",
    hint: "The WHATSAPP_HOOK_HMAC_KEY you gave WAHA. Needed when WAHA reaches Nirnaya over the internet." },
  { k: "accept", label: "Answer", options: [["contacts", "Only contacts"], ["anyone", "Anyone who writes"]] },
];
const VOICE: Spec[] = [
  { k: "account_sid", label: "Account SID", ph: "AC…", hint: "Twilio Console → Account info." },
  { k: "auth_token", label: "Auth token", secret: true },
  { k: "from_number", label: "Twilio phone number", ph: "+1…", hint: "The number customers call, and that calls them." },
  { k: "language", label: "Language", options: [["en-IN", "English (India)"], ["hi-IN", "Hindi"], ["en-US", "English (US)"], ["en-GB", "English (UK)"]] },
  { k: "voice", label: "Voice", options: [["Polly.Raveena", "Raveena (en-IN)"], ["Polly.Aditi", "Aditi (hi-IN, en-IN)"], ["Polly.Joanna", "Joanna (en-US)"], ["alice", "Alice (basic)"]] },
  { k: "accept", label: "Answer calls from", options: [["anyone", "Anyone (asks who they are)"], ["contacts", "Only contacts"]] },
];
const HOOK: Spec[] = [
  { k: "token", label: "Token", secret: true, hint: "Any long random text. Callers send it as X-Nirnaya-Token." },
  { k: "url", label: "Send replies and case events to", ph: "https://your-n8n/webhook/nirnaya", hint: "Optional: an n8n Webhook node, Make or Zapier URL." },
  { k: "outreach_url", label: "Agents' outreach URL (n8n)", ph: "https://you.app.n8n.cloud/webhook/nirnaya-outreach",
    hint: "The n8n workflow that delivers the agents' messages and calls. Empty: the URL above. Keep them apart so case events do not reach it." },
  { k: "outreach", label: "Agents' outreach (pay, ask, message, call) goes through n8n", options: [["auto", "For channels not set up here"], ["always", "Always"], ["never", "Never"]],
    hint: "The n8n workflow sends by Gmail, WhatsApp or Twilio and answers whether it worked. Settings → Outreach has its limits and a Test." },
];
const PRESETS: Record<string, Record<string, unknown>> = {
  Gmail: { imap_host: "imap.gmail.com", imap_port: 993, smtp_host: "smtp.gmail.com", smtp_port: 587, smtp_security: "starttls", receive: "imap", send: "smtp" },
  Yahoo: { imap_host: "imap.mail.yahoo.com", imap_port: 993, smtp_host: "smtp.mail.yahoo.com", smtp_port: 465, smtp_security: "ssl", receive: "imap", send: "smtp" },
  "Zoho (India)": { imap_host: "imap.zoho.in", imap_port: 993, smtp_host: "smtp.zoho.in", smtp_port: 465, smtp_security: "ssl", receive: "imap", send: "smtp" },
};

function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(() => toast("Copied", "good"), () => toast(text, "info"));
}

export function ChannelsView() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem("nirnaya.channels.tab") as Tab) || "inbox");
  const events = useUI((s) => s.events.filter((e) => e.kind === "channel.message" || e.kind === "channel.error" || e.kind === "channels.changed").length);
  const go = (t: Tab) => { setTab(t); try { sessionStorage.setItem("nirnaya.channels.tab", t); } catch { /* storage off */ } };
  const load = () => capi.get().then(setSnap).catch((e) => toast(e.message, "bad"));
  useEffect(() => { void load(); }, [events]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!snap) return <Empty title="Loading…" />;
  const cards: { id: Tab; ch: ChannelId; label: string; icon: React.ReactNode; provider: string }[] = [
    { id: "email", ch: "email", label: "Email", icon: <Mail size={15} />, provider: snap.config.email.receive === "imap" ? `IMAP · ${snap.config.email.send}` : `webhook · ${snap.config.email.send}` },
    { id: "whatsapp", ch: "whatsapp", label: "WhatsApp", icon: <MessageCircle size={15} />, provider: snap.config.whatsapp.provider === "meta" ? "Meta Cloud API" : "WAHA" },
    { id: "voice", ch: "voice", label: "Phone calls", icon: <Phone size={15} />, provider: "Twilio" },
    { id: "hook", ch: "hook", label: "Webhooks (n8n)", icon: <Webhook size={15} />, provider: "any tool" },
  ];
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-6xl space-y-4">
        <div>
          <h2 className="page-title">Channels</h2>
          <p className="text-[12.5px] text-muted">The agents answer real email, WhatsApp and phone calls, and talk on the call page. Every message becomes a case in the same ten steps; replies go back the way they came.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          {cards.map((c) => {
            const st = snap.status[c.ch];
            const on = !!snap.config[c.ch]?.enabled;
            return (
              <button key={c.id} onClick={() => go(c.id)} data-channel={c.ch}
                className={cx("shadow-card min-w-0 cursor-pointer rounded-xl border bg-panel px-3 py-2.5 text-left hover:border-fg/50 sm:px-4 sm:py-3", tab === c.id ? "border-fg/70" : "border-line")}>
                <div className="caps flex flex-wrap items-center gap-x-2 gap-y-1 text-fg"><span className="flex min-w-0 items-center gap-2">{c.icon}<span className="truncate">{c.label}</span></span>
                  <Badge tone={!on ? "muted" : st?.ok === false ? "bad" : st?.ok ? "good" : "accent"} className="ml-auto">{!on ? "off" : st?.ok === false ? "error" : st?.ok ? "working" : "on"}</Badge>
                </div>
                <div className="mt-1 text-[11.5px] text-muted">{c.provider}</div>
                <div className="mt-1 text-[11.5px] tabular text-faint">{st?.received ?? 0} in · {st?.sent ?? 0} out{st?.failed ? ` · ${st.failed} failed` : ""}{st?.last ? ` · ${ago(st.last)}` : ""}</div>
                {on && st?.error && <div className="mt-1 line-clamp-2 text-[11.5px] text-escalate" title={st.error}>{st.error}</div>}
              </button>
            );
          })}
        </div>
        <PublicUrl snap={snap} onSaved={setSnap} />
        <Card pad={false}>
          <Tabs value={tab} onChange={go} tabs={[
            { id: "inbox", label: <span className="flex items-center gap-1.5"><Inbox size={13} /> Inbox</span> },
            { id: "email", label: "Email" }, { id: "whatsapp", label: "WhatsApp" }, { id: "voice", label: "Calls" },
            { id: "hook", label: "Webhooks" }, { id: "contacts", label: <span className="flex items-center gap-1.5"><Users size={13} /> Contacts</span> },
          ]} />
          <div className="p-4">
            {tab === "inbox" && <InboxPane snap={snap} />}
            {tab === "email" && <ChannelForm ch="email" specs={EMAIL} snap={snap} onSaved={setSnap} presets={PRESETS}
              extra={(d) => <EmailExtras snap={snap} d={d} reload={load} />} testTo="customer@example.com" />}
            {tab === "whatsapp" && <ChannelForm ch="whatsapp" specs={WHATSAPP} snap={snap} onSaved={setSnap}
              extra={(d) => <Hooks rows={d.provider === "meta"
                ? [["Callback URL (WhatsApp → Configuration → Webhook)", snap.webhooks.whatsapp], ["Verify token", d.verify_token || "(set one above)"]]
                : [["WHATSAPP_HOOK_URL for WAHA", snap.webhooks.waha], ["WHATSAPP_HOOK_EVENTS", "message"]]} />}
              testTo="919876543210" testHint="With country code, no +. On Meta's test number it must be one of its 5 allowed numbers. Write template:hello_world to start a chat with Meta's sample template." />}
            {tab === "voice" && <ChannelForm ch="voice" specs={VOICE} snap={snap} onSaved={setSnap}
              extra={<><Hooks rows={[["A call comes in (Twilio → Phone Numbers → your number → Voice)", snap.webhooks.voice]]} /><CallPageCard url={snap.webhooks.call_page} /></>}
              testTo="+919876543210" testLabel="Call this number" testHint="A trial account calls only numbers you verified in Twilio (Verified Caller IDs)." />}
            {tab === "hook" && <ChannelForm ch="hook" specs={HOOK} snap={snap} onSaved={setSnap} extra={<HookHelp snap={snap} />} testLabel="Send a test event" />}
            {tab === "contacts" && <ContactsPane snap={snap} onSaved={setSnap} reload={load} />}
          </div>
        </Card>
      </div>
    </div>
  );
}

function PublicUrl({ snap, onSaved }: { snap: Snapshot; onSaved: (s: Snapshot) => void }) {
  const [url, setUrl] = useState(snap.config.public_url);
  const locked = snap.config.locked.includes("public_url");
  useEffect(() => setUrl(snap.config.public_url), [snap.config.public_url]);
  return (
    <Card title="Public address" actions={<span className="hidden text-[11.5px] text-faint sm:inline">WhatsApp and Twilio call your server here</span>}>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
        e.preventDefault();
        capi.save({ public_url: url }).then((s) => { onSaved(s); toast(url ? "Public address saved" : "Public address cleared", "good"); }).catch((x) => toast(x.message, "bad"));
      }}>
        <input aria-label="Public URL" value={url} onChange={(e) => setUrl(e.target.value)} disabled={locked} className={cx(inputCls, "min-w-0 flex-1")}
          placeholder="https://your-tunnel.trycloudflare.com" title={locked ? "set by NIRNAYA_PUBLIC_URL on the server" : undefined} />
        <Button type="submit" disabled={locked}>Save</Button>
      </form>
      <p className="mt-2 text-[11.5px] text-faint">Running on your own computer? <Mono>cloudflared tunnel --url http://localhost:8000</Mono> gives a free https address (no account needed). Email by IMAP and the call page work without one.</p>
    </Card>
  );
}

function Field({ s, d, set, cfg, locked }: { s: Spec; d: any; set: (k: string, v: unknown) => void; cfg: any; locked: boolean }) {
  const id = `f-${s.k}`;
  return (
    <label className="block" htmlFor={id}>
      <span className="mb-1 block caps text-faint">{s.label}</span>
      {s.options ? (
        <select id={id} aria-label={s.label} className={inputCls} value={d[s.k] ?? ""} disabled={locked} onChange={(e) => set(s.k, e.target.value)}>
          {s.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      ) : (
        <input id={id} aria-label={s.label} className={inputCls} disabled={locked}
          type={s.secret ? "password" : s.num ? "number" : "text"} autoComplete={s.secret ? "new-password" : "off"}
          value={d[s.k] ?? ""} onChange={(e) => set(s.k, s.num ? Number(e.target.value) : e.target.value)}
          placeholder={s.secret && cfg[`${s.k}_set`] ? "•••••••• saved (type to replace)" : s.ph} />
      )}
      {locked ? <span className="mt-1 block text-[11px] text-faint">Set by the server's environment.</span> : s.hint && <span className="mt-1 block text-[11px] text-faint">{s.hint}</span>}
    </label>
  );
}

function ChannelForm({ ch, specs, snap, onSaved, extra, presets, testTo = "", testLabel = "Send a test", testHint }: {
  ch: ChannelId; specs: Spec[]; snap: Snapshot; onSaved: (s: Snapshot) => void; extra?: React.ReactNode | ((d: Record<string, any>) => React.ReactNode);
  presets?: Record<string, Record<string, unknown>>; testTo?: string; testLabel?: string; testHint?: string;
}) {
  const cfg = snap.config[ch];
  const blank = () => Object.fromEntries(Object.entries(cfg).filter(([k]) => !k.endsWith("_set")).map(([k, v]) => [k, v]));
  const [d, setD] = useState<Record<string, any>>(blank);
  // what the form was loaded from: a save sends only what changed since, so it never undoes a change made
  // meanwhile somewhere else (a teammate, the API) to a field this form did not touch
  const base = useRef<Record<string, any>>(d);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState(testTo);
  const [text, setText] = useState(ch === "voice" ? "Hello, this is Nirnaya, the support assistant, testing your phone line." : "Hello from Nirnaya: this is a test message.");
  useEffect(() => { if (!dirty) { const fresh = blank(); base.current = fresh; setD(fresh); } }, [snap]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: unknown) => { setD((x) => ({ ...x, [k]: v })); setDirty(true); };
  const locked = (k: string) => snap.config.locked.includes(`${ch}.${k}`);
  const save = async (patch?: Record<string, unknown>) => {
    setBusy(true);
    try {
      const next = { ...d, ...(patch ?? {}) };
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(next)) {
        const spec = specs.find((x) => x.k === k);
        if (k !== "enabled" && !spec) continue;              // only what this form shows
        if (spec?.secret) { if (v) body[k] = v; continue; }  // an empty secret keeps the saved one
        if (v !== base.current[k]) body[k] = v;              // only what changed
      }
      const r = await capi.save({ [ch]: body });
      base.current = { ...base.current, ...body };
      setDirty(false);
      onSaved(r);
      toast(`${CHANNEL_LABEL[ch] ?? ch} saved`, "good");
    } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true);
    try {
      if (dirty) await save();
      await capi.test(ch, to, text);
      toast(ch === "voice" ? `Calling ${to}…` : ch === "hook" ? "Test event delivered" : `Sent to ${to}`, "good");
    } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  const visible = specs.filter((s) => !s.show || s.show(d));
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-[13px] font-medium">
          <input type="checkbox" aria-label={`${CHANNEL_LABEL[ch] ?? ch} on`} checked={!!d.enabled} disabled={locked("enabled")}
            onChange={(e) => { set("enabled", e.target.checked); void save({ enabled: e.target.checked }); }} />
          {ch === "hook" ? "Accept webhooks" : `Answer ${ch === "voice" ? "phone calls" : CHANNEL_LABEL[ch]}`}
        </label>
        {presets && (
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]"><span className="text-faint">Fill in for:</span>
            {Object.entries(presets).map(([n, p]) => <Button key={n} size="sm" variant="ghost" onClick={() => { setD((x) => ({ ...x, ...p })); setDirty(true); }}>{n}</Button>)}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {visible.map((s) => <Field key={s.k} s={s} d={d} set={set} cfg={cfg} locked={locked(s.k)} />)}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>Save</Button>
          {dirty && <Badge tone="warn">unsaved</Badge>}
        </div>
      </div>
      <div className="space-y-4">
        {typeof extra === "function" ? extra(d) : extra}
        <div className="rounded-md border border-line bg-panel-2 p-3">
          <div className="mb-2 caps text-faint">Try it</div>
          {ch !== "hook" && <input aria-label="Test recipient" value={to} onChange={(e) => setTo(e.target.value)} className={cx(inputCls, "mb-2")} placeholder={testTo} />}
          {ch !== "hook" && <textarea aria-label="Test message" value={text} onChange={(e) => setText(e.target.value)} className={cx(inputCls, "mb-2 h-16 resize-none py-1.5")} />}
          <Button size="sm" disabled={busy || !d.enabled || (ch !== "hook" && !to.trim())} onClick={() => void test()}><Send size={12} /> {testLabel}</Button>
          {testHint && <p className="mt-2 text-[11px] text-faint">{testHint}</p>}
          {!d.enabled && <p className="mt-2 text-[11px] text-faint">Switch it on first.</p>}
        </div>
      </div>
    </div>
  );
}

function Hooks({ rows }: { rows: [string, string][] }) {
  return (
    <div className="rounded-md border border-line bg-panel-2 p-3">
      <div className="mb-2 caps text-faint">Paste into the provider</div>
      <div className="space-y-2">
        {rows.map(([l, v]) => (
          <div key={l}>
            <div className="text-[11.5px] text-muted">{l}</div>
            <div className="flex items-center gap-1.5"><Mono className="min-w-0 flex-1 truncate text-[11.5px]">{v}</Mono>
              <button aria-label={`Copy ${l}`} className="cursor-pointer rounded p-1 text-muted hover:bg-panel hover:text-fg" onClick={() => copy(v)}><Copy size={12} /></button></div>
          </div>
        ))}
      </div>
      {rows.some(([, v]) => v.startsWith("http://")) && <p className="mt-2 text-[11px] text-hedge">Providers need an https address: set the public address above.</p>}
    </div>
  );
}

function EmailExtras({ snap, d, reload }: { snap: Snapshot; d: Record<string, any>; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const e = snap.config.email;
  return (
    <div className="space-y-3">
      {d.receive === "imap" ? (
        <div className="rounded-md border border-line bg-panel-2 p-3 text-[12px]">
          <div className="mb-1 caps text-faint">Inbox</div>
          <p className="text-muted">Checked every {e.poll_seconds} s{snap.status.email?.last_poll ? `, last ${ago(snap.status.email.last_poll)}` : ""}. The first check only remembers where your mailbox is, so old mail gets no replies.</p>
          <Button size="sm" className="mt-2" disabled={busy || !e.enabled || e.receive !== "imap"} onClick={async () => {
            setBusy(true);
            try { const r = await capi.poll(); toast(r.started_fresh ? "Connected: new mail from now on will be answered" : `${r.read} new email(s) read`, "good"); }
            catch (x) { toast((x as Error).message, "bad"); } finally { setBusy(false); reload(); }
          }}><RefreshCw size={12} /> Check inbox now</Button>
          {e.receive !== "imap" && <p className="mt-1 text-[11px] text-faint">Save first: the saved settings receive by webhook.</p>}
        </div>
      ) : <Hooks rows={[["POST each email here (JSON: from, subject, text — or raw)", snap.webhooks.email + "?token=…"]]} />}
    </div>
  );
}

function CallPageCard({ url }: { url: string }) {
  return (
    <div className="rounded-md border border-act/30 bg-act/8 p-3 text-[12px]">
      <div className="mb-1 font-medium">Free: the call page</div>
      <p className="text-muted">Customers talk to the agent from Chrome or Edge, on a phone or a computer, with no phone line and no account. It listens, answers out loud, and opens cases like a call would.</p>
      <a href="/call" target="_blank" rel="noreferrer"><Button size="sm" className="mt-2"><ExternalLink size={12} /> Open the call page</Button></a>
      <div className="mt-1 truncate text-[11px] text-faint">{url}</div>
    </div>
  );
}

function HookHelp({ snap }: { snap: Snapshot }) {
  const curl = `curl -X POST ${snap.webhooks.hook} \\\n  -H "X-Nirnaya-Token: <token>" -H "Content-Type: application/json" \\\n  -d '{"channel":"telegram","from":"@aarav","text":"My UPI payment failed"}'`;
  return (
    <div className="space-y-3">
      <Hooks rows={[["Send customer messages here (POST, JSON)", snap.webhooks.hook]]} />
      <div className="rounded-md border border-line bg-panel-2 p-3 text-[12px]">
        <div className="mb-1 caps text-faint">From n8n, Make or a script</div>
        <p className="text-muted">Any channel n8n can read (Telegram, Instagram DMs, Slack, a form) can reach the agents: an HTTP Request node POSTs <Mono>{"{channel, from, name, text}"}</Mono> with the token, and gets the agent's reply back in the answer. With <Mono>"wait": false</Mono> the reply is POSTed to your URL instead.</p>
        <pre className="mt-2 overflow-x-auto rounded bg-panel p-2 text-[11px]">{curl}</pre>
      </div>
    </div>
  );
}

function InboxPane({ snap }: { snap: Snapshot }) {
  const [pick, setPick] = useState<string | null>(null);
  const [conv, setConv] = useState<Conv | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const list = snap.conversations;
  const sel = pick ?? list[0]?.id ?? null;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sel) { setConv(null); return; }
    capi.conversation(sel).then(setConv).catch(() => setConv(null));
  }, [sel, snap]);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [conv?.messages.length]);
  const canReply = conv && ["email", "whatsapp", "hook"].includes(conv.channel);
  if (!list.length) return (
    <Empty title="No conversations yet">Switch on a channel and write to it, or open the <a className="text-accent underline" href="/call" target="_blank" rel="noreferrer">call page</a> and talk to the agent.</Empty>
  );
  return (
    <div className="grid min-h-[420px] gap-3 md:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
      <ul className="max-h-[560px] divide-y divide-line overflow-y-auto rounded-md border border-line" data-testid="conversations">
        {list.map((c) => (
          <li key={c.id}>
            <button data-conv={c.id} onClick={() => setPick(c.id)} className={cx("w-full cursor-pointer px-3 py-2 text-left", sel === c.id ? "bg-accent/10" : "hover:bg-panel-2")}>
              <div className="flex items-center gap-1.5 text-[12.5px]"><span aria-hidden>{CHANNEL_ICON[c.channel] ?? "•"}</span>
                <span className="truncate font-medium">{c.name}</span>{c.customer && !c.customer.startsWith(c.name) && <span className="truncate text-faint">· {c.customer}</span>}
                <span className="ml-auto shrink-0 text-[11px] text-faint">{ago(c.updated_at)}</span></div>
              <div className="truncate text-[11.5px] text-muted">{c.last ? `${c.last.dir === "out" ? "↩ " : ""}${c.last.text}` : ""}</div>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex min-h-0 flex-col rounded-md border border-line">
        {conv ? <>
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[12.5px]">
            <Badge>{CHANNEL_LABEL[conv.channel] ?? conv.channel}</Badge><span className="font-medium">{conv.name}</span><Mono className="text-faint">{conv.address}</Mono>
            {conv.subject && <span className="truncate text-muted">“{conv.subject}”</span>}
            <span className="ml-auto flex flex-wrap gap-1">{conv.case_ids.slice(-4).map((id) => <Button key={id} size="sm" variant="ghost" onClick={() => openCase(id)}>{id}</Button>)}</span>
          </div>
          <div ref={box} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="thread">
            {conv.messages.map((m, i) => (
              <div key={i} className={cx("max-w-[85%] rounded-lg px-3 py-2 text-[12.5px] leading-relaxed", m.dir === "in" ? "bg-panel-2" : "ml-auto bg-accent/14", m.status === "failed" && "border border-escalate/50")}>
                <div className="mb-0.5 flex flex-wrap gap-x-2 caps text-faint">
                  <span>{m.dir === "in" ? conv.name : m.by ? m.by : "Nirnaya"} · {clock(m.ts)}</span>
                  {m.case_id && <span>{m.case_id}</span>}
                  {m.status && <span className={m.status === "failed" ? "text-escalate" : ""}>{m.status}</span>}
                </div>
                <div className="whitespace-pre-wrap break-words">{m.text}</div>
                {m.error && <div className="mt-1 text-[11.5px] text-escalate">{m.error}</div>}
              </div>
            ))}
          </div>
          {canReply && (
            <form className="flex gap-2 border-t border-line p-2" onSubmit={async (e) => {
              e.preventDefault();
              if (!text.trim()) return;
              setBusy(true);
              try { await capi.reply(conv.id, text.trim()); setText(""); }
              catch (x) { toast((x as Error).message, "bad"); } finally { setBusy(false); }
            }}>
              <input aria-label="Reply" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Write to ${conv.name} yourself…`} className={cx(inputCls, "flex-1")} />
              <Button type="submit" disabled={busy || !text.trim()}><Send size={12} /> Send</Button>
            </form>
          )}
        </> : <Empty title="Pick a conversation" />}
      </div>
    </div>
  );
}

function ContactsPane({ snap, onSaved, reload }: { snap: Snapshot; onSaved: (s: Snapshot) => void; reload: () => void }) {
  const [address, setAddress] = useState("");
  const [cust, setCust] = useState(snap.customers[0]?.id ?? "C-1001");
  const unknownLocked = snap.config.locked.includes("unknown");
  const byCustomer = useMemo(() => Object.fromEntries(snap.customers.map((c) => [c.id, c])), [snap.customers]);
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="space-y-3">
        <p className="text-[12.5px] text-muted">Link a real email address or phone number (or an @handle from a webhook channel such as Telegram) to a customer, so the agents know whose payments to look at. Add yourself to try it. People who say who they are in a message are remembered here by themselves.</p>
        <form className="flex flex-wrap gap-2" onSubmit={async (e) => {
          e.preventDefault();
          try { await capi.link(address.trim(), cust); setAddress(""); reload(); toast("Contact linked", "good"); }
          catch (x) { toast((x as Error).message, "bad"); }
        }}>
          <input aria-label="Email or phone" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="you@gmail.com, +91 98765 43210 or @handle" className={cx(inputCls, "min-w-56 flex-1")} />
          <select aria-label="Customer" value={cust} onChange={(e) => setCust(e.target.value)} className={cx(inputCls, "w-48")}>
            {snap.customers.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.id}</option>)}
          </select>
          <Button type="submit" disabled={!address.trim()}>Link</Button>
        </form>
        <ul className="divide-y divide-line rounded-md border border-line" data-testid="contacts">
          {snap.contacts.length ? snap.contacts.map((c) => (
            <li key={c.key} className="flex items-center gap-2 px-3 py-2 text-[12.5px]">
              <span aria-hidden>{c.kind === "email" ? "✉" : c.kind === "phone" ? "📱" : "🔗"}</span><Mono>{c.address}</Mono><span className="text-faint">→</span><span>{c.customer} · {c.customer_id}</span>
              <button aria-label={`Remove ${c.address}`} className="ml-auto cursor-pointer rounded p-1 text-muted hover:text-escalate" onClick={async () => { await capi.unlink(c.address); reload(); }}><Trash2 size={13} /></button>
            </li>
          )) : <li className="px-3 py-3 text-[12px] text-faint">No contacts yet. The demo customers' registered numbers are recognised anyway: {snap.customers.map((c) => `${c.name.split(" ")[0]} ${c.phone}`).join(", ")}.</li>}
        </ul>
      </div>
      <div className="rounded-md border border-line bg-panel-2 p-3">
        <div className="mb-1 caps text-faint">Someone who is not a contact</div>
        <p className="mb-2 text-[12px] text-muted">On channels that answer anyone: ask them for their registered mobile number or customer ID (and remember it), or treat them as one demo customer so anyone can try the agents.</p>
        <select aria-label="Unknown senders" value={snap.config.unknown} disabled={unknownLocked} className={inputCls}
          onChange={(e) => capi.save({ unknown: e.target.value }).then((s) => { onSaved(s); toast("Saved", "good"); }).catch((x) => toast(x.message, "bad"))}>
          <option value="ask">Ask who they are</option>
          {snap.customers.map((c) => <option key={c.id} value={c.id}>Treat as {byCustomer[c.id].name} ({c.id})</option>)}
        </select>
      </div>
    </div>
  );
}
