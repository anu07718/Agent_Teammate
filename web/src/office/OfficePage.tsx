// The office page: the 3D office in the middle, the top bar with what it is connected to, a card over
// every department, the Task Status panel on the right, the rail on the left when a department is in
// focus, and the board, the Brain and the calendar a key away. Everything moves on live events.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiBase, setApiBase } from "../api";
import { Avatar, People } from "../components/People";
import { onEvents, setState, useUI, EMPTY } from "../store";
import { me, tellView, type Person } from "../team";
import type { NEvent } from "../types";
import { CONN_ICON } from "./bits";
import { deriveTasks, feed as addFeed, getOffice, heard, loadChats, oapi, refreshOffice, say, setOffice, softRefreshOffice, useOffice, type OTask } from "./data";
import { POD_IDS, POD_STYLE, STEP_ICON, type PodId } from "./layout";
import { BigEditor, Board, BrainOverlay, Calendar, useBrainData } from "./Overlays";
import { Panel } from "./Panel";
import { Rail } from "./Rail";
import { OfficeScene } from "./scene";
import { Wires } from "./wires";
import "./office.css";

const PANEL_W = 384 + 18;
const RAIL_W = 380 + 18;
const narrow = () => window.innerWidth <= 820;

function Clock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => { const h = setInterval(() => setT(new Date()), 1000); return () => clearInterval(h); }, []);
  return <span className="o-clock">{t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).toLowerCase()}</span>;
}

/** shown while the server is out of reach: the phone and desktop builds point at a server here */
function ServerConnect() {
  const [url, setUrl] = useState(() => apiBase() || "");
  const [open, setOpen] = useState(() => !!(window as any).Capacitor?.isNativePlatform?.());
  const save = () => {
    const u = url.trim().replace(/\/$/, "");
    setApiBase(u && !/^https?:\/\//.test(u) ? `http://${u}` : u);
    location.reload();
  };
  return (
    <div className="o-offline" data-testid="server-connect">
      Can't reach the Nirnaya server{apiBase() ? ` at ${apiBase()}` : ""}.
      {!open ? <button className="o-actbtn" style={{ marginLeft: 10 }} onClick={() => setOpen(true)}>SET SERVER</button> : (
        <div className="o-conn-form">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.20:8000" aria-label="Server address"
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") save(); }} />
          <button className="o-add" onClick={save}>CONNECT</button>
          <div className="o-conn-note">On the same Wi-Fi, start the server on your computer with <b>python -m nirnaya --host 0.0.0.0</b> and enter its address.</div>
        </div>
      )}
    </div>
  );
}

function DeptCard({ pod, tasks, kpis, agents, busy, cardRef, onClick, here = [] }: {
  pod: PodId; tasks: OTask[]; kpis: [string, string | number][]; agents: number; busy: boolean;
  cardRef?: (el: HTMLDivElement | null) => void; onClick?: () => void; here?: Person[];
}) {
  const s = POD_STYLE[pod];
  const mine = tasks.filter((t) => t.dept === pod);
  const n = (st: string) => mine.filter((t) => t.state === st).length;
  const waiting = n("waiting");
  return (
    <div className={`o-card${busy ? " sweep" : ""}`} style={{ ["--chip" as any]: s.chip }} ref={cardRef} onClick={onClick} data-pod={pod}>
      <div className="h"><span className="o-dot" style={{ background: s.chip }} /><span className="o-caps">{s.name}</span>
        {here.length > 0 && <span className="o-here" title={`${here.map((p) => p.name).join(", ")} ${here.length > 1 ? "are" : "is"} looking at ${s.name.toLowerCase()}`}>
          {here.slice(0, 3).map((p) => <Avatar key={p.client} p={p} size={18} />)}</span>}
        <span className="live" /></div>
      <div className="count"><b>{agents}</b><span className="o-caps" style={{ color: "var(--o-grey)" }}>AGENTS</span></div>
      <div className="rows">
        {kpis.map(([l, v]) => <div className="row" key={l}><span className="o-caps">{l}</span><b key={String(v)} className="o-flash">{v}</b></div>)}
      </div>
      <div className="tasks"><span>DOING<b>{n("doing")}</b></span><span>NEXT<b>{n("next") + n("scheduled")}</b></span><span>DONE<b>{n("done")}</b></span></div>
      {waiting > 0 && <div className="appr o-caps">⚠ {waiting} WAITING APPROVAL</div>}
    </div>
  );
}

/** what an event adds to an agent's ACTIVITY feed (live, and replayed from the server when the office opens,
 * so a teammate who arrives later sees the same history) */
function feedFrom(ev: NEvent, ownerOf: (cid: string) => string) {
  const feed = (agent: string, icon: string, text: string) => addFeed(agent, icon, text, ev.ts * 1000);
  switch (ev.kind) {
    case "superstep": {
      const ids: string[] = ev.agents || [];
      if (ev.phase === "start") for (const id of ids) feed(id, STEP_ICON[ev.step] ?? "▸", `${ev.case_id}: ${ev.step}`);
      else if (ev.note) for (const id of ids) feed(id, "✓", `${ev.case_id} · ${ev.step}: ${ev.note}`);
      break;
    }
    case "decision.routed": feed("router", "🔀", `${ev.case_id} → ${ev.route}`); break;
    case "approval.requested":
      feed(ownerOf(ev.case_id), "⏸", `Waiting for an OK: ${ev.case_id}`);
      feed("seal", "🔏", `Sealed ${ev.case_id} · ${ev.seal}…`);
      break;
    case "approval.granted": feed(ownerOf(ev.case_id), "✅", `${ev.case_id} approved${ev.by ? ` by ${ev.by}` : ""}${ev.edited ? " with an edit" : ""}`); break;
    case "approval.rejected": feed(ownerOf(ev.case_id), "❌", `${ev.case_id} rejected${ev.by ? ` by ${ev.by}` : ""}`); break;
    case "seal.rejected_approval": feed("seal", "🔓", `${ev.case_id}: the ledger moved, so the old approval does not apply`); break;
    case "op.updated": {
      const op = ev.op;
      if (op.state === "doing") feed(op.agent, "📋", op.title + (op.by && !["you", "routine"].includes(op.by) ? ` · for ${op.by}` : ""));
      if (op.state === "waiting") feed(op.agent, "⏸", `Waiting for an OK: ${op.title}`);
      if (op.state === "done") feed(op.agent, op.ok === false ? "⚠" : "✓", `${op.title}: ${(op.result || "").split("\n")[0]}`);
      break;
    }
    case "drift.alarm": if (ev.status?.alarm) feed("drift", "⚠", ev.status.reason); break;
    case "rail.event": feed("recheck", "🌊", `${ev.txn_id}: ${String(ev.event).replace("_", " ")} (version ${ev.version})`); break;
    case "brain.read": if ((ev.nodes || []).length) feed(ev.agent, "🧠", `read ${(ev.nodes || []).length} node(s) in the Brain`); break;
    case "chat.message": {
      const m = ev.message;
      if (m.who === "user" && m.by) feed(m.agent, "💬", `${m.by} asked: ${m.text.slice(0, 80)}`);
      break;
    }
    case "flow.run":
      if (ev.run.state === "done" || ev.run.state === "failed") feed("human", ev.run.state === "done" ? "✓" : "⚠", `Flow “${ev.run.name}” ${ev.run.state}`);
      break;
  }
}

export function OfficePage() {
  const app = useUI((s) => s.app);
  const agents = useUI((s) => s.app?.agents ?? EMPTY);
  const connected = useUI((s) => s.connected);
  const people = useUI((s) => s.people ?? EMPTY) as Person[];
  const snap = useOffice((s) => s.snap);
  const [dept, setDept] = useState<PodId>("intake");
  const [text, setText] = useState("");
  const [focused, setFocused] = useState<PodId | "brain" | null>(null);
  const [agentOpen, setAgentOpen] = useState<string | null>(null);
  const [board, setBoard] = useState(false);
  const [brainOpen, setBrainOpen] = useState(false);
  const [cal, setCal] = useState(false);
  const [big, setBig] = useState(false);
  const [brainV, setBrainV] = useState(0);
  const [dark, setDark] = useState(() => { try { return localStorage.getItem("nirnaya.office.dark") === "1"; } catch { return false; } });
  const [hot, setHot] = useState<Record<string, number>>({});
  const hostRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const wiresRef = useRef<Wires | null>(null);
  const submitRef = useRef<(() => void) | null>(null);
  const appRef = useRef(app);
  appRef.current = app;
  const lastStep = useRef<Record<string, string>>({});
  const binds = useRef(new Map<string, HTMLElement>());
  const bindFns = useRef(new Map<string, (el: HTMLElement | null) => void>());

  const podOf = useCallback((id: string) => ((appRef.current?.agents.find((a) => a.id === id)?.department ?? "intake") as PodId), []);
  const nameOf = useCallback((id: string) => (appRef.current?.agents.find((a) => a.id === id)?.name ?? id).toUpperCase(), []);
  const leadOf = useCallback((pod: PodId) => getOffice().snap?.pods.find((p) => p.id === pod)?.lead
    ?? appRef.current?.agents.find((a) => a.department === pod && a.lead)?.id ?? "triage", []);
  const tasks = useMemo(() => deriveTasks(app, snap, podOf), [app, snap, podOf]);

  const bind = (key: string) => {
    let f = bindFns.current.get(key);
    if (!f) {
      f = (el) => {
        if (el) binds.current.set(key, el); else binds.current.delete(key);
        sceneRef.current?.bind(key, el);
      };
      bindFns.current.set(key, f);
    }
    return f;
  };

  const overview = useCallback(() => {
    setFocused(null);
    setAgentOpen(null);
    sceneRef.current?.overview();
    if (wiresRef.current) wiresRef.current.focused = null;
  }, []);
  const focusPod = useCallback((pod: PodId, agent?: string) => {
    setFocused(pod);
    setAgentOpen(agent ?? leadOf(pod));
    setDept(pod);
    sceneRef.current?.focus(pod);
    if (wiresRef.current) wiresRef.current.focused = pod;
  }, [leadOf]);
  const openAgent = useCallback((id: string) => focusPod(podOf(id), id), [focusPod, podOf]);
  const zoomToTask = useCallback((t: OTask) => focusPod(t.dept, t.agent), [focusPod]);

  // the scene lives as long as the page
  useEffect(() => {
    const s = new OfficeScene(hostRef.current!, hudRef.current!, {
      panelWidth: () => (narrow() ? 0 : PANEL_W),
      railWidth: () => (narrow() ? 0 : RAIL_W),
      onAgent: (id) => openAgentRef.current(id),
      onPod: (id) => focusPodRef.current(id),
      onBrain: () => setBrainOpen(true),
      onEmpty: () => overviewRef.current(),
      onFrame: (sc, now) => wiresRef.current?.update(sc, now),
    });
    sceneRef.current = s;
    wiresRef.current = new Wires(svgRef.current!);
    for (const [k, el] of binds.current) s.bind(k, el);
    void refreshOffice();
    const h = setInterval(() => void refreshOffice(), 15_000);
    return () => { clearInterval(h); s.dispose(); sceneRef.current = null; };
  }, []);
  const openAgentRef = useRef(openAgent); openAgentRef.current = openAgent;
  const focusPodRef = useRef(focusPod); focusPodRef.current = focusPod;
  const overviewRef = useRef(overview); overviewRef.current = overview;

  useEffect(() => {
    sceneRef.current?.setAgents(agents.map((a) => ({ id: a.id, name: a.name, pod: a.department as PodId, lead: !!a.lead })));
  }, [agents]);
  useEffect(() => {
    sceneRef.current?.setDark(dark);
    try { localStorage.setItem("nirnaya.office.dark", dark ? "1" : "0"); } catch { /* storage off */ }
  }, [dark]);
  useEffect(() => { if (snap) wiresRef.current?.setConnectors(snap.connectors); }, [snap]);

  // who is typing, who is standing and waving for your OK
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const waiting = new Set(tasks.filter((t) => t.state === "waiting").map((t) => t.agent));
    for (const a of agents) s.setMode(a.id, waiting.has(a.id) ? "waiting" : a.status === "working" ? "working" : "idle");
  }, [agents, tasks]);

  // the Brain: the same graph on the pod's board and in the full view
  const brain = useBrainData(brainOpen, brainV);
  const labels = useMemo(() => new Map((brain?.nodes ?? []).map((n) => [n.id, n.label])), [brain]);
  useEffect(() => {
    if (!brain || !sceneRef.current) return;
    const keep = new Set([...brain.nodes.map((n, i) => ({ i, d: n.d })).sort((a, b) => b.d - a.d).slice(0, 110).map((x) => x.i)]);
    const map = new Map<number, number>();
    const nodes = brain.nodes.filter((_, i) => keep.has(i)).map((n, j) => { map.set(brain.nodes.indexOf(n), j); return { id: n.id, x: n.x, y: n.y, d: n.d }; });
    const links = brain.links.filter(([a, b]) => keep.has(a) && keep.has(b)).map(([a, b]) => [map.get(a)!, map.get(b)!] as [number, number]);
    sceneRef.current.setBrain(nodes, links);
  }, [brain]);

  // live events → the office moves (and the ACTIVITY feeds grow)
  useEffect(() => onEvents((ev: NEvent) => {
    const ownerOf = (cid: string) => (appRef.current?.cases.find((c) => c.id === cid)?.owner) || "triage";
    feedFrom(ev, ownerOf);
    const s = sceneRef.current;
    if (!s) return;
    const keyOf = (system: string) => getOffice().snap?.connectors.find((c) => c.name === system)?.key;
    switch (ev.kind) {
      case "superstep": {
        const ids: string[] = ev.agents || [];
        if (ev.phase === "start") {
          for (const id of ids) {
            const icon = STEP_ICON[ev.step] ?? "▸";
            s.pushLine(id, `▸ ${ev.case_id} ${ev.step}`);
            s.emote(id, icon);
            const prev = lastStep.current[ev.case_id];
            if (prev && prev !== id) s.ticket(prev, id, POD_STYLE[podOf(id)].chip);
            lastStep.current[ev.case_id] = id;
          }
        } else if (ev.note) {
          for (const id of ids) {
            s.pushLine(id, `✓ ${ev.note}`);
            if (getOffice().chats[id]) say(id, { who: "work", icon: "✓", text: `${ev.case_id} · ${ev.step}: ${ev.note}` });
          }
        }
        break;
      }
      case "tool.called": {
        const key = keyOf(ev.system);
        if (key) {
          setHot((h) => ({ ...h, [key]: Date.now() }));
          wiresRef.current?.pulse(key, podOf(ev.agent));
        }
        break;
      }
      case "decision.routed":
        s.emote("router", ({ ACT: "✅", HEDGE: "↩️", ESCALATE: "⚠️", REFUSE: "⛔" } as Record<string, string>)[ev.route] ?? "🔀");
        break;
      case "approval.requested":
        s.emote("seal", "🔏");
        break;
      case "approval.granted": {
        const o = ownerOf(ev.case_id);
        s.cheer(o);
        s.emote(o, "✅");
        softRefreshOffice(600);
        break;
      }
      case "approval.rejected": {
        const o = ownerOf(ev.case_id);
        s.slump(o);
        s.emote(o, "❌");
        softRefreshOffice(600);
        break;
      }
      case "seal.rejected_approval":
        s.emote("seal", "🔓");
        break;
      case "case.finished": {
        const c = ev.case;
        if (c.status !== "parked") s.emote(c.owner || "triage", c.route === "REFUSE" ? "⛔" : "✓");
        delete lastStep.current[c.id];
        setBrainV((v) => v + 1);
        softRefreshOffice(600);
        break;
      }
      case "brain.read": {
        s.brainRead(ev.agent, ev.nodes || [], (id) => labels.get(id) ?? id.split(":").pop()!);
        const reads = { ...getOffice().reads };
        for (const n of ev.nodes || []) reads[n] = { agent: nameOf(ev.agent), ts: Date.now() };
        setOffice({ reads });
        break;
      }
      case "op.updated": {
        const op = ev.op;
        softRefreshOffice(200);
        if (op.state === "doing") { s.emote(op.agent, "📋"); s.pushLine(op.agent, `▸ ${op.title}`); }
        if (op.state === "waiting") s.emote(op.agent, "⏸");
        if (op.state === "done") {
          s.emote(op.agent, op.ok === false ? "⚠️" : "✓");
          s.pushLine(op.agent, `✓ ${op.title}`);
          if (op.kind === "benchmark" || op.kind === "recalibrate") setBrainV((v) => v + 1);
        }
        break;
      }
      case "chat.message": {
        const m = ev.message;
        heard(m);
        if (m.who !== "user") { s.emote(m.agent, m.icon === "📣" ? "📣" : "💬"); s.pushLine(m.agent, `💬 ${m.text.slice(0, 60)}`); }
        break;
      }
      case "flow.run":
        softRefreshOffice(300);
        break;
      case "op.removed": case "routine.ran": case "routine.changed":
        softRefreshOffice(200);
        break;
      case "drift.alarm":
        if (ev.status?.alarm) s.emote("drift", "⚠️");
        softRefreshOffice(400);
        break;
      case "rail.event":
        s.emote("recheck", "🌊");
        break;
      case "rail.outage": case "rail.reset":
        softRefreshOffice(200);
        break;
    }
  }), [podOf, nameOf, labels]);

  // the shared chat, and what happened before this page opened (so a teammate arriving later sees it too)
  const replayed = useRef(false);
  useEffect(() => {
    if (!app || replayed.current) return;
    replayed.current = true;
    void loadChats();
    void oapi.recent(1200).then((evs) => {
      const ownerOf = (cid: string) => (appRef.current?.cases.find((c) => c.id === cid)?.owner) || "triage";
      setOffice({ feeds: {} });
      for (const ev of evs) feedFrom(ev, ownerOf);
    }).catch(() => {});
  }, [app, nameOf]);

  // tell the team where you are
  useEffect(() => { tellView("office", focused && focused !== "brain" ? POD_STYLE[focused].name : focused === "brain" ? "the Brain" : null); }, [focused]);

  // keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.key === "Escape") {
        if (big) setBig(false);
        else if (cal) setCal(false);
        else if (brainOpen) setBrainOpen(false);
        else if (board) setBoard(false);
        else overview();
        return;
      }
      if (k === "p") { setCal((c) => !c); return; }
      if (cal) return; // the calendar has its own keys
      if (k === "g") setBrainOpen((b) => !b);
      else if (k === "b") setBoard((b) => !b);
      else if (k === "d") setDark((d) => !d);
      else if (k === "w") setState({ view: "workspace" });
      else if (k === "f") setState({ view: "flows" });
      else if (k === "m") setState({ view: "channels" });
      else if (k === "c" && focused && focused !== "brain") setAgentOpen(leadOf(focused));
      else if (k >= "1" && k <= "6") focusPod(POD_IDS[Number(k) - 1]);
      else if (k === "+" || k === "=") sceneRef.current?.zoomBy(1.4);
      else if (k === "-" || k === "_") sceneRef.current?.zoomBy(1 / 1.4);
      else if (k === "0") overview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [big, cal, brainOpen, board, focused, focusPod, overview, leadOf]);

  const stats = app?.stats;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const casesToday = (app?.cases ?? []).filter((c) => c.created_at * 1000 >= today.getTime()).length;
  const waitingAll = tasks.filter((t) => t.state === "waiting");
  const count = (pod: PodId) => agents.filter((a) => a.department === pod).length;
  const busy = (pod: PodId) => agents.some((a) => a.department === pod && a.status === "working");
  const pod = focused && focused !== "brain" ? focused : null;
  const watching = (p: PodId) => people.filter((x) => x.client !== me().client && x.view === "office" && x.focus === POD_STYLE[p].name);
  const nodeCount = snap?.kpis.brain?.[0]?.[1] ?? brain?.nodes.length ?? 0;

  return (
    <div className={`o-root${dark ? " o-dark" : ""}`} data-testid="office">
      <div ref={hostRef} className="o-host" style={{ position: "absolute", inset: 0 }} />
      <div ref={hudRef} className="o-hud">
        <svg ref={svgRef} className="o-wires" />
        {agents.map((a) => {
          const w = waitingAll.some((t) => t.agent === a.id);
          return (
            <div key={a.id} ref={bind(`agent:${a.id}`)} className={`o-pill${a.status === "working" ? " working" : ""}`} onClick={() => openAgent(a.id)} data-agent={a.id}>
              {a.lead && <span className="star">★</span>}{a.name.toUpperCase()}{w && <span className="w">⚠</span>}
            </div>
          );
        })}
        <div ref={bind("brain")} className="o-braintag" onClick={() => setBrainOpen(true)} title="open the Brain (G)">
          <span className="o-dot" style={{ background: POD_STYLE.brain.chip }} /><span className="o-caps">THE BRAIN</span><b>{nodeCount}</b><span className="o-caps">NODES</span>
        </div>
        {POD_IDS.map((p) => (
          <DeptCard key={p} pod={p} tasks={tasks} kpis={snap?.kpis[p] ?? []} agents={count(p)} busy={busy(p)}
            cardRef={bind(`pod:${p}`)} onClick={() => focusPod(p)} here={watching(p)} />
        ))}
      </div>

      <div className="o-top">
        <span className="o-brand">NIRNAYA<small>OFFICE</small></span>
        <div className="o-conn" aria-label="Connected systems">
          <span className="o-lab o-caps"><span className="o-dot" />CONNECTED TO</span>
          {(snap?.connectors ?? []).map((c) => {
            const I = CONN_ICON[c.key]?.icon;
            const recent = hot[c.key] && Date.now() - hot[c.key] < 1200;
            return (
              <span key={c.key + (hot[c.key] ?? 0)} data-conn={c.key} className={`o-tile${c.status !== "connected" ? " off" : ""}${recent ? " hot" : ""}`}
                title={`${c.name} · ${c.status === "connected" ? `connected · ${c.calls} call(s)` : c.status === "down" ? "down (simulated outage)" : "circuit open after 3 failures"}`}>
                {I && <I color={CONN_ICON[c.key].color} strokeWidth={2.2} />}
              </span>
            );
          })}
        </div>
        <span className="o-sp" />
        <span className="o-lab o-caps o-runs"><span className="o-dot" style={{ background: snap?.llm.enabled ? "var(--o-green)" : "var(--o-faint)" }} />REASONS WITH</span>
        <span className="o-tile o-runs" title={snap?.llm.enabled ? "Claude refines understanding and drafts replies" : "Rules only: set ANTHROPIC_API_KEY to add Claude"} style={{ opacity: snap?.llm.enabled ? 1 : 0.45 }}>
          <CONN_ICON.claude.icon color={CONN_ICON.claude.color} strokeWidth={2.2} />
        </span>
        <span className="o-gauge o-caps" title="today's cases, how many Nirnaya finished on its own, and the cost per case">
          TODAY<b>{casesToday}</b>{casesToday === 1 ? "CASE" : "CASES"}<span className="sep">·</span><b>{stats ? Math.round(stats.autonomy * 100) : 0}%</b>ALONE
          {stats?.cost_per_case != null && <><span className="sep">·</span><b>₹{stats.cost_per_case.toFixed(1)}</b>PER CASE</>}
        </span>
        <button className="o-btn o-caps" onClick={() => setCal(true)} title="the calendar (P)" aria-label="Calendar">◷ <span className="lbl">CALENDAR</span></button>
        <button className="o-btn o-caps" onClick={() => setState({ view: "flows" })} title="how the agents are working, and flows you draw (F)" aria-label="Flows">⌥ <span className="lbl">FLOWS</span></button>
        <button className="o-btn o-caps" onClick={() => setState({ view: "workspace" })} title="cases, approvals, supervisor, ledger (W)" aria-label="Workspace">▦ <span className="lbl">WORKSPACE</span></button>
        {waitingAll.length > 0 && (
          <button className="o-btn amber o-caps" onClick={() => zoomToTask(waitingAll[0])} title="go to the first thing waiting for you">⚠ {waitingAll.length}</button>
        )}
        <People className="o-people" size={26} max={4} />
        <Clock />
      </div>

      {!connected && <ServerConnect />}
      {focused && <button className="o-overview" style={{ left: pod && !narrow() ? RAIL_W + 24 : 24 }} onClick={overview}>◂ OVERVIEW</button>}

      <Rail pod={pod ?? "intake"} agentId={agentOpen ?? ""} setAgent={setAgentOpen} tasks={tasks} lead={pod ? leadOf(pod) : "triage"} open={!!pod && !!agentOpen}
        card={pod ? <DeptCard pod={pod} tasks={tasks} kpis={snap?.kpis[pod] ?? []} agents={count(pod)} busy={busy(pod)} /> : null} />

      <Panel app={app} snap={snap} tasks={tasks} connected={connected} dept={dept} setDept={setDept} text={text} setText={setText}
        focused={focused} nameOf={nameOf} podOf={podOf} openBig={() => setBig(true)} submitRef={submitRef}
        onRow={(t) => (t.state === "scheduled" ? setCal(true) : zoomToTask(t))} onCalendar={() => setCal(true)} width={PANEL_W} />

      <div className="o-zoom" style={{ right: narrow() ? 12 : PANEL_W + 22 }}>
        <button onClick={() => sceneRef.current?.zoomBy(1.4)} title="zoom in (+)" aria-label="Zoom in">+</button>
        <button onClick={() => sceneRef.current?.zoomBy(1 / 1.4)} title="zoom out (−)" aria-label="Zoom out">−</button>
        <button onClick={overview} title="overview (0)" aria-label="Overview">⌂</button>
      </div>
      <div className="o-keys">
        <b>1–6</b> departments · <b>B</b> board · <b>G</b> brain · <b>P</b> calendar · <b>C</b> chat · <b>D</b> dark · <b>F</b> flows · <b>M</b> channels · <b>W</b> workspace · <b>Esc</b> back
      </div>

      <Board open={board} tasks={tasks} snap={snap} agentsIn={count} nameOf={nameOf} onClose={() => setBoard(false)}
        onCard={(t) => { setBoard(false); zoomToTask(t); }} />
      <BrainOverlay open={brainOpen} data={brain} onClose={() => setBrainOpen(false)} />
      <Calendar open={cal} onClose={() => setCal(false)} tasks={tasks} snap={snap} nameOf={nameOf} onOpen={(t) => { setCal(false); zoomToTask(t); }} />
      <BigEditor open={big} text={text} setText={setText} dept={dept} onClose={() => setBig(false)} onAdd={() => { setBig(false); submitRef.current?.(); }} />
    </div>
  );
}
