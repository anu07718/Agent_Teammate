import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, Empty, Mono } from "../components/ui";
import { ACTION_LABEL } from "../lib/format";
import { openCase, useUI } from "../store";

const KINDS = ["customer", "account", "vpa", "txn", "merchant", "case", "policy"];
const COLOR: Record<string, string> = {
  customer: "#3987e5", account: "#199e70", vpa: "#9085e9", txn: "#d95926", merchant: "#c98500", case: "#e66767", policy: "#d55181",
};

interface N { id: string; kind: string; label: string; x: number; y: number; vx: number; vy: number }

/**
 * Radial layout that follows the graph's own structure: policies at the centre, each customer on a ring
 * with its accounts and UPI IDs just inside, its transactions and their merchants fanning outward, and
 * its cases between it and the policies they are governed by.
 */
function useLayout(nodes: any[], edges: any[], w: number, h: number) {
  return useMemo<N[]>(() => {
    if (!nodes.length) return [];
    const cx = w / 2, cy = h / 2, m = Math.min(w, h), ex = w / m, ey = (h / m) * 0.92;
    const place = (r: number, a: number) => ({ x: cx + Math.cos(a) * r * ex, y: cy + Math.sin(a) * r * ey });
    const out: Record<string, { x: number; y: number }> = {};
    const byKind = (k: string) => nodes.filter((n) => n.kind === k);
    const from = (src: string, kind: string) => edges.filter((e) => e.src === src && e.kind === kind).map((e) => e.dst);
    const to = (dst: string, kind: string) => edges.filter((e) => e.dst === dst && e.kind === kind).map((e) => e.src);
    const pol = byKind("policy");
    pol.forEach((p, i) => (out[p.id] = place(m * 0.1, (i / Math.max(1, pol.length)) * Math.PI * 2)));
    const cust = byKind("customer");
    const R = m * 0.3, span = (Math.PI * 2) / Math.max(1, cust.length);
    cust.forEach((c, i) => {
      const a = -Math.PI / 2 + i * span;
      out[c.id] = place(R, a);
      const owned = from(c.id, "owns");
      owned.forEach((o, j) => (out[o] = place(R - m * 0.07, a + (j - (owned.length - 1) / 2) * span * 0.18)));
      const txns = owned.flatMap((o) => from(o, "paid"));
      txns.forEach((t, j) => {
        const ta = a + (txns.length > 1 ? (j / (txns.length - 1) - 0.5) * span * 0.7 : 0);
        out[t] = place(R + m * 0.1, ta);
        for (const mer of from(t, "to")) if (!out[mer]) out[mer] = place(R + m * 0.19, ta);
      });
      const cases = to(c.id, "raised_by");
      cases.forEach((k, j) => (out[k] = place(R * 0.55, a + (cases.length > 1 ? (j / (cases.length - 1) - 0.5) * span * 0.6 : 0))));
    });
    return nodes.map((n, i) => ({ ...n, ...(out[n.id] ?? place(m * 0.42, i)), vx: 0, vy: 0 }));
  }, [nodes, edges, w, h]);
}

export function BrainView() {
  const [g, setG] = useState<{ nodes: any[]; edges: any[] } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ nodes: any[]; edges: any[] } | null>(null);
  const [q, setQ] = useState("failed upi debited");
  const [hits, setHits] = useState<any[]>([]);
  const [filter, setFilter] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 520 });
  const done = useUI((s) => s.app?.stats.done);
  useEffect(() => { api.graph().then(setG); }, [done]);
  useEffect(() => { if (sel) api.graphNode(sel).then(setDetail); }, [sel]);
  useEffect(() => { api.memory(q).then(setHits); }, []);
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: Math.max(460, e.contentRect.height) }));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  const pos = useLayout(g?.nodes ?? [], g?.edges ?? [], size.w, size.h);
  const at = useMemo(() => Object.fromEntries(pos.map((n) => [n.id, n])), [pos]);
  const near = new Set(detail ? detail.nodes.map((n) => n.id) : []);
  const match = (n: N) => filter && (n.label.toLowerCase().includes(filter.toLowerCase()) || n.id.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="grid h-full min-h-0 gap-3 p-3 lg:grid-cols-[1fr_360px]">
      <Card title="Context graph" pad={false} fill className="flex min-h-0 flex-col" actions={
        <input aria-label="Highlight nodes" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Highlight…" className="h-7 w-36 rounded border border-line-strong bg-panel-2 px-2 text-[12px]" />}>
        <div className="flex flex-wrap gap-3 border-b border-line px-3.5 py-2 text-[11.5px] text-muted">
          {KINDS.map((k) => <span key={k} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR[k] }} />{k}</span>)}
        </div>
        <div ref={wrap} className="relative min-h-[420px] flex-1">
          {!g ? <Empty title="Loading…" /> : (
            <svg width={size.w} height={size.h} role="img" aria-label={`Context graph with ${g.nodes.length} nodes and ${g.edges.length} links`}>
              {g.edges.map((e, i) => {
                const a = at[e.src], b = at[e.dst];
                if (!a || !b) return null;
                const hot = sel && (e.src === sel || e.dst === sel);
                return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={hot ? "var(--gold)" : "var(--line-strong)"} strokeWidth={hot ? 1.5 : 1} />;
              })}
              {pos.map((n) => (
                <g key={n.id} onClick={() => setSel(n.id)} className="cursor-pointer" opacity={sel && !near.has(n.id) && sel !== n.id ? 0.35 : 1}>
                  <circle cx={n.x} cy={n.y} r={n.id === sel ? 8 : 5.5} fill={COLOR[n.kind] ?? "#888"} stroke={match(n) ? "var(--fg)" : "var(--panel)"} strokeWidth={2} />
                  {(n.kind === "customer" || n.kind === "policy" || n.id === sel || match(n)) && (
                    <text x={n.x + 8} y={n.y + 3} fontSize={10.5} fill="var(--muted)">{n.label.length > 26 ? n.label.slice(0, 25) + "…" : n.label}</text>
                  )}
                  <title>{`${n.kind}: ${n.label}`}</title>
                </g>
              ))}
            </svg>
          )}
        </div>
      </Card>
      <div className="min-h-0 space-y-3 overflow-y-auto">
        <Card title={sel ? <Mono>{sel}</Mono> : "Pick a node"}>
          {detail && sel ? (
            <ul className="space-y-1 text-[12px]">
              {detail.edges.map((e, i) => {
                const other = e.src === sel ? e.dst : e.src;
                return (
                  <li key={i} className="flex items-center gap-2">
                    <Badge>{e.src === sel ? e.kind : `← ${e.kind}`}</Badge>
                    <button className="truncate font-mono text-[11.5px] hover:underline cursor-pointer" onClick={() => other.startsWith("case:") ? openCase(other.slice(5)) : setSel(other)}>{other}</button>
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-[12px] text-muted">Customers, accounts, UPI IDs, transactions, merchants, cases and the policies that govern them. Identifiers are tokens. Agents ask this graph instead of re-reading every system per case.</p>}
        </Card>
        <Card title="Case memory">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); api.memory(q).then(setHits); }}>
            <input aria-label="Search memory" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 flex-1 rounded-md border border-line-strong bg-panel-2 px-2.5 text-[12.5px]" />
            <Button type="submit"><Search size={13} /></Button>
          </form>
          <ul className="mt-3 space-y-2">
            {hits.map((h) => (
              <li key={h.case_id} className="rounded-md border border-line p-2 text-[12px]">
                <div className="flex items-center gap-2">
                  {h.case_id.startsWith("H-")
                    ? <span className="font-mono text-muted" title="a past case from the history the memory was seeded with; it has no page">{h.case_id}</span>
                    : <button className="font-mono text-muted hover:underline cursor-pointer" onClick={() => openCase(h.case_id)} title="open this case">{h.case_id}</button>}
                  <Badge tone={h.state === "rejected" ? "bad" : h.state === "accepted" ? "good" : "accent"}>{h.state}</Badge>
                  {h.ground_moved && <Badge tone="warn">ground moved</Badge>}
                  <span className="ml-auto tabular text-faint">{h.score}</span>
                </div>
                <div className="mt-1 text-muted">{ACTION_LABEL[h.action] ?? h.action}</div>
                <div className="mt-0.5 line-clamp-2 text-faint">{h.text}</div>
              </li>
            ))}
            {!hits.length && <li className="text-[12px] text-faint">No matches.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
