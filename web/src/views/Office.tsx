import { MessageSquare, Phone, Send, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Badge, Button, Empty, RouteBadge, StatusDot, cx } from "../components/ui";
import { ago, inr, INTENT_LABEL } from "../lib/format";
import { OfficeEngine } from "../office/engine";
import { getState, openCase, setState, toast, useUI, EMPTY } from "../store";

export function TaskBar({ compact = false }: { compact?: boolean }) {
  const app = useUI((s) => s.app);
  const [customer, setCustomer] = useState("C-1001");
  const [channel, setChannel] = useState("chat");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  if (!app) return null;
  const send = async (cid = customer, msg = text) => {
    if (!msg.trim()) return;
    setBusy(true);
    try {
      const c = await api.createCase(cid, msg, channel);
      toast(`${c.id} opened`, "info", c.id);
      setText("");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-b border-line bg-panel px-3 py-2.5">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <select aria-label="Customer" value={customer} onChange={(e) => setCustomer(e.target.value)}
          className="h-8 rounded-md border border-line-strong bg-panel-2 px-2 text-[12.5px]">
          {app.customers.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.id}</option>)}
        </select>
        <div className="flex h-8 overflow-hidden rounded-md border border-line-strong" role="radiogroup" aria-label="Channel">
          {[["chat", MessageSquare], ["voice", Phone]].map(([id, Icon]: any) => (
            <button key={id} type="button" role="radio" aria-checked={channel === id} onClick={() => setChannel(id)}
              className={cx("flex items-center gap-1 px-2.5 text-[12px] cursor-pointer", channel === id ? "bg-accent/15 text-accent" : "text-muted hover:text-fg")}>
              <Icon size={13} /> {id}
            </button>
          ))}
        </div>
        <input aria-label="Customer message" value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Type what the customer says. Nirnaya routes it to the right desk…"
          className="h-8 min-w-[220px] flex-1 rounded-md border border-line-strong bg-panel-2 px-3 text-[13px] outline-none focus:border-accent" />
        <Button variant="primary" type="submit" disabled={busy || !text.trim()}><Send size={14} /> Send</Button>
      </form>
      {!compact && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Sparkles size={12} className="text-gold" />
          {app.presets.map((p) => (
            <button key={p.id} onClick={() => { setCustomer(p.customer); void send(p.customer, p.text); }}
              title={p.text}
              className="h-6 cursor-pointer rounded-full border border-line-strong px-2.5 text-[11.5px] text-muted hover:border-accent hover:text-fg">
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Feed() {
  const cases = useUI((s) => s.app?.cases ?? EMPTY);
  if (!cases.length) return <Empty title="No cases yet">Send a message above, or pick a preset, and watch it move through the office.</Empty>;
  return (
    <ul className="divide-y divide-line">
      {cases.slice(0, 60).map((c) => (
        <li key={c.id}>
          <button onClick={() => openCase(c.id)} className="slide-in w-full cursor-pointer px-3 py-2.5 text-left hover:bg-panel-2">
            <div className="flex items-center gap-2">
              <StatusDot status={c.status} />
              <span className="font-mono text-[11.5px] text-muted">{c.id}</span>
              <span className="truncate text-[12.5px] font-medium">{c.customer_name}</span>
              <span className="ml-auto"><RouteBadge route={c.route} /></span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11.5px] text-muted">
              <span>{c.intent ? INTENT_LABEL[c.intent] ?? c.intent : c.step}</span>
              {c.amount ? <span className="tabular">· {inr(c.amount)}</span> : null}
              {c.pending && <Badge tone="bad">needs approval</Badge>}
              {c.seal_broken && <Badge tone="warn">seal broken</Badge>}
              <span className="ml-auto text-faint">{ago(c.created_at)}</span>
            </div>
            <div className="mt-1 line-clamp-2 text-[12px] text-faint">{c.preview}</div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function AgentPanel({ id }: { id: string }) {
  const agent = useUI((s) => s.app?.agents.find((a) => a.id === id));
  const dept = useUI((s) => s.app?.departments.find((d) => d.id === agent?.department));
  const [q, setQ] = useState("");
  const [chat, setChat] = useState<{ q: string; a: string }[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => setChat([]), [id]);
  if (!agent) return null;
  const ask = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await api.ask(id, q);
      setChat((c) => [...c, { q, a: r.answer }]);
      setQ("");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-3 border-b border-line p-3.5">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-panel-2 text-xl">{agent.emoji}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-[14px] font-semibold">{agent.name}</div>
            <StatusDot status={agent.status} />
            <span className="text-[11.5px] text-muted">{agent.status}</span>
          </div>
          <div className="text-[11.5px] text-muted">{dept?.name}</div>
        </div>
        <Button variant="ghost" size="sm" aria-label="Close" onClick={() => setState({ selectedAgent: null })}><X size={14} /></Button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3.5">
        <p className="text-[12.5px] leading-relaxed">{agent.description}</p>
        <p className="text-[12px] italic text-gold">“{agent.vibe}”</p>
        {agent.doing && (
          <div className="rounded-md border border-accent/30 bg-accent/10 px-2.5 py-2 text-[12px]">
            Now: <button className="font-mono underline cursor-pointer" onClick={() => agent.case_id && openCase(agent.case_id)}>{agent.case_id}</button> · {agent.doing}
          </div>
        )}
        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">Recent work · {agent.handled} step(s)</div>
          {agent.log.length ? (
            <ul className="space-y-1">
              {agent.log.slice(-8).reverse().map((l, i) => (
                <li key={i} className="flex gap-2 text-[12px]">
                  <button className="font-mono text-muted underline-offset-2 hover:underline cursor-pointer" onClick={() => openCase(l.case_id)}>{l.case_id}</button>
                  <span className="text-muted">{l.doing}</span>
                  <span className="ml-auto text-faint">{ago(l.ts)}</span>
                </li>
              ))}
            </ul>
          ) : <div className="text-[12px] text-faint">Nothing on this desk yet.</div>}
        </div>
        {chat.map((m, i) => (
          <div key={i} className="space-y-1">
            <div className="ml-8 rounded-lg bg-accent/15 px-2.5 py-1.5 text-[12.5px]">{m.q}</div>
            <div className="mr-8 rounded-lg bg-panel-2 px-2.5 py-1.5 text-[12.5px]">{m.a}</div>
          </div>
        ))}
      </div>
      <form className="flex gap-2 border-t border-line p-2.5" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
        <input aria-label={`Ask ${agent.name}`} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Ask ${agent.name} about its work…`}
          className="h-8 flex-1 rounded-md border border-line-strong bg-panel-2 px-2.5 text-[12.5px] outline-none focus:border-accent" />
        <Button type="submit" disabled={busy || !q.trim()}>Ask</Button>
      </form>
    </div>
  );
}

export function OfficeView() {
  const ref = useRef<HTMLCanvasElement>(null);
  const eng = useRef<OfficeEngine | null>(null);
  const app = useUI((s) => s.app);
  const selected = useUI((s) => s.selectedAgent);
  const lastEvent = useRef(0);

  useEffect(() => {
    if (!ref.current) return;
    const e = new OfficeEngine(ref.current);
    eng.current = e;
    lastEvent.current = getState().events.at(-1)?.id ?? 0;
    const ro = new ResizeObserver(() => e.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      e.destroy();
    };
  }, []);

  useEffect(() => {
    const e = eng.current;
    if (!e || !app) return;
    e.setAgents(app.agents);
    e.setDrift(app.drift.alarm);
    e.selected = selected;
  }, [app, selected]);

  useEffect(() => {
    // stream new events into the animation
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const e = eng.current;
      const evs = getState().events;
      if (e) for (const ev of evs) if (ev.id > lastEvent.current) { e.onEvent(ev); lastEvent.current = ev.id; }
      requestAnimationFrame(tick);
    };
    tick();
    return () => { alive = false; };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TaskBar />
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-[#16181d]">
          <canvas
            ref={ref}
            className="pixelated h-full w-full cursor-default"
            aria-label="The Nirnaya office. Click an agent to see what it is doing."
            onMouseMove={(ev) => {
              const e = eng.current;
              if (!e) return;
              const id = e.agentAt(ev.clientX, ev.clientY);
              e.hover = id;
              (ev.target as HTMLCanvasElement).style.cursor = id || e.brainAt(ev.clientX, ev.clientY) ? "pointer" : "default";
            }}
            onMouseLeave={() => eng.current && (eng.current.hover = null)}
            onClick={(ev) => {
              const e = eng.current;
              if (!e) return;
              const id = e.agentAt(ev.clientX, ev.clientY);
              if (id === "human" && app?.stats.pending_approvals) setState({ view: "approvals" });
              else if (id) setState({ selectedAgent: id });
              else if (e.brainAt(ev.clientX, ev.clientY)) setState({ view: "brain" });
            }}
          />
          <div className="pointer-events-none absolute bottom-2 left-3 flex flex-wrap gap-3 text-[11px] text-white/70">
            <span>Click an agent to ask what it is doing</span>
            <span>· Click the brain for the context graph</span>
            {app?.stats.pending_approvals ? <span className="text-red-300">· The Human Desk has {app.stats.pending_approvals} approval(s) waiting</span> : null}
          </div>
        </div>
        <aside className="hidden w-[340px] shrink-0 flex-col border-l border-line bg-panel md:flex">
          {selected ? <AgentPanel id={selected} /> : (
            <>
              <div className="flex h-10 items-center justify-between border-b border-line px-3">
                <span className="text-[12.5px] font-semibold">Live feed</span>
                <span className="text-[11.5px] text-muted">{app?.stats.cases ?? 0} case(s)</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto"><Feed /></div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

export { Feed };
