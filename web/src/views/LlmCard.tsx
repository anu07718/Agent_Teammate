// Settings → the language model. Free tiers only: each provider in the order they are tried, with its
// free-tier limits, where to get a key, the key (kept on the server, never shown again), the model and a test.
import { ArrowDown, ArrowUp, ExternalLink, FlaskConical } from "lucide-react";
import { useEffect, useState } from "react";
import { apiReq } from "../api";
import { Badge, Button, Card, cx } from "../components/ui";
import { refresh, toast } from "../store";

interface Provider {
  id: string; label: string; free: string; signup: string; local: boolean; free_only: boolean; enabled: boolean;
  key_set: boolean; model: string; base_url: string; default_base: string; locked: string[]; ready: boolean;
  resting: number; models: string[]; calls: number; ok: number; fails: number; error: string | null; ms: number | null;
}
interface Llm { enabled: boolean; off_by_env: boolean; providers: Provider[]; active: { id: string; label: string; model: string } | null; last: { label: string; model: string; ms: number } | null; error: string | null }
interface TestResult { ok: boolean; model?: string; answer?: string; ms?: number; models?: string[]; error?: string }

const put = (body: unknown) => apiReq<Llm>("/api/llm", { method: "PUT", body: JSON.stringify(body) });
const mins = (s: number) => (s >= 90 ? `${Math.round(s / 60)} min` : `${s} s`);

function status(p: Provider) {
  if (!p.enabled) return <Badge>off</Badge>;
  if (p.ready && p.resting) return <Badge tone="warn">resting {mins(p.resting)}</Badge>;
  if (p.ready && p.error) return <Badge tone="bad">error</Badge>;
  if (p.ready) return <Badge tone="good">ready</Badge>;
  return <Badge>{p.local ? "not running" : "no key"}</Badge>;
}

function Row({ p, i, n, onChange, move }: { p: Provider; i: number; n: number; onChange: (l: Llm) => void; move: (d: -1 | 1) => void }) {
  const [key, setKey] = useState("");
  const [base, setBase] = useState(p.base_url);
  const [model, setModel] = useState(p.model);
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState(p.enabled); // shown at once, then confirmed by the server
  useEffect(() => { setModel(p.model); setBase(p.base_url); }, [p.model, p.base_url]);
  useEffect(() => { setOn(p.enabled); }, [p.enabled]);
  const models = [...new Set([...(test?.models ?? p.models), ...(p.model ? [p.model] : [])])];
  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { model, ...extra };
      if (key.trim()) body.key = key.trim();
      if (p.local) body.base_url = base.trim();
      onChange(await put({ providers: { [p.id]: body } }));
      setKey("");
      void refresh();
      toast(`${p.label} saved`, "good");
    } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  const run = async () => {
    setBusy(true);
    try {
      if (key.trim() || (p.local && base.trim() !== p.base_url)) await save();
      const r = await apiReq<TestResult>(`/api/llm/test/${p.id}`, { method: "POST" });
      setTest(r);
      onChange(await apiReq<Llm>("/api/llm"));
    } catch (e) { setTest({ ok: false, error: (e as Error).message }); } finally { setBusy(false); }
  };
  const lockedKey = p.locked.includes("key");
  return (
    <div className={cx("rounded-xl border p-3", p.ready && !p.resting ? "border-act/35" : "border-line")} data-provider={p.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="serif w-5 text-[18px] text-faint">{i + 1}</span>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={on} aria-label={`Use ${p.label}`}
            onChange={async (e) => {
              const want = e.target.checked;
              setOn(want);
              try { onChange(await put({ providers: { [p.id]: { enabled: want } } })); void refresh(); } catch (err) { setOn(!want); toast((err as Error).message, "bad"); }
            }} />
          <span className="text-[13px] font-semibold">{p.label}</span>
        </label>
        {status(p)}
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" aria-label={`Move ${p.label} up`} disabled={i === 0} onClick={() => move(-1)}><ArrowUp size={12} /></Button>
          <Button size="sm" variant="ghost" aria-label={`Move ${p.label} down`} disabled={i === n - 1} onClick={() => move(1)}><ArrowDown size={12} /></Button>
        </span>
      </div>
      <p className="mt-1.5 text-[11.5px] text-muted">{p.free}{p.signup && <> <a className="inline-flex items-center gap-1 text-fg underline" href={p.signup} target="_blank" rel="noreferrer">{p.local ? "Download" : "Get a free key"} <ExternalLink size={11} /></a></>}</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        {p.local ? (
          <input aria-label={`${p.label} address`} value={base} onChange={(e) => setBase(e.target.value)} placeholder={p.default_base || "http://127.0.0.1:1234/v1"}
            disabled={p.locked.includes("base_url")} className="h-8 rounded-md border border-line-strong bg-panel-2 px-2.5 text-[12.5px]" />
        ) : (
          <input aria-label={`${p.label} key`} type="password" autoComplete="new-password" value={key} onChange={(e) => setKey(e.target.value)}
            disabled={lockedKey} placeholder={lockedKey ? "set in the server's environment" : p.key_set ? "saved (type to replace)" : "paste your free API key"}
            className="h-8 rounded-md border border-line-strong bg-panel-2 px-2.5 text-[12.5px]" />
        )}
        <select aria-label={`${p.label} model`} value={model} onChange={(e) => setModel(e.target.value)} disabled={p.locked.includes("model")}
          className="h-8 rounded-md border border-line-strong bg-panel-2 px-2 text-[12.5px]">
          <option value="">Automatic{p.free_only ? " (a free model)" : ""}</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <span className="flex gap-1.5">
          <Button size="sm" disabled={busy} onClick={() => void save()}>Save</Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void run()}><FlaskConical size={12} /> Test</Button>
        </span>
      </div>
      {p.key_set && !lockedKey && !p.local && (
        <button className="mt-1.5 cursor-pointer text-[11px] text-faint underline hover:text-escalate" onClick={() => void save({ key: null })}>Remove the saved key</button>
      )}
      {test && (
        <p className={cx("mt-1.5 text-[11.5px]", test.ok ? "text-act" : "text-escalate")} data-testid={`test-${p.id}`}>
          {test.ok ? `Works: ${test.model} answered “${test.answer}” in ${test.ms} ms · ${test.models?.length ?? 0} free model(s) listed` : test.error}
        </p>
      )}
      {!test && p.error && p.enabled && <p className="mt-1.5 text-[11.5px] text-escalate">{p.error}</p>}
      {p.calls > 0 && <p className="mt-1 text-[11px] text-faint">{p.ok} answered · {p.fails} failed{p.ms ? ` · last in ${p.ms} ms` : ""}</p>}
    </div>
  );
}

export function LlmCard() {
  const [llm, setLlm] = useState<Llm | null>(null);
  const [on, setOn] = useState(true);
  useEffect(() => { apiReq<Llm>("/api/llm").then(setLlm).catch(() => setLlm(null)); }, []);
  useEffect(() => { if (llm) setOn(llm.enabled); }, [llm?.enabled]);
  if (!llm) return <Card title="Language model · free tiers only" className="lg:col-span-2">—</Card>;
  const ids = llm.providers.map((p) => p.id);
  const move = async (i: number, d: -1 | 1) => {
    const order = ids.slice();
    [order[i], order[i + d]] = [order[i + d], order[i]];
    try { setLlm(await put({ order })); void refresh(); } catch (e) { toast((e as Error).message, "bad"); }
  };
  return (
    <Card title="Language model · free tiers only" className="lg:col-span-2">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px]">
        <label className="flex cursor-pointer items-center gap-2 font-semibold">
          <input type="checkbox" checked={on} disabled={llm.off_by_env} aria-label="Use a language model"
            onChange={async (e) => {
              const want = e.target.checked;
              setOn(want);
              try { setLlm(await put({ enabled: want })); void refresh(); } catch (err) { setOn(!want); toast((err as Error).message, "bad"); }
            }} />
          Use a language model
        </label>
        <span className="text-muted" data-testid="llm-now">
          {llm.off_by_env ? "Off: the server was started with NIRNAYA_LLM=off." : !llm.enabled ? "Off: the rules work alone."
            : llm.active ? <>Now first in line: <b className="text-fg">{llm.active.label}</b>{llm.active.model ? ` · ${llm.active.model}` : ""}</>
              : "None ready yet: the rules work alone until you add a free key or start a local model."}
        </span>
        {llm.last && <span className="text-faint">· last answer from {llm.last.label} ({llm.last.model}, {llm.last.ms} ms)</span>}
      </div>
      <p className="mb-3 text-[12px] text-muted">
        Optional. It refines understanding, drafts replies and lets agents answer in their own words, from tokenised text
        only; the Promise Guard still checks every word and the rules decide. Providers are tried top to bottom: when one
        runs out of its free quota it rests and the next answers, and with none the rules carry on. Only free tiers are used:
        never add a card or buy credits.
      </p>
      <div className="grid gap-2.5">
        {llm.providers.map((p, i) => <Row key={p.id} p={p} i={i} n={ids.length} onChange={setLlm} move={(d) => void move(i, d)} />)}
      </div>
    </Card>
  );
}
