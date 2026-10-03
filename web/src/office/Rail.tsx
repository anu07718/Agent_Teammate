// The rail on the left when a department is in focus: its card at the top, then one agent. CHAT holds
// what the agent delivered, anything waiting for your OK (the sealed packet, with APPROVE / REJECT),
// and a conversation grounded in what the agent actually did. ACTIVITY is its desk log.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { ACTION_LABEL, inr } from "../lib/format";
import { openCase, useUI } from "../store";
import { showFlow } from "../flows/api";
import { me } from "../team";
import type { Agent, CaseDetail } from "../types";
import { ago } from "../lib/format";
import { timeStr, span } from "./bits";
import { caseTitle, feed, getOffice, oapi, refreshOffice, say, setOffice, useOffice, type OTask } from "./data";
import { POD_STYLE, type PodId } from "./layout";

const details = new Map<string, CaseDetail>();
async function detail(id: string, stamp: number) {
  const k = `${id}@${stamp}`;
  if (!details.has(k)) details.set(k, await api.caseDetail(id));
  return details.get(k)!;
}

function caseText(d: CaseDetail) {
  const lines: string[] = [];
  lines.push(`${d.id} · ${caseTitle(d)}`);
  lines.push(`Customer said: “${d.text ?? ""}”`);
  if (d.understanding) lines.push(`Understood as ${d.understanding.intent} (${Math.round(d.understanding.confidence * 100)}%)`);
  if (d.txn) lines.push(`Matched ${d.txn.id} · ${inr(d.txn.amount)} to ${d.txn.merchant} · UTR ${d.txn.utr}`);
  for (const x of d.decisions || []) {
    lines.push(`${ACTION_LABEL[x.action.type] ?? x.action.type}${x.action.amount ? " " + inr(x.action.amount) : ""} → ${x.route}${x.committed ? " · committed" : ""}${x.approved_by ? ` · approved by ${x.approved_by}` : ""}`);
    if (x.why) lines.push(`   ${x.why}`);
  }
  const reply = [...(d.conversation || [])].reverse().find((m) => m.role === "nirnaya");
  if (reply) lines.push("", "Reply sent:", reply.text);
  if (d.guard) lines.push("", `Promise Guard: ${d.guard.ok ? "clean" : d.guard.violations.map((v) => v.detail).join("; ")} (${d.guard.claims_checked} claim(s) checked)`);
  return lines.join("\n");
}

function FileCard({ name, meta, load, icon = "📄" }: { name: string; meta: string; load: () => Promise<string>; icon?: string }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  return (
    <div className={`o-file${open ? " exp" : ""}`} onClick={async () => {
      setOpen(!open);
      if (body === null) setBody(await load().catch((e) => `Could not load: ${e.message}`));
    }}>
      <div className="fh"><span>{icon}</span><div><div className="fn">{name}</div><div className="fm">{meta}</div></div></div>
      <pre>{body ?? "…"}</pre>
    </div>
  );
}

function CaseApproval({ t, onReject }: { t: OTask; onReject: () => void }) {
  const [d, setD] = useState<CaseDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void detail(t.id, t.changedAt).then(setD).catch((e) => setErr(e.message)); }, [t.id, t.changedAt]);
  const pend = d?.pending;
  const acts = (pend?.actions ?? []) as { type: string; amount: number }[];
  const score = (type: string) => d?.scores?.find((s) => s.action === type);
  return (
    <div className="o-appr" data-case={t.id}>
      <div className="who o-caps">needs your approval</div>
      <div className="ask">
        {acts.length ? `Approve ${acts.map((a) => `${ACTION_LABEL[a.type] ?? a.type}${a.amount ? " " + inr(a.amount) : ""}`).join(" and ")} for ${t.c?.customer_name ?? "the customer"}?` : `“${t.title}” is waiting for you.`}
      </div>
      {pend && (
        <div className="o-mock">
          <div className="brand">SEALED EVIDENCE PACKET · {t.id}</div>
          <div className="title">{t.title}</div>
          {acts.map((a) => {
            const s = score(a.type);
            return <div className="ln" key={a.type}><span>{ACTION_LABEL[a.type] ?? a.type}</span><b>{a.amount ? inr(a.amount) : "—"}{s ? ` · score ${s.calibrated.toFixed(2)} vs ${s.threshold.act.lambda == null ? "none certified" : s.threshold.act.lambda.toFixed(2)}` : ""}</b></div>;
          })}
          {pend.seal && <div className="ln"><span>Seal</span><b style={{ fontFamily: "var(--o-mono)" }}>{String(pend.seal).slice(0, 14)}…</b></div>}
          {pend.ledger_version && <div className="ln"><span>Ledger</span><b>version {pend.ledger_version}</b></div>}
          {(pend.shadow?.diff ?? []).slice(0, 3).map((x: any) => <div className="ln" key={x.field}><span>{x.field}</span><b>{String(x.before)} → {String(x.after)}</b></div>)}
          <div className="p">Approve and the gateway checks this seal against the live ledger first. If the ground has moved, the old approval does not apply.</div>
        </div>
      )}
      {err && <div className="done">{err}</div>}
      <div className="btns">
        <button className="yes" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            await api.approve(t.id); // the team sees who approved it in this chat (the server writes the note)
          } catch (e) { say(t.agent, { who: "agent", text: `That didn't go through: ${(e as Error).message}` }); }
          setBusy(false);
        }}>APPROVE</button>
        <button onClick={onReject}>REJECT</button>
        <button onClick={() => openCase(t.id)} title="open the case in the workspace">OPEN ↗</button>
      </div>
    </div>
  );
}

function OpApproval({ t, onReject }: { t: OTask; onReject: () => void }) {
  return (
    <div className="o-appr" data-op={t.id}>
      <div className="who o-caps">needs your approval</div>
      <div className="ask">{t.op?.ask ?? `“${t.title}” is ready. Run it?`}</div>
      <div className="btns">
        <button className="yes" onClick={async () => {
          try { await oapi.approveOp(t.id); } catch (e) { say(t.agent, { who: "agent", text: `That didn't go through: ${(e as Error).message}` }); }
          void refreshOffice();
        }}>APPROVE</button>
        <button onClick={onReject}>REJECT</button>
      </div>
    </div>
  );
}

function FlowApproval({ t, onReject }: { t: OTask; onReject: () => void }) {
  const w = t.flow!;
  return (
    <div className="o-appr" data-flow={t.id}>
      <div className="who o-caps">a flow asks you · {w.flow}</div>
      <div className="ask">{w.question}</div>
      <div className="btns">
        <button className="yes" onClick={async () => {
          try { await oapi.decideFlow(w.run_id, w.node, true); } catch (e) { say(t.agent, { who: "agent", text: `That didn't go through: ${(e as Error).message}` }); }
          void refreshOffice();
        }}>YES</button>
        <button onClick={onReject}>NO</button>
        <button onClick={() => showFlow(w.flow_id)} title="open the flow">FLOW ↗</button>
      </div>
    </div>
  );
}

interface Props {
  pod: PodId;
  agentId: string;
  setAgent: (id: string) => void;
  tasks: OTask[];
  card: React.ReactNode;
  lead: string;
  open: boolean;
}

export function Rail({ pod, agentId, setAgent, tasks, card, lead, open }: Props) {
  const agent = useUI((s) => s.app?.agents.find((a) => a.id === agentId)) as Agent | undefined;
  const cases = useUI((s) => s.app?.cases);
  const chat = useOffice((s) => s.chats[agentId]);
  const feeds = useOffice((s) => s.feeds[agentId]);
  const [tab, setTab] = useState<"chat" | "activity">("chat");
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const mine = useMemo(() => tasks.filter((t) => t.agent === agentId), [tasks, agentId]);

  const items = useMemo(() => {
    if (!agent) return [];
    const out: { ts: number; key: string; node: React.ReactNode }[] = [];
    const deptName = POD_STYLE[pod].name.toLowerCase();
    out.push({ ts: 0, key: "hello", node: <div className="o-m-agent">{`${agent.description} ${agent.lead ? `Give ${deptName} a task in the bar on the right, or ask me here.` : "Ask me what I'm working on, or which systems I use."}`}</div> });
    out.push({ ts: 1, key: "attached", node: <div className="o-m-work"><span className="i">⏺</span>desk attached — live work stream below</div> });
    for (const t of mine.slice(0, 12)) {
      const reject = () => {
        setOffice((s) => ({ rejecting: { ...s.rejecting, [agentId]: { kind: t.kind, id: t.id } } }));
        say(agentId, { who: "agent", text: "Understood. What should change? Tell me here: the note goes on the trail and teaches the calibrator." });
      };
      if (t.state === "waiting") {
        out.push({ ts: t.changedAt, key: "a" + t.id, node: t.kind === "case" ? <CaseApproval t={t} onReject={reject} /> : t.kind === "flow" ? <FlowApproval t={t} onReject={reject} /> : <OpApproval t={t} onReject={reject} /> });
      } else if (t.state === "done") {
        const meta = t.kind === "case"
          ? `${t.route === "REFUSE" ? "refused" : t.route === "ACT" || t.route === "HEDGE" ? "resolved alone" : "resolved after your OK"} · ${timeStr(t.doneAt ?? t.changedAt)} · click to view`
          : `${t.ok === false ? "flagged" : "done"}${t.approved ? " after your OK" : ""} · ${timeStr(t.doneAt ?? t.changedAt)} · click to view`;
        out.push({
          ts: t.doneAt ?? t.changedAt, key: "f" + t.id,
          node: <FileCard name={`${t.id}.md`} meta={meta} icon={t.ok === false || t.route === "REFUSE" ? "⚠" : "📄"}
            load={async () => t.kind === "case" ? caseText(await detail(t.id, t.changedAt)) : `${t.title}\n\n${t.op?.result ?? ""}`} />,
        });
      } else if (t.state === "doing") {
        out.push({ ts: t.changedAt, key: "d" + t.id, node: <div className="o-m-work"><span className="i">▸</span>{t.id} · {t.title} · {t.kind === "case" ? t.c?.step : "working"}</div> });
      }
    }
    const myName = me().name;
    for (const [i, m] of (chat ?? []).entries()) {
      const theirs = m.who === "user" && m.by && m.by !== myName;
      out.push({
        ts: m.ts, key: "c" + (m.id ?? `l${i}`),
        node: m.who === "user" ? <div className={`o-m-user${theirs ? " theirs" : ""}`}>{theirs && <span className="by o-caps">{m.by}</span>}{m.text}</div>
          : m.who === "agent" ? <div className="o-m-agent">{m.by && <span className="by o-caps">{m.by}</span>}{m.text}{m.via && <span className="o-via" title="Written by this free model">via {m.via}</span>}</div>
          : <div className="o-m-work"><span className="i">{m.icon ?? "▸"}</span>{m.text}</div>,
      });
    }
    return out.sort((a, b) => a.ts - b.ts).slice(-60);
  }, [agent, mine, chat, pod, agentId]);

  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [items.length, tab, agentId]);

  const send = async (text: string) => {
    text = text.trim();
    if (!text) return;
    setInput("");
    const rej = getOffice().rejecting[agentId];
    if (rej) {
      setOffice((s) => { const r = { ...s.rejecting }; delete r[agentId]; return { rejecting: r }; });
      try { // the note, and who wrote it, reach the whole team through the server's chat note
        if (rej.kind === "case") await api.reject(rej.id, text);
        else if (rej.kind === "flow") { const [run, node] = rej.id.split(":"); await oapi.decideFlow(run, node, false, text); }
        else await oapi.rejectOp(rej.id, text);
      } catch (e) { say(agentId, { who: "agent", text: `That didn't go through: ${(e as Error).message}` }); }
      void refreshOffice();
      return;
    }
    setThinking(true);
    try {
      const r = await oapi.chat(agentId, text); // the question and the answer come back to everyone as chat messages
      if (r.moved) feed("recheck", "🌊", `${r.moved.txn_id} moved to version ${r.moved.version}`);
      if (r.routine) void refreshOffice();
    } catch (e) {
      say(agentId, { who: "agent", text: `I couldn't answer that (${(e as Error).message}).` });
    }
    setThinking(false);
  };

  if (!agent) return <div className={`o-rail${open ? " open" : ""}`}>{card}</div>;
  const waitingHere = mine.some((t) => t.state === "waiting" && t.kind === "case");
  const chips = ["What are you working on?", "What can you do?", "Which systems do you use?",
    ...(agentId === "human" ? ["What is waiting on me?"] : []), ...(waitingHere ? ["move the ground"] : [])];
  const week = [...Array(7)].map((_, i) => {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (6 - i));
    const start = d.getTime(), end = start + 86400000;
    const n = agent.systems && mine.length ? mine.filter((t) => t.addedAt >= start && t.addedAt < end).length
      : (cases ?? []).filter((c) => c.created_at * 1000 >= start && c.created_at * 1000 < end).length;
    return { n, label: d.toLocaleDateString([], { weekday: "narrow" }) };
  });
  const max = Math.max(1, ...week.map((w) => w.n));
  return (
    <div className={`o-rail${open ? " open" : ""}`} data-testid="rail">
      {card}
      <div className="o-agent">
        <div className="ah">
          <button className="back" aria-label="Back to the department lead" onClick={() => setAgent(lead)}>‹</button>
          <span className="o-dot" style={{ background: POD_STYLE[pod].chip }} />
          <h3>{agent.lead && <span className="star">★ </span>}{agent.name.toUpperCase()}</h3>
        </div>
        <div className="role o-caps">{agent.lead ? `${POD_STYLE[pod].name} lead` : agent.name} · {POD_STYLE[pod].name}</div>
        <div className="tag">{agent.vibe}</div>
        <div className="o-tabs">
          <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>CHAT</button>
          <button className={tab === "activity" ? "on" : ""} onClick={() => setTab("activity")}>ACTIVITY</button>
        </div>
        {tab === "chat" ? <>
          <div className="o-msgs" ref={box} data-testid="chat">
            {items.map((it) => <div key={it.key} style={{ display: "contents" }}>{it.node}</div>)}
            {thinking && <div className="o-m-work"><span className="i">…</span>{agent.name} is thinking</div>}
          </div>
          <div className="o-mchips">{chips.map((c) => <button key={c} onClick={() => void send(c)}>{c}</button>)}</div>
          <div className="o-minput">
            <input value={input} placeholder={getOffice().rejecting[agentId] ? "What should change?" : "Message this agent…"} aria-label="Message"
              onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") void send(input); }} />
            <button onClick={() => void send(input)}>SEND</button>
          </div>
        </> : (
          <div className="o-act">
            <div className="now o-caps">NOW &nbsp;<b>{agent.status === "working" ? `${agent.doing} · ${agent.case_id}` : mine.some((t) => t.state === "waiting") ? "waiting for your OK" : "nothing on the desk"}</b></div>
            <div className="o-stats">
              <div className="st"><div className="o-caps">Steps handled</div><div className="v">{agent.handled}</div></div>
              <div className="st"><div className="o-caps">Cards owned</div><div className="v">{mine.length}</div></div>
              <div className="st"><div className="o-caps">Waiting on you</div><div className="v">{mine.filter((t) => t.state === "waiting").length}</div></div>
              <div className="st"><div className="o-caps">Last active</div><div className="v" style={{ fontSize: 16 }}>{agent.since ? ago(agent.since) : "—"}</div></div>
            </div>
            <div className="o-chart">
              <div className="o-caps" style={{ color: "var(--o-grey)" }}>{mine.length ? "Cards this week" : "Office cases this week"}</div>
              <div className="bars">{week.map((w, i) => <i key={i} title={`${w.n}`} style={{ height: `${(w.n / max) * 100}%`, background: POD_STYLE[pod].chip }} />)}</div>
              <div className="days">{week.map((w, i) => <span key={i}>{w.label}</span>)}</div>
            </div>
            <div className="o-feed">
              {(feeds ?? []).map((f, i) => <div className="fe" key={i}><span>{f.icon}</span><span>{f.text}</span><span className="ft">{span(Date.now() - f.ts)}</span></div>)}
              {!feeds?.length && <div className="o-empty" style={{ fontSize: 14 }}>Nothing yet today. Work shows up here as it happens.</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
