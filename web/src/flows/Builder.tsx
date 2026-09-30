// The flow builder: drag a node from the palette onto the canvas, wire an output (right) to an input
// (left), set it up on the right, save, run. The office's agents do the work; each node shows its state
// and result live, for everyone who has the flow open.
import { Copy, Hand, Minus, Play, Plus, RotateCcw, Save, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "../components/People";
import { Badge, Button, cx } from "../components/ui";
import { ago } from "../lib/format";
import { onEvents, setState, toast, useUI, EMPTY } from "../store";
import { me, tellView, type Person } from "../team";
import { fapi, type FEdge, type FlowsData, type FNode, type NodeType, type Run } from "./api";

const W = 216, H = 88, GRID = 10;
const GROUP_COLOR: Record<string, string> = { Trigger: "#2fa98c", Agents: "#5b7cfa", Logic: "#d98a1c", People: "#e0719a" };
const ORDER: NodeType[] = ["start", "case", "task", "if", "approval", "notify", "wait"];
const TASK_EXAMPLES: Record<string, string[]> = {
  verification: ["Check T-5001", "Pull the evidence for T-5006"],
  decision: ["Run the benchmark", "List the certified thresholds", "Score refund_duplicate 349", "Recalibrate"],
  commit: ["Undo NR-1002", "check: ₹500 will be credited in 2 hours, guaranteed"],
  oversight: ["Verify the audit trail", "Tamper test on the audit trail", "Check for drift", "Write today's digest", "Find approvals past their TAT"],
};
const VALUES: Record<string, string[]> = { ok: ["true", "false"], route: ["ACT", "HEDGE", "ESCALATE", "REFUSE"], status: ["resolved", "refused", "parked"] };

interface Draft { id: string | null; name: string; nodes: FNode[]; edges: FEdge[]; version: number; by?: string; updated_by?: string; updated_at?: number; when_desc?: string }
type Sel = { kind: "node"; id: string } | { kind: "edge"; i: number } | null;

const snap = (v: number) => Math.round(v / GRID) * GRID;
const portY = (n: number, i: number) => (n === 1 ? H / 2 : i === 0 ? H * 0.34 : H * 0.72);

function summary(n: FNode, d: FlowsData | null): string {
  const c = n.config;
  const dept = (id: string) => d?.depts.find((x) => x.id === id)?.name ?? id;
  switch (n.type) {
    case "start": return c.when ? `⏱ ${c.when}` : "run by hand";
    case "case": return `${d?.customers.find((x) => x.id === c.customer_id)?.name.split(" ")[0] ?? c.customer_id}: “${c.message}”`;
    case "task": return `${dept(c.dept)} · ${c.text}`;
    case "if": return `${d?.fields[c.field] ? c.field === "ok" ? "succeeded" : c.field : c.field} ${c.op} ${c.value}`;
    case "approval": return `“${c.question}”`;
    case "notify": return `→ ${dept(c.dept)}: ${c.text}`;
    case "wait": return `${c.seconds} s`;
  }
}

function wire(x1: number, y1: number, x2: number, y2: number) {
  const dx = Math.max(50, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export function Builder({ open, setOpen }: { open: string | null; setOpen: (id: string | null) => void }) {
  const [data, setData] = useState<FlowsData | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<Sel>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [conn, setConn] = useState<{ from: string; port: string; x: number; y: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [runSel, setRunSel] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const presets = useUI((s) => s.app?.presets ?? EMPTY);
  const people = useUI((s) => s.people ?? EMPTY) as Person[];

  const load = useCallback(async () => {
    try {
      const d = await fapi.all();
      setData(d);
      setRuns(d.runs);
      return d;
    } catch (e) { setErr((e as Error).message); return null; }
  }, []);

  const pick = useCallback((d: FlowsData, id: string | null) => {
    const f = d.flows.find((x) => x.id === id) ?? d.flows[0];
    if (!f) { setDraft(null); return; }
    setDraft({ ...f, nodes: f.nodes.map((n) => ({ ...n, config: { ...n.config } })), edges: f.edges.map((e) => ({ ...e })) });
    setDirty(false); setSel(null); setErr(null); setNotice(null); setRunSel(null);
    if (f.id !== open) setOpen(f.id);
  }, [open, setOpen]);

  useEffect(() => { void load().then((d) => d && pick(d, open)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (data && open && draft?.id !== open && !dirtyRef.current) pick(data, open); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { tellView("flows", draft?.name ?? null); }, [draft?.name]);

  // the team: someone else saves, deletes or runs a flow
  useEffect(() => onEvents((ev) => {
    if (ev.kind === "flow.run") setRuns((rs) => [...rs.filter((r) => r.id !== ev.run.id), ev.run]);
    if (ev.kind === "flow.saved") {
      setData((d) => (d ? { ...d, flows: [...d.flows.filter((f) => f.id !== ev.flow.id), ev.flow] } : d));
      const cur = draftRef.current;
      if (cur && cur.id === ev.flow.id && cur.version !== ev.flow.version && ev.by !== me().name) {
        if (!dirtyRef.current) {
          setDraft({ ...ev.flow });
          toast(`${ev.by} saved “${ev.flow.name}”; you have the new version`, "info");
        } else setNotice(`${ev.by} saved a newer version of “${ev.flow.name}” while you were editing.`);
      }
    }
    if (ev.kind === "flow.deleted") {
      setData((d) => (d ? { ...d, flows: d.flows.filter((f) => f.id !== ev.flow_id) } : d));
      if (draftRef.current?.id === ev.flow_id && ev.by !== me().name) setNotice(`${ev.by} deleted this flow. Save it to keep your copy.`);
    }
  }), []);

  // ── editing ───────────────────────────────────────────────────────────────
  const edit = (fn: (d: Draft) => Draft) => { setDraft((d) => (d ? fn(d) : d)); setDirty(true); setErr(null); };
  const types = data?.types;
  const nodeOf = (id: string) => draft?.nodes.find((n) => n.id === id);

  const addNode = (type: NodeType, x: number, y: number, link = false) => {
    if (!draft || !types) return;
    if (type === "start" && draft.nodes.some((n) => n.type === "start")) { setErr("A flow has one Start: runs begin there."); return; }
    let i = 1;
    while (draft.nodes.some((n) => n.id === `${type}${i}`)) i++;
    const node: FNode = { id: `${type}${i}`, type, x: snap(x), y: snap(y), config: JSON.parse(JSON.stringify(types[type].config)) };
    const from = link && sel?.kind === "node" ? nodeOf(sel.id) : null;
    edit((d) => {
      const edges = [...d.edges];
      if (from && types[from.type].ports.length) {
        const port = types[from.type].ports.find((p) => !d.edges.some((e) => e.from === from.id && e.port === p)) ?? types[from.type].ports[0];
        edges.push({ from: from.id, to: node.id, port });
      }
      return { ...d, nodes: [...d.nodes, node], edges };
    });
    setSel({ kind: "node", id: node.id });
  };

  const toWorld = (cx: number, cy: number) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  };

  const addHere = (type: NodeType) => {
    // a click on the palette: next to the selected node, or in the middle of what you see
    const from = sel?.kind === "node" ? nodeOf(sel.id) : null;
    if (from) { addNode(type, from.x + W + 70, from.y + (draft!.edges.filter((e) => e.from === from.id).length * (H + 30)), true); return; }
    const r = canvas.current!.getBoundingClientRect();
    const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    addNode(type, c.x - W / 2, c.y - H / 2);
  };

  const remove = () => {
    if (!sel || !draft) return;
    if (sel.kind === "node") edit((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== sel.id), edges: d.edges.filter((e) => e.from !== sel.id && e.to !== sel.id) }));
    else edit((d) => ({ ...d, edges: d.edges.filter((_, i) => i !== sel.i) }));
    setSel(null);
  };

  const setConfig = (id: string, patch: Record<string, any>) =>
    edit((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, config: { ...n.config, ...patch } } : n)) }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); remove(); }
      if (e.key === "Escape") { setSel(null); setConn(null); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── the canvas: pan, zoom, drag nodes, draw wires ─────────────────────────
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const move = useRef<{ id: string; x: number; y: number; nx: number; ny: number; moved: boolean } | null>(null);

  const onBgDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-node]")) return;
    setSel(null);
    pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onBgMove = (e: React.PointerEvent) => {
    if (conn) { const w = toWorld(e.clientX, e.clientY); setConn({ ...conn, x: w.x, y: w.y }); }
    if (pan.current) setView((v) => ({ ...v, x: pan.current!.vx + e.clientX - pan.current!.x, y: pan.current!.vy + e.clientY - pan.current!.y }));
    if (move.current) {
      const m = move.current;
      const nx = snap(m.nx + (e.clientX - m.x) / view.k), ny = snap(m.ny + (e.clientY - m.y) / view.k);
      if (Math.abs(e.clientX - m.x) + Math.abs(e.clientY - m.y) > 3) m.moved = true;
      if (m.moved) {
        setDraft((d) => (d ? { ...d, nodes: d.nodes.map((n) => (n.id === m.id ? { ...n, x: nx, y: ny } : n)) } : d));
        setDirty(true);
      }
    }
  };
  const onBgUp = (e: React.PointerEvent) => {
    pan.current = null;
    move.current = null;
    if (conn) {
      const hit = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest("[data-node]") as HTMLElement | null;
      const to = hit?.dataset.node;
      const target = to ? nodeOf(to) : null;
      if (target && to !== conn.from && target.type !== "start" && !draft!.edges.some((w) => w.from === conn.from && w.to === to && w.port === conn.port))
        edit((d) => ({ ...d, edges: [...d.edges, { from: conn.from, to: to!, port: conn.port }] }));
      else if (target?.type === "start") setErr("Nothing can wire into Start.");
      setConn(null);
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const k = Math.min(2, Math.max(0.35, view.k * (e.deltaY > 0 ? 0.9 : 1.1)));
    const px = e.clientX - r.left, py = e.clientY - r.top;
    setView({ k, x: px - ((px - view.x) / view.k) * k, y: py - ((py - view.y) / view.k) * k });
  };
  const zoom = (f: number) => setView((v) => {
    const r = canvas.current!.getBoundingClientRect();
    const k = Math.min(2, Math.max(0.35, v.k * f)), px = r.width / 2, py = r.height / 2;
    return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
  });
  const fit = useCallback(() => {
    const d = draftRef.current;
    if (!d?.nodes.length || !canvas.current) return;
    const r = canvas.current.getBoundingClientRect();
    const minX = Math.min(...d.nodes.map((n) => n.x)), maxX = Math.max(...d.nodes.map((n) => n.x + W));
    const minY = Math.min(...d.nodes.map((n) => n.y)), maxY = Math.max(...d.nodes.map((n) => n.y + H));
    const k = Math.min(1.1, Math.max(0.35, Math.min((r.width - 80) / (maxX - minX), (r.height - 80) / (maxY - minY))));
    setView({ k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - (maxY - minY) * k) / 2 - minY * k });
  }, []);
  useEffect(() => { const t = setTimeout(fit, 30); return () => clearTimeout(t); }, [draft?.id, draft?.version, fit]);

  // ── save, run, stop ───────────────────────────────────────────────────────
  const save = async (): Promise<string | null> => {
    if (!draft) return null;
    setBusy(true);
    try {
      const body = { name: draft.name.trim() || "Untitled flow", nodes: draft.nodes, edges: draft.edges };
      const f = draft.id ? await fapi.save(draft.id, { ...body, version: draft.version }) : await fapi.create(body);
      setDraft({ ...f });
      setDirty(false); setErr(null); setNotice(null);
      setData((d) => (d ? { ...d, flows: [...d.flows.filter((x) => x.id !== f.id), f] } : d));
      if (f.id !== open) setOpen(f.id);
      return f.id;
    } catch (e) { setErr((e as Error).message); return null; } finally { setBusy(false); }
  };
  const run = async () => {
    const id = dirty || !draft?.id ? await save() : draft.id;
    if (!id) return;
    try {
      const r = await fapi.run(id);
      setRuns((rs) => [...rs.filter((x) => x.id !== r.id), r]);
      setRunSel(null);
      toast(`“${r.name}” is running (${r.id})`, "good");
    } catch (e) { setErr((e as Error).message); }
  };
  const newFlow = () => {
    setDraft({ id: null, name: "New flow", version: 0, edges: [], nodes: [{ id: "start1", type: "start", x: 60, y: 160, config: { when: "" } }] });
    setDirty(true); setSel({ kind: "node", id: "start1" }); setErr(null); setNotice(null); setOpen(null);
  };
  const copyFlow = () => {
    if (!draft) return;
    setDraft({ ...draft, id: null, version: 0, name: `${draft.name} (copy)` });
    setDirty(true); setOpen(null);
  };
  const del = async () => {
    if (!draft?.id) { if (data) pick(data, null); return; }
    if (!sure) { setSure(true); setTimeout(() => setSure(false), 3000); return; }
    setSure(false);
    try { await fapi.remove(draft.id); const d = await load(); if (d) pick(d, null); toast("Flow deleted", "info"); }
    catch (e) { setErr((e as Error).message); }
  };

  // the run shown on the canvas: the one picked below, else the latest of this flow
  const mine = useMemo(() => runs.filter((r) => r.flow_id === draft?.id).sort((a, b) => b.started_at - a.started_at), [runs, draft?.id]);
  const shown = (runSel ? mine.find((r) => r.id === runSel) : mine[0]) ?? null;
  const live = shown && (shown.state === "running" || shown.state === "waiting");
  const showRun = shown && (live || !dirty);
  const here = people.filter((p) => p.client !== me().client && p.view === "flows" && p.focus === draft?.name);

  if (!data) return <div className="p-6 text-[13px] text-muted">{err ?? "Loading…"}</div>;
  const selNode = sel?.kind === "node" ? nodeOf(sel.id) : null;

  return (
    <div className="fl-builder">
      {/* toolbar */}
      <div className="fl-tools">
        <select aria-label="Flow" value={draft?.id ?? ""} onChange={(e) => { if (!dirty || window.confirm("Drop your unsaved changes?")) pick(data, e.target.value); }}
          className="h-8 max-w-52 rounded-md border border-line-strong bg-panel-2 px-2 text-[12.5px]">
          {!draft?.id && <option value="">{draft?.name ?? "New flow"} (not saved)</option>}
          {[...data.flows].sort((a, b) => a.name.localeCompare(b.name)).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <input aria-label="Flow name" value={draft?.name ?? ""} onChange={(e) => edit((d) => ({ ...d, name: e.target.value }))}
          className="h-8 w-48 rounded-md border border-line-strong bg-panel-2 px-2.5 text-[12.5px] font-medium" />
        <Button size="sm" variant="ghost" onClick={newFlow}><Plus size={13} /> New</Button>
        <Button size="sm" variant="ghost" onClick={copyFlow} disabled={!draft}><Copy size={12} /> Copy</Button>
        <Button size="sm" onClick={() => void save()} disabled={!draft || busy || (!dirty && !!draft.id)}><Save size={13} /> Save</Button>
        <Button size="sm" variant="primary" onClick={() => void run()} disabled={!draft || busy || !!live}><Play size={13} /> Run</Button>
        {live && shown && <Button size="sm" variant="danger" onClick={() => fapi.stop(shown.id).catch((e) => setErr(e.message))}><Square size={12} /> Stop</Button>}
        <Button size="sm" variant={sure ? "danger" : "ghost"} onClick={() => void del()} disabled={!draft}><Trash2 size={13} /> {sure ? "Sure? Delete" : "Delete"}</Button>
        <span className="ml-auto flex items-center gap-2 text-[11.5px] text-muted">
          {here.length > 0 && <span className="flex items-center gap-1" title={`${here.map((p) => p.name).join(", ")} ${here.length > 1 ? "have" : "has"} this flow open`}>{here.map((p) => <Avatar key={p.client} p={p} size={20} />)} here too</span>}
          {dirty ? <Badge tone="warn">unsaved</Badge> : draft?.id ? <span>v{draft.version} · {draft.updated_by ?? draft.by}{draft.updated_at ? ` · ${ago(draft.updated_at)}` : ""} · {draft.when_desc}</span> : null}
        </span>
      </div>
      {(err || notice) && (
        <div className={cx("fl-banner", err ? "err" : "warn")} role="alert">
          <span>{err ?? notice}</span>
          {notice && <Button size="sm" onClick={() => { void load().then((d) => d && pick(d, draft?.id ?? null)); }}><RotateCcw size={12} /> Load theirs</Button>}
          <button aria-label="Dismiss" className="ml-auto cursor-pointer opacity-60 hover:opacity-100" onClick={() => { setErr(null); setNotice(null); }}><X size={14} /></button>
        </div>
      )}
      {live && shown && (
        <div className="fl-runbar">
          <span className="font-mono">{shown.id}</span><span>{shown.state === "waiting" ? "waiting for a person" : "running"} · started by {shown.by}</span>
          <div className="fl-bar flex-1"><i style={{ width: `${Math.max(3, shown.progress * 100)}%` }} /></div>
          <b className="tabular">{Math.round(shown.progress * 100)}%</b>
        </div>
      )}

      <div className="fl-body">
        {/* palette */}
        <aside className="fl-palette" aria-label="Nodes">
          <div className="fl-palette-h">Drag onto the canvas</div>
          {ORDER.map((t) => {
            const s = data.types[t];
            return (
              <div key={t} className="fl-pal" draggable data-palette={t} role="button" tabIndex={0} title={s.help}
                onDragStart={(e) => { e.dataTransfer.setData("application/x-nirnaya-node", t); e.dataTransfer.setData("text/plain", t); e.dataTransfer.effectAllowed = "copy"; }}
                onClick={() => addHere(t)} onKeyDown={(e) => { if (e.key === "Enter") addHere(t); }}>
                <span className="fl-ic" style={{ background: GROUP_COLOR[s.group] }}>{s.icon}</span>
                <span className="min-w-0"><span className="block text-[12.5px] font-medium">{s.label}</span><span className="block truncate text-[10.5px] text-faint">{s.group}</span></span>
              </div>
            );
          })}
          <p className="fl-palette-tip">Drag from a node’s right dot to another node to wire them. Delete removes what you selected. Drag the background to move around; scroll to zoom.</p>
        </aside>

        {/* canvas */}
        <div ref={canvas} className={cx("fl-canvas", conn && "wiring")} data-testid="canvas" tabIndex={0}
          style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${20 * view.k}px ${20 * view.k}px` }}
          onPointerDown={onBgDown} onPointerMove={onBgMove} onPointerUp={onBgUp} onWheel={onWheel}
          onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-nirnaya-node") || e.dataTransfer.types.includes("text/plain")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
          onDrop={(e) => {
            const t = (e.dataTransfer.getData("application/x-nirnaya-node") || e.dataTransfer.getData("text/plain")) as NodeType;
            if (!ORDER.includes(t)) return;
            e.preventDefault();
            const w = toWorld(e.clientX, e.clientY);
            addNode(t, w.x - W / 2, w.y - H / 2);
          }}>
          <div className="fl-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            <svg className="fl-wires" width="1" height="1">
              {draft?.edges.map((e, i) => {
                const a = nodeOf(e.from), b = nodeOf(e.to);
                if (!a || !b || !types) return null;
                const ports = types[a.type].ports;
                const y1 = a.y + portY(ports.length, Math.max(0, ports.indexOf(e.port)));
                const d = wire(a.x + W, y1, b.x, b.y + H / 2);
                const st = showRun ? shown!.nodes[e.to]?.state : null;
                const on = sel?.kind === "edge" && sel.i === i;
                return (
                  <g key={i} data-edge={`${e.from}>${e.to}`}>
                    <path d={d} className="fl-hit" onPointerDown={(ev) => { ev.stopPropagation(); setSel({ kind: "edge", i }); }} />
                    <path d={d} className={cx("fl-wire", on && "on", st && `s-${st}`)} />
                    {ports.length > 1 && <text x={a.x + W + 12} y={y1 + (e.port === "yes" ? -9 : 16)} className="fl-port-label">{e.port}</text>}
                  </g>
                );
              })}
              {conn && (() => {
                const a = nodeOf(conn.from);
                if (!a || !types) return null;
                const ports = types[a.type].ports;
                return <path d={wire(a.x + W, a.y + portY(ports.length, ports.indexOf(conn.port)), conn.x, conn.y)} className="fl-wire temp" />;
              })()}
            </svg>
            {draft?.nodes.map((n) => {
              const s = data.types[n.type];
              const r = showRun ? shown!.nodes[n.id] : null;
              const on = sel?.kind === "node" && sel.id === n.id;
              return (
                <div key={n.id} data-node={n.id} data-type={n.type} data-state={r?.state ?? "idle"}
                  className={cx("fl-node", on && "on", r && `s-${r.state}`)} style={{ left: n.x, top: n.y, width: W, minHeight: H }}
                  onPointerDown={(e) => {
                    if ((e.target as HTMLElement).closest("button, input, select, textarea, .fl-port")) return;
                    e.stopPropagation();
                    setSel({ kind: "node", id: n.id });
                    move.current = { id: n.id, x: e.clientX, y: e.clientY, nx: n.x, ny: n.y, moved: false };
                    canvas.current?.setPointerCapture(e.pointerId);
                  }}>
                  {n.type !== "start" && <span className="fl-port in" data-in={n.id} />}
                  <div className="flex items-start gap-2">
                    <span className="fl-ic" style={{ background: GROUP_COLOR[s.group] }}>{s.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5"><span className="truncate text-[12.5px] font-semibold">{s.label}</span><span className="ml-auto font-mono text-[9.5px] text-faint">{n.id}</span></div>
                      <div className="fl-sum">{summary(n, data)}</div>
                    </div>
                  </div>
                  {r && r.state !== "pending" && (
                    <div className="fl-state">
                      <span className="dot" /><span className="st">{r.state}</span>
                      {r.text && r.state !== "skipped" && <span className="tx" title={r.text}>{r.text}</span>}
                    </div>
                  )}
                  {r?.state === "waiting" && n.type === "approval" && shown && (
                    <div className="mt-1.5 flex gap-1.5">
                      <button className="fl-yes" onClick={() => fapi.decide(shown.id, n.id, true).catch((e) => setErr(e.message))}>Yes</button>
                      <button className="fl-no" onClick={() => fapi.decide(shown.id, n.id, false).catch((e) => setErr(e.message))}>No</button>
                    </div>
                  )}
                  {r?.state === "waiting" && n.type !== "approval" && (
                    <button className="fl-link-btn" onClick={() => setState({ view: "approvals" })}>Open Approvals ↗</button>
                  )}
                  {s.ports.map((p, i) => (
                    <span key={p} className={cx("fl-port out", s.ports.length > 1 && `p-${p}`)} data-out={`${n.id}:${p}`} title={`drag to wire “${p}”`}
                      style={{ top: portY(s.ports.length, i) - 7 }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        const w = toWorld(e.clientX, e.clientY);
                        setConn({ from: n.id, port: p, x: w.x, y: w.y });
                        canvas.current?.setPointerCapture(e.pointerId);
                      }} />
                  ))}
                </div>
              );
            })}
          </div>
          {!draft && <div className="absolute inset-0 grid place-items-center text-[13px] text-muted"><Button onClick={newFlow}><Plus size={13} /> New flow</Button></div>}
          <div className="fl-zoom">
            <button aria-label="Zoom in" onClick={() => zoom(1.2)}><Plus size={14} /></button>
            <button aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}><Minus size={14} /></button>
            <button aria-label="Fit to screen" onClick={fit}><Hand size={13} /></button>
          </div>
        </div>

        {/* inspector */}
        <aside className="fl-side" aria-label="Settings">
          {selNode ? (
            <Inspector n={selNode} data={data} presets={presets} run={showRun ? shown!.nodes[selNode.id] : null}
              set={(p) => setConfig(selNode.id, p)} onDelete={remove} />
          ) : sel?.kind === "edge" && draft ? (
            <div className="space-y-3">
              <h3 className="text-[13px] font-semibold">Wire</h3>
              <p className="text-[12px] text-muted">{draft.edges[sel.i]?.from} ({draft.edges[sel.i]?.port}) → {draft.edges[sel.i]?.to}</p>
              <Button size="sm" variant="danger" onClick={remove}><Trash2 size={12} /> Delete wire</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <h3 className="text-[13px] font-semibold">{draft?.name ?? "No flow"}</h3>
              <p className="text-[12px] text-muted">{draft ? `${draft.nodes.length} node(s), ${draft.edges.length} wire(s). Pick a node to set it up.` : ""} Runs are done by the office’s agents: department tasks land on the office board, customer messages go through the whole case pipeline, and approvals wait for someone on the team.</p>
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">Runs of this flow</div>
                {mine.length ? (
                  <ul className="space-y-1.5" data-testid="runs">
                    {mine.slice(0, 10).map((r) => (
                      <li key={r.id}>
                        <button className={cx("w-full cursor-pointer rounded-md border px-2.5 py-2 text-left", shown?.id === r.id ? "border-accent/50 bg-accent/8" : "border-line hover:bg-panel-2")} onClick={() => setRunSel(r.id)}>
                          <div className="flex items-center gap-2 text-[12px]">
                            <span className="font-mono">{r.id}</span>
                            <Badge tone={r.state === "done" ? "good" : r.state === "failed" || r.state === "stopped" ? "bad" : r.state === "waiting" ? "warn" : "accent"}>{r.state}</Badge>
                            <span className="ml-auto tabular text-muted">{Math.round(r.progress * 100)}%</span>
                          </div>
                          <div className="mt-0.5 truncate text-[11px] text-faint">{r.by} · {ago(r.started_at)}{r.result ? ` · ${r.result}` : ""}</div>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-[12px] text-faint">Not run yet. Press Run.</p>}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-faint">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-faint">{hint}</span>}
    </label>
  );
}
const inputCls = "w-full rounded-md border border-line-strong bg-panel-2 px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent";

function Inspector({ n, data, presets, run, set, onDelete }: {
  n: FNode; data: FlowsData; presets: { id: string; customer: string; label: string; text: string }[];
  run: Run["nodes"][string] | null; set: (p: Record<string, any>) => void; onDelete: () => void;
}) {
  const s = data.types[n.type];
  const c = n.config;
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  return (
    <div className="space-y-3" onKeyDown={stop}>
      <div className="flex items-center gap-2">
        <span className="fl-ic" style={{ background: GROUP_COLOR[s.group] }}>{s.icon}</span>
        <div><h3 className="text-[13px] font-semibold">{s.label}</h3><div className="font-mono text-[10.5px] text-faint">{n.id}</div></div>
      </div>
      <p className="text-[12px] text-muted">{s.help}</p>
      {n.type === "start" && (
        <Field label="When" hint="Leave empty to run it by hand. Or say when: “every weekday at 9am”, “Mondays at 10:30”, “every hour”.">
          <input className={inputCls} value={c.when ?? ""} placeholder="by hand" onChange={(e) => set({ when: e.target.value })} aria-label="When" />
        </Field>
      )}
      {n.type === "case" && <>
        <Field label="Customer">
          <select className={inputCls} value={c.customer_id} onChange={(e) => set({ customer_id: e.target.value })} aria-label="Customer">
            {data.customers.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.id}</option>)}
          </select>
        </Field>
        <Field label="Channel">
          <select className={inputCls} value={c.channel ?? "chat"} onChange={(e) => set({ channel: e.target.value })} aria-label="Channel">
            {["chat", "whatsapp", "email", "voice", "app"].map((x) => <option key={x}>{x}</option>)}
          </select>
        </Field>
        <Field label="The customer says">
          <textarea className={cx(inputCls, "h-24 resize-none")} value={c.message} onChange={(e) => set({ message: e.target.value })} aria-label="Message" />
        </Field>
        <div className="flex flex-wrap gap-1">
          {presets.slice(0, 8).map((p) => <button key={p.id} className="fl-chip" onClick={() => set({ message: p.text, customer_id: p.customer })}>{p.label}</button>)}
        </div>
      </>}
      {n.type === "task" && <>
        <Field label="Department">
          <select className={inputCls} value={c.dept} onChange={(e) => set({ dept: e.target.value, text: TASK_EXAMPLES[e.target.value]?.[0] ?? "" })} aria-label="Department">
            {data.task_depts.map((d) => <option key={d} value={d}>{data.depts.find((x) => x.id === d)?.name ?? d}</option>)}
          </select>
        </Field>
        <Field label="Task" hint={<>It can: {(data.can[c.dept] ?? []).join("; ")}.</>}>
          <input className={inputCls} value={c.text} onChange={(e) => set({ text: e.target.value })} aria-label="Task" />
        </Field>
        <div className="flex flex-wrap gap-1">{(TASK_EXAMPLES[c.dept] ?? []).map((t) => <button key={t} className="fl-chip" onClick={() => set({ text: t })}>{t}</button>)}</div>
      </>}
      {n.type === "if" && <>
        <Field label="Check">
          <select className={inputCls} value={c.field} onChange={(e) => set({ field: e.target.value, value: VALUES[e.target.value]?.[0] ?? "" })} aria-label="Check">
            {Object.entries(data.fields).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="How">
            <select className={inputCls} value={c.op} onChange={(e) => set({ op: e.target.value })} aria-label="How">
              {data.ops.map((o) => <option key={o}>{o}</option>)}
            </select>
          </Field>
          <Field label="Value">
            {VALUES[c.field] ? (
              <select className={inputCls} value={c.value} onChange={(e) => set({ value: e.target.value })} aria-label="Value">
                {VALUES[c.field].map((v) => <option key={v}>{v}</option>)}
              </select>
            ) : <input className={inputCls} value={c.value} onChange={(e) => set({ value: e.target.value })} aria-label="Value" />}
          </Field>
        </div>
        <p className="text-[11px] text-faint">It looks at the step wired into it. “yes” goes out the top dot, “no” the bottom one.</p>
      </>}
      {n.type === "approval" && (
        <Field label="Ask" hint="Anyone on the team can answer, here, in Approvals, or at the Support lead’s desk in the office. {case} and {result} fill in.">
          <textarea className={cx(inputCls, "h-20 resize-none")} value={c.question} onChange={(e) => set({ question: e.target.value })} aria-label="Question" />
        </Field>
      )}
      {n.type === "notify" && <>
        <Field label="Post in the chat of">
          <select className={inputCls} value={c.dept} onChange={(e) => set({ dept: e.target.value })} aria-label="Department">
            {data.depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Message" hint="{result}, {case}, {route}, {status}, {by} and {flow} fill in from the run.">
          <textarea className={cx(inputCls, "h-20 resize-none")} value={c.text} onChange={(e) => set({ text: e.target.value })} aria-label="Message" />
        </Field>
      </>}
      {n.type === "wait" && (
        <Field label="Seconds">
          <input type="number" min={0} max={3600} className={inputCls} value={c.seconds} onChange={(e) => set({ seconds: Number(e.target.value) })} aria-label="Seconds" />
        </Field>
      )}
      {run && run.state !== "pending" && (
        <div className="rounded-md border border-line bg-panel-2 px-2.5 py-2 text-[12px]">
          <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wider text-faint">Last run · {run.state}</div>
          <div className="whitespace-pre-wrap break-words">{run.text || "—"}</div>
        </div>
      )}
      <Button size="sm" variant="danger" onClick={onDelete}><Trash2 size={12} /> Delete node</Button>
    </div>
  );
}
