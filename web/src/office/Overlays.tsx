// The office's full-screen views: the company board (B), the Brain (G), the calendar (P), and the big
// editor for a long task.
import { useEffect, useMemo, useRef, useState } from "react";
import { Av, dayTime, span, timeStr, until } from "./bits";
import { layout } from "./force";
import { oapi, refreshOffice, useOffice, type OfficeSnap, type OTask, type Routine } from "./data";
import { POD_IDS, POD_STYLE, type PodId } from "./layout";
import { pickerWhen } from "./Panel";

// ── the company board ────────────────────────────────────────────────────────
const COLS: [string, string][] = [["sched", "SCHEDULED"], ["next", "BACKLOG"], ["doing", "IN PROGRESS"], ["waiting", "WAITING ON APPROVAL"], ["done", "DONE"]];

export function Board({ open, tasks, snap, agentsIn, nameOf, onClose, onCard }: {
  open: boolean; tasks: OTask[]; snap: OfficeSnap | null; agentsIn: (p: PodId) => number;
  nameOf: (a: string) => string; onClose: () => void; onCard: (t: OTask) => void;
}) {
  const tot = (s: string) => s === "sched" ? (snap?.routines.length ?? 0) + tasks.filter((t) => t.state === "scheduled").length : tasks.filter((t) => t.state === s).length;
  return <>
    <div className={`o-dim${open ? " on" : ""}`} onClick={onClose} />
    <div className={`o-board${open ? " on" : ""}`} data-testid="board" aria-hidden={!open}>
      <div className="bh">
        <h2>Nirnaya</h2><span className="o-caps" style={{ color: "var(--o-grey)" }}>Today's board</span>
        <div className="stats">{COLS.map(([s, l]) => <span key={s}>{l.replace(" ON APPROVAL", "")}<b>{tot(s)}</b></span>)}</div>
      </div>
      <div className="o-lanes">
        <div className="lh" />
        {COLS.map(([, l]) => <div key={l} className="lh">{l}</div>)}
        {POD_IDS.map((pod) => {
          const mine = tasks.filter((t) => t.dept === pod);
          const rts = (snap?.routines ?? []).filter((r) => r.dept === pod);
          return [
            <div key={pod + "h"} className="ld"><span className="o-caps"><span className="o-dot" style={{ background: POD_STYLE[pod].chip }} />{POD_STYLE[pod].name}</span><b>{agentsIn(pod)} agents</b></div>,
            ...COLS.map(([s]) => {
              const list: (OTask | Routine)[] = s === "sched" ? [...rts, ...mine.filter((t) => t.state === "scheduled")] : mine.filter((t) => t.state === s);
              return (
                <div key={pod + s} className="lc">
                  {list.slice(0, 2).map((x) => "state" in x ? (
                    <div key={x.id} className={`o-tk ${x.state}`} onClick={() => onCard(x)}>
                      <div className="t">{x.op?.routine ? "⏱ " : ""}{x.title}</div>
                      <div className="m">{x.state === "done" ? <span style={{ color: "var(--o-green)" }}>✓</span> : <Av name={nameOf(x.agent)} pod={pod} />}<span>{nameOf(x.agent)}</span>
                        <span className="r">{x.state === "doing" ? `${Math.round(x.progress * 100)}%` : x.state === "waiting" ? `WAITING ${span(Date.now() - x.changedAt)}` : x.state === "done" ? timeStr(x.doneAt ?? x.changedAt) : x.state === "scheduled" ? until((x.dueAt ?? 0) / 1000) : ""}</span></div>
                      {x.state === "doing" && <div className="bar"><i style={{ width: `${Math.round(x.progress * 100)}%` }} /></div>}
                    </div>
                  ) : (
                    <div key={x.id} className="o-tk">
                      <div className="t">⏱ {x.title}</div>
                      <div className="m"><Av name={nameOf(x.agent)} pod={pod} /><span>{nameOf(x.agent)}</span><span className="r">{x.paused ? "PAUSED" : until(x.next_at)}</span></div>
                    </div>
                  ))}
                  {list.length > 2 && <div className="o-more">+{list.length - 2} more</div>}
                </div>
              );
            }),
          ];
        })}
      </div>
    </div>
  </>;
}

// ── the Brain ────────────────────────────────────────────────────────────────
export const GROUP_COL: Record<string, string> = {
  Customers: "#e8a0bf", Accounts: "#9fb3ea", "UPI IDs": "#7fd1c1", Transactions: "#f2c46d",
  Merchants: "#c9a0e8", Cases: "#f28b82", Policies: "#9bd48f", "Past cases": "#b8b5ab",
};
export interface BrainData { nodes: { id: string; label: string; group: string; kind: string; props: any; x: number; y: number; d: number }[]; links: [number, number, string][] }

export function useBrainData(open: boolean, version: number) {
  const [data, setData] = useState<BrainData | null>(null);
  useEffect(() => {
    let live = true;
    oapi.brain().then((b) => {
      if (!live) return;
      const deg = new Array(b.nodes.length).fill(0);
      for (const [a, c] of b.links) { deg[a]++; deg[c]++; }
      const pos = layout(b.nodes.length, b.links.map(([a, c]) => [a, c] as [number, number]));
      setData({ nodes: b.nodes.map((n, i) => ({ ...n, ...pos[i], d: deg[i] })), links: b.links });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [open, version]);
  return data;
}

export function BrainOverlay({ open, data, onClose }: { open: boolean; data: BrainData | null; onClose: () => void }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const reads = useOffice((s) => s.reads);
  const [q, setQ] = useState("");
  const [off, setOff] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<number | null>(null);
  const view = useRef({ k: 1.1, tx: 0, ty: 0, hover: -1 as number, drag: null as null | { x: number; y: number; moved: boolean } });
  const adj = useMemo(() => {
    const m = new Map<number, Set<number>>();
    for (const [a, b] of data?.links ?? []) { (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b); (m.get(b) ?? m.set(b, new Set()).get(b)!).add(a); }
    return m;
  }, [data]);
  const groups = useMemo(() => [...new Set(data?.nodes.map((n) => n.group) ?? [])], [data]);

  useEffect(() => {
    if (!open || !data) return;
    let raf = 0;
    const c = cv.current!, x = c.getContext("2d")!;
    const S = () => Math.min(c.clientWidth - 380, c.clientHeight) * 0.44 * view.current.k;
    const sx = (n: { x: number }) => (c.clientWidth - 360) / 2 + n.x * S() + view.current.tx;
    const sy = (n: { y: number }) => c.clientHeight / 2 + n.y * S() + view.current.ty;
    const ql = q.trim().toLowerCase();
    const match = ql ? new Set(data.nodes.map((n, i) => (n.label.toLowerCase().includes(ql) || n.id.toLowerCase().includes(ql) ? i : -1)).filter((i) => i >= 0)) : null;
    const draw = () => {
      const dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
      if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, W, H);
      const focus = view.current.hover >= 0 ? view.current.hover : sel;
      const hi = focus != null && focus >= 0 ? new Set([focus, ...(adj.get(focus) ?? [])]) : null;
      const vis = (i: number) => !off.has(data.nodes[i].group);
      x.lineWidth = Math.max(0.6, 0.9 * Math.sqrt(view.current.k));
      for (const [a, b] of data.links) {
        if (!vis(a) || !vis(b)) continue;
        const lit = hi && hi.has(a) && hi.has(b);
        x.strokeStyle = lit ? "rgba(232,230,223,.85)" : `rgba(232,230,223,${hi || match ? 0.06 : 0.16})`;
        x.beginPath(); x.moveTo(sx(data.nodes[a]), sy(data.nodes[a])); x.lineTo(sx(data.nodes[b]), sy(data.nodes[b])); x.stroke();
      }
      x.font = `${Math.max(10, 11 * Math.sqrt(view.current.k))}px Inter, sans-serif`;
      x.textBaseline = "middle";
      data.nodes.forEach((n, i) => {
        if (!vis(i)) return;
        const px = sx(n), py = sy(n), r = (2.2 + Math.sqrt(n.d) * 1.3) * Math.sqrt(view.current.k);
        const dim = (hi && !hi.has(i)) || (match && !match.has(i));
        x.globalAlpha = dim ? 0.18 : 1;
        x.fillStyle = GROUP_COL[n.group] ?? "#b0ada3";
        x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
        if (reads[n.id]) { x.strokeStyle = "#35c28f"; x.lineWidth = 1.6; x.beginPath(); x.arc(px, py, r + 3, 0, Math.PI * 2); x.stroke(); }
        if (sel === i) { x.strokeStyle = "#fff"; x.lineWidth = 1.6; x.beginPath(); x.arc(px, py, r + 5, 0, Math.PI * 2); x.stroke(); }
        if (n.d >= 5 || view.current.k > 2 || (hi && hi.has(i)) || (match && match.has(i))) {
          x.fillStyle = dim ? "rgba(232,230,223,.3)" : "#e8e6df";
          x.fillText(n.label, px + r + 4, py);
        }
        x.globalAlpha = 1;
      });
      raf = requestAnimationFrame(draw);
    };
    draw();
    const pick = (e: MouseEvent) => {
      let best = -1, bd = 12;
      data.nodes.forEach((n, i) => { if (!off.has(n.group)) { const d = Math.hypot(sx(n) - e.offsetX, sy(n) - e.offsetY); if (d < bd) { bd = d; best = i; } } });
      return best;
    };
    const move = (e: MouseEvent) => {
      const v = view.current;
      if (v.drag) { v.tx += e.clientX - v.drag.x; v.ty += e.clientY - v.drag.y; v.drag = { x: e.clientX, y: e.clientY, moved: true }; return; }
      v.hover = pick(e);
      c.style.cursor = v.hover >= 0 ? "pointer" : "grab";
    };
    const down = (e: MouseEvent) => { view.current.drag = { x: e.clientX, y: e.clientY, moved: false }; };
    const up = (e: MouseEvent) => { const d = view.current.drag; view.current.drag = null; if (d && !d.moved) { const i = pick(e); setSel(i >= 0 ? i : null); } };
    const wheel = (e: WheelEvent) => { e.preventDefault(); view.current.k = Math.max(0.5, Math.min(7, view.current.k * Math.exp(-e.deltaY * 0.0025))); };
    c.addEventListener("mousemove", move); c.addEventListener("mousedown", down); c.addEventListener("mouseup", up); c.addEventListener("wheel", wheel, { passive: false });
    return () => { cancelAnimationFrame(raf); c.removeEventListener("mousemove", move); c.removeEventListener("mousedown", down); c.removeEventListener("mouseup", up); c.removeEventListener("wheel", wheel); };
  }, [open, data, q, off, sel, adj, reads]);

  const s = sel != null && data ? data.nodes[sel] : null;
  return (
    <div className={`o-brain${open ? " on" : ""}`} data-testid="brain" aria-hidden={!open}>
      <canvas ref={cv} />
      <div className="top">
        <input placeholder="Search the Brain…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setQ(""); }} aria-label="Search the Brain" />
        <div className="o-bchips">
          {groups.map((g) => (
            <button key={g} className={off.has(g) ? "" : "on"} onClick={() => setOff((o) => { const n = new Set(o); n.has(g) ? n.delete(g) : n.add(g); return n; })}>
              <i style={{ background: GROUP_COL[g] }} />{g}
            </button>
          ))}
        </div>
      </div>
      <div className="brand">THE BRAIN <small>{data ? `${data.nodes.length} NODES · ${data.links.length} LINKS` : ""}</small></div>
      <div className="pane">
        {!s ? <div className="empty">Click a node to read it. Hover to see what it links to. Green rings are what the desks read today.</div> : <>
          <h3>{s.label}</h3>
          <div className="path"><i className="o-dot" style={{ background: GROUP_COL[s.group] }} />{s.group} · {s.d} link{s.d === 1 ? "" : "s"}</div>
          {reads[s.id] && <><div className="lab">Last read by</div><p style={{ margin: "6px 0 0" }}>{reads[s.id].agent} · {timeStr(reads[s.id].ts)}</p></>}
          {Object.keys(s.props || {}).length > 0 && <><div className="lab">Details</div>
            {Object.entries(s.props).map(([k, v]) => <div className="kv" key={k}><span style={{ opacity: 0.6 }}>{k.replace(/_/g, " ")}</span><span>{String(v)}</span></div>)}</>}
          <div className="lab">Links · {adj.get(sel!)?.size ?? 0}</div>
          {[...(adj.get(sel!) ?? [])].slice(0, 24).map((i) => {
            const n = data!.nodes[i];
            const kind = data!.links.find(([a, b]) => (a === sel && b === i) || (b === sel && a === i))?.[2];
            return <div key={i} className="lk" onClick={() => setSel(i)}><i className="o-dot" style={{ background: GROUP_COL[n.group] }} />{n.label}<small>{kind?.replace(/_/g, " ")}</small></div>;
          })}
        </>}
      </div>
      <div className="foot">ESC CLOSES · SCROLL ZOOMS · DRAG PANS · CLICK A NODE TO READ IT</div>
      <button className="o-x" style={{ right: 380, color: "#e8e6df" }} onClick={onClose} aria-label="Close the Brain">✕</button>
    </div>
  );
}

// ── the calendar ─────────────────────────────────────────────────────────────
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY = 86400000;
const sod = (ts: number) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const monday = (ts: number) => { const d = new Date(sod(ts)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
const ymd = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
type Ev = { kind: "done" | "sched" | "routine" | "doing" | "waiting"; at: number; title: string; dept: PodId; agent: string; t?: OTask; r?: Routine };

export function Calendar({ open, onClose, tasks, snap, nameOf, onOpen }: {
  open: boolean; onClose: () => void; tasks: OTask[]; snap: OfficeSnap | null; nameOf: (a: string) => string; onOpen: (t: OTask) => void;
}) {
  const [view, setView] = useState<"month" | "week">("month");
  const [anchor, setAnchor] = useState(sod(Date.now()));
  const [q, setQ] = useState("");
  const [on, setOn] = useState<Set<PodId>>(new Set(POD_IDS));
  const [showR, setShowR] = useState(true);
  const [showD, setShowD] = useState(true);
  const [only, setOnly] = useState<string | null>(null);
  const [occ, setOcc] = useState<Record<string, number[]>>({});
  const [pop, setPop] = useState<null | { day: number; x: number; y: number } | { ev: Ev; x: number; y: number }>(null);
  const range = useMemo(() => {
    if (view === "week") { const a = monday(anchor); return { from: a, to: a + 7 * DAY, days: 7 }; }
    const d = new Date(anchor); d.setDate(1);
    const first = monday(d.getTime());
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const rows = Math.ceil((last + ((d.getDay() + 6) % 7)) / 7);
    return { from: first, to: first + rows * 7 * DAY, days: rows * 7 };
  }, [view, anchor]);
  useEffect(() => {
    if (!open) return;
    oapi.occurrences(range.from / 1000, range.to / 1000).then(setOcc).catch(() => setOcc({}));
  }, [open, range.from, range.to, snap?.routines.length]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName.match(/INPUT|TEXTAREA|SELECT/)) return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
      if (e.key.toLowerCase() === "w") setView("week");
      if (e.key.toLowerCase() === "m") setView("month");
      if (e.key.toLowerCase() === "t") setAnchor(sod(Date.now()));
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  const step = (n: number) => {
    const d = new Date(anchor);
    if (view === "week") d.setDate(d.getDate() + 7 * n);
    else d.setMonth(d.getMonth() + n, 1);
    setAnchor(sod(d.getTime()));
  };
  const events = useMemo(() => {
    const by: Record<string, Ev[]> = {};
    const ql = q.trim().toLowerCase();
    const push = (e: Ev) => {
      if (!on.has(e.dept)) return;
      if (ql && !(e.title + " " + nameOf(e.agent)).toLowerCase().includes(ql)) return;
      (by[ymd(e.at)] ||= []).push(e);
    };
    const today = sod(Date.now());
    for (const t of tasks) {
      if (only && t.routine !== only) continue;
      if (t.state === "done") { if (showD && t.doneAt) push({ kind: "done", at: t.doneAt, title: t.title, dept: t.dept, agent: t.agent, t }); }
      else if (t.state === "scheduled") { if (t.dueAt) push({ kind: "sched", at: t.dueAt, title: t.title, dept: t.dept, agent: t.agent, t }); }
      else push({ kind: t.state === "waiting" ? "waiting" : "doing", at: Math.max(today + 1, Math.min(today + DAY - 1, t.changedAt)), title: t.title, dept: t.dept, agent: t.agent, t });
    }
    if (showR) for (const r of snap?.routines ?? []) {
      if (only && r.id !== only) continue;
      for (const at of occ[r.id] ?? []) push({ kind: "routine", at: at * 1000, title: r.title, dept: r.dept, agent: r.agent, r });
    }
    for (const k in by) by[k].sort((a, b) => a.at - b.at);
    return by;
  }, [tasks, snap, occ, q, on, showR, showD, only, nameOf]);
  const a = new Date(anchor);
  const title = view === "month" ? <>{MONTHS[a.getMonth()]}<small>{a.getFullYear()}</small></> : (() => {
    const s = new Date(range.from), e = new Date(range.to - DAY);
    return <>{s.getDate()}–{e.getDate()} {MONTHS[e.getMonth()].slice(0, 3)}<small>{e.getFullYear()}</small></>;
  })();
  const max = view === "month" ? 3 : 9;
  const counts = { routine: 0, sched: 0, done: 0 };
  Object.values(events).flat().forEach((e) => { if (e.kind in counts) (counts as any)[e.kind]++; });
  return (
    <div className={`o-cal${open ? " on" : ""}`} data-testid="calendar" aria-hidden={!open} onClick={() => pop && setPop(null)}>
      <div className="band">
        <div className="brand">CALENDAR <small>NIRNAYA</small></div>
        <div className="o-seg"><button className={view === "week" ? "on" : ""} onClick={() => setView("week")}>WEEK</button><button className={view === "month" ? "on" : ""} onClick={() => setView("month")}>MONTH</button></div>
        <div className="nav"><button className="arr" onClick={() => step(-1)} aria-label="previous">‹</button><div className="ttl">{title}</div><button className="arr" onClick={() => step(1)} aria-label="next">›</button><button className="today" onClick={() => setAnchor(sod(Date.now()))}>TODAY</button></div>
        <div className="keys"><b>←</b><b>→</b> move · <b>W</b><b>M</b> view · <b>T</b> today · <b>Esc</b> close</div>
        <button className="o-x" style={{ position: "static", color: "#ecebe4" }} onClick={onClose} aria-label="Close the calendar">✕</button>
      </div>
      <div className="tools">
        <input placeholder="Search tasks and routines…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        {POD_IDS.map((p) => (
          <button key={p} className={`o-mini${on.has(p) ? "" : ""}`} style={{ opacity: on.has(p) ? 1 : 0.4 }} onClick={() => setOn((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; })}>
            <span className="o-dot" style={{ background: POD_STYLE[p].chip, width: 6, height: 6, marginRight: 5 }} />{POD_STYLE[p].name}
          </button>
        ))}
        <button className={`o-mini${showR ? " on" : ""}`} onClick={() => setShowR(!showR)}>⏱ Routines</button>
        <button className={`o-mini${showD ? " on" : ""}`} onClick={() => setShowD(!showD)}>✓ Done</button>
        <div className="stats"><span><b>{counts.routine}</b>ROUTINE RUNS</span><span><b>{counts.sched}</b>BOOKED</span><span><b>{counts.done}</b>DONE</span></div>
      </div>
      <div className="body">
        <aside className="crail">
          <div className="o-caps">ROUTINES <b className="o-serif" style={{ fontSize: 16, marginLeft: 6 }}>{snap?.routines.length ?? 0}</b></div>
          {(snap?.routines ?? []).map((r) => (
            <div key={r.id} className={`rt${only === r.id ? " on" : ""}`} onClick={() => setOnly(only === r.id ? null : r.id)}>
              <div className="t">{r.title}</div>
              <div className="d">{r.desc} · {nameOf(r.agent)} · {r.paused ? "paused" : `next ${until(r.next_at)}`}{r.needs_ok ? " · waits for your OK" : ""}</div>
            </div>
          ))}
          <div className="foot">Click any day to book a task for it, or switch on REPEAT to start a routine from that date. Click a routine here to see only its days. Minute-by-minute checks run all day and are not drawn.</div>
        </aside>
        <div className="grid-wrap">
          <div className="dow">{DOW.map((d) => <div key={d}>{d}</div>)}</div>
          <div className="grid" style={{ gridTemplateRows: `repeat(${range.days / 7}, 1fr)` }}>
            {[...Array(range.days)].map((_, i) => {
              const day = range.from + i * DAY + 3600000; // an hour in, so DST never slips a day
              const d = new Date(day), list = events[ymd(day)] ?? [];
              const today = sod(Date.now()) === sod(day);
              return (
                <div key={i} className={`o-day${view === "month" && d.getMonth() !== a.getMonth() ? " out" : ""}${d.getDay() % 6 === 0 ? " we" : ""}${today ? " today" : ""}${sod(day) < sod(Date.now()) ? " past" : ""}`}
                  onClick={(e) => { e.stopPropagation(); if (sod(day) >= sod(Date.now())) setPop({ day: sod(day), x: e.clientX, y: e.clientY }); }}>
                  {list.slice(0, max).map((ev, k) => (
                    <div key={k} className={`o-ev ${ev.kind}`} style={{ ["--chip" as any]: POD_STYLE[ev.dept].chip }}
                      onClick={(e) => { e.stopPropagation(); if (ev.t && ev.kind !== "sched") onOpen(ev.t); else setPop({ ev, x: e.clientX, y: e.clientY }); }}>
                      <div className="t">{ev.kind === "routine" ? "⏱ " : ev.kind === "done" ? "✓ " : ev.kind === "sched" ? "◷ " : ""}{ev.title}</div>
                      <div className="m"><span>{ev.kind === "done" ? `done ${timeStr(ev.at)}` : ev.kind === "routine" || ev.kind === "sched" ? timeStr(ev.at) : ev.kind === "waiting" ? "waiting for your OK" : "in progress"}</span><span>{nameOf(ev.agent)}</span></div>
                    </div>
                  ))}
                  {list.length > max && <span className="o-daymore">{list.length - max} more</span>}
                  <span className="n">{d.getDate() === 1 ? <small style={{ fontSize: 10, marginRight: 4, fontFamily: "var(--o-ui)" }}>{MONTHS[d.getMonth()].slice(0, 3).toUpperCase()}</small> : null}{String(d.getDate()).padStart(2, "0")}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {pop && "day" in pop && <BookPop day={pop.day} x={pop.x} y={pop.y} onDone={() => setPop(null)} />}
      {pop && "ev" in pop && (
        <div className="o-pop" style={{ left: Math.min(pop.x, innerWidth - 340), top: Math.min(pop.y, innerHeight - 200) }} onClick={(e) => e.stopPropagation()}>
          <h4>{pop.ev.title}</h4>
          <div className="msg">{pop.ev.r ? `${pop.ev.r.desc} · ${nameOf(pop.ev.r.agent)}` : pop.ev.t?.dueAt ? `Booked for ${dayTime(pop.ev.t.dueAt)} · ${nameOf(pop.ev.agent)}` : ""}</div>
          <div className="row">
            {pop.ev.r && <>
              <button className="o-actbtn dark" onClick={async () => { await oapi.routine(pop.ev.r!.id, "run"); void refreshOffice(); setPop(null); }}>RUN NOW</button>
              <button className="o-actbtn" onClick={async () => { await oapi.routine(pop.ev.r!.id, pop.ev.r!.paused ? "resume" : "pause"); void refreshOffice(); setPop(null); }}>{pop.ev.r.paused ? "RESUME" : "PAUSE"}</button>
              {pop.ev.r.by !== "system" && <button className="o-actbtn" onClick={async () => { await oapi.deleteRoutine(pop.ev.r!.id); void refreshOffice(); setPop(null); }}>DELETE</button>}
            </>}
            {pop.ev.t?.state === "scheduled" && <button className="o-actbtn" onClick={async () => { await oapi.cancelOp(pop.ev.t!.id); void refreshOffice(); setPop(null); }}>CANCEL</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function BookPop({ day, x, y, onDone }: { day: number; x: number; y: number; onDone: () => void }) {
  const [text, setText] = useState("");
  const [dept, setDept] = useState<PodId>("oversight");
  const [time, setTime] = useState(() => (sod(Date.now()) === day ? new Date(Date.now() + 3600000).toTimeString().slice(0, 5) : "09:00"));
  const [rep, setRep] = useState(false);
  const [cad, setCad] = useState("weekdays");
  const [msg, setMsg] = useState<{ t: string; err?: boolean } | null>(null);
  const add = async () => {
    if (!text.trim()) return;
    const [h, m] = time.split(":").map(Number);
    const at = day + (h * 60 + m) * 60000;
    try {
      if (rep) {
        const when = { ...pickerWhen(cad, time), start: new Date(day).toISOString().slice(0, 10) };
        const r = await oapi.addTask({ dept, text, when });
        setMsg({ t: `Routine set: ${r.routine?.desc}` });
      } else {
        const r = await oapi.addTask({ dept, text, at, customer_id: "C-1001" });
        setMsg({ t: r.op ? `Booked for ${dayTime(at)}` : "Added." });
      }
      void refreshOffice();
      setTimeout(onDone, 900);
    } catch (e) { setMsg({ t: (e as Error).message, err: true }); }
  };
  return (
    <div className="o-pop" style={{ left: Math.min(x, innerWidth - 340), top: Math.min(y, innerHeight - 260) }} onClick={(e) => e.stopPropagation()}>
      <h4>{new Date(day).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</h4>
      <textarea autoFocus placeholder="What should happen? e.g. Verify the audit trail" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void add(); }} />
      <div className="row">
        <select value={dept} onChange={(e) => setDept(e.target.value as PodId)}>{POD_IDS.map((p) => <option key={p} value={p}>{POD_STYLE[p].name}</option>)}</select>
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        <button className={`o-mini${rep ? " on" : ""}`} onClick={() => setRep(!rep)}>Repeat</button>
      </div>
      {rep && <div className="row"><select value={cad} onChange={(e) => setCad(e.target.value)}>
        {[["weekdays", "Every weekday"], ["daily", "Every day"], ["0", "Mondays"], ["2", "Wednesdays"], ["4", "Fridays"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select><span className="msg">from this day</span></div>}
      <div className="row"><button className="o-add" onClick={() => void add()}>ADD</button><button className="o-actbtn" onClick={onDone}>CLOSE</button></div>
      {msg && <div className={`msg${msg.err ? " err" : ""}`}>{msg.t}</div>}
    </div>
  );
}

// ── the big editor ───────────────────────────────────────────────────────────
export function BigEditor({ open, text, setText, dept, onAdd, onClose }: { open: boolean; text: string; setText: (t: string) => void; dept: PodId; onAdd: () => void; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="o-bigwrap" onClick={onClose}>
      <div className="o-bigbox" onClick={(e) => e.stopPropagation()}>
        <div className="hd"><span className="o-caps" style={{ color: "var(--o-grey)" }}>TASK FOR</span><span className="o-dot" style={{ background: POD_STYLE[dept].chip }} /><span className="o-caps">{POD_STYLE[dept].name}</span><span className="o-sp" /><button className="o-actbtn" onClick={onClose}>✕</button></div>
        <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Write the message or the task, as long as you like…"
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onClose(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onAdd(); } }} />
        <div className="ft"><span className="o-sp" /><span style={{ color: "var(--o-faint)", fontSize: 11 }}><b>⌘↵</b> adds · <b>Esc</b> closes</span><button className="o-add" onClick={onAdd}>ADD</button></div>
      </div>
    </div>
  );
}
