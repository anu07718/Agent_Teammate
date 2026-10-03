import { useEffect, useRef, useState } from "react";

export interface Series { id: string; label: string; color: string; points: { x: number; y: number; n?: number }[]; labelAt?: number; labelPos?: "above" | "below" }

interface Props {
  series: Series[];
  xLabel: string;
  yLabel: string;
  xDomain?: [number, number];
  yDomain?: [number, number];
  diagonal?: boolean;
  marker?: { x: number; y: number; label: string } | null;
  hLine?: { y: number; label: string } | null;
  height?: number;
  fmtX?: (v: number) => string;
  fmtY?: (v: number) => string;
  ariaLabel: string;
}

const BASE = { r: 16, t: 14, b: 34 };

/** A small line chart: one y-axis, 2px lines, hairline grid, legend + direct labels, crosshair tooltip. */
export function LineChart({ series, xLabel, yLabel, xDomain = [0, 1], yDomain = [0, 1], diagonal, marker, hLine, height = 220, fmtX = (v) => v.toFixed(2), fmtY = (v) => v.toFixed(2), ariaLabel }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(420);
  const [hx, setHx] = useState<number | null>(null);
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, e.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  const ticks = (d: [number, number], n = 5) => Array.from({ length: n + 1 }, (_, i) => d[0] + ((d[1] - d[0]) * i) / n);
  const longest = Math.max(...ticks(yDomain).map((t) => fmtY(t).length));
  const M = { ...BASE, l: 30 + longest * 6.3 };
  const iw = w - M.l - M.r, ih = height - M.t - M.b;
  const sx = (v: number) => M.l + ((v - xDomain[0]) / (xDomain[1] - xDomain[0])) * iw;
  const sy = (v: number) => M.t + ih - ((v - yDomain[0]) / (yDomain[1] - yDomain[0])) * ih;
  const path = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");
  const nearest = (s: Series, x: number) => s.points.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a), s.points[0]);
  const hoverX = hx === null ? null : xDomain[0] + ((hx - M.l) / iw) * (xDomain[1] - xDomain[0]);

  return (
    <div ref={wrap} className="relative w-full">
      {series.length > 1 && (
        <div className="mb-1.5 flex flex-wrap gap-3 text-[11.5px] text-muted" aria-hidden>
          {series.map((s) => <span key={s.id} className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: s.color }} />{s.label}</span>)}
        </div>
      )}
      <svg width={w} height={height} role="img" aria-label={ariaLabel}
        onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const x = e.clientX - r.left; setHx(x >= M.l && x <= M.l + iw ? x : null); }}
        onMouseLeave={() => setHx(null)}>
        {ticks(yDomain).map((t) => (
          <g key={`y${t}`}>
            <line x1={M.l} x2={M.l + iw} y1={sy(t)} y2={sy(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={M.l - 6} y={sy(t)} textAnchor="end" dominantBaseline="middle" fontSize={10.5} fill="var(--faint)">{fmtY(t)}</text>
          </g>
        ))}
        {ticks(xDomain).map((t) => (
          <text key={`x${t}`} x={sx(t)} y={M.t + ih + 14} textAnchor="middle" fontSize={10.5} fill="var(--faint)">{fmtX(t)}</text>
        ))}
        <text x={M.l + iw / 2} y={height - 4} textAnchor="middle" fontSize={11} fill="var(--muted)">{xLabel}</text>
        <text x={11} y={M.t + ih / 2} textAnchor="middle" fontSize={11} fill="var(--muted)" transform={`rotate(-90 11 ${M.t + ih / 2})`}>{yLabel}</text>
        {diagonal && <line x1={sx(xDomain[0])} y1={sy(yDomain[0])} x2={sx(xDomain[1])} y2={sy(yDomain[1])} stroke="var(--line-strong)" strokeWidth={1} />}
        {diagonal && <text x={sx(0.5) + 10} y={sy(0.5) + 16} fontSize={10.5} fill="var(--faint)" transform={`rotate(${-Math.atan2(ih, iw) * 180 / Math.PI} ${sx(0.5) + 10} ${sy(0.5) + 16})`}>perfect calibration</text>}
        {hLine && <>
          <line x1={M.l} x2={M.l + iw} y1={sy(hLine.y)} y2={sy(hLine.y)} stroke="var(--escalate)" strokeWidth={1} />
          <text x={M.l + iw - 2} y={sy(hLine.y) - 5} textAnchor="end" fontSize={10.5} fill="var(--muted)">{hLine.label}</text>
        </>}
        {series.map((s) => (
          <g key={s.id}>
            <path d={path(s.points)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {s.points.length > 0 && series.length > 1 && s.labelAt !== undefined && (() => {
              const p = nearest(s, s.labelAt!);
              return <text x={sx(p.x)} y={sy(p.y) + (s.labelPos === "below" ? 16 : -9)} textAnchor="middle" fontSize={10.5} fill="var(--muted)">{s.label}</text>;
            })()}
          </g>
        ))}
        {marker && <>
          <circle cx={sx(marker.x)} cy={sy(marker.y)} r={5} fill="var(--gold)" stroke="var(--panel)" strokeWidth={2} />
          <text x={sx(marker.x) + (marker.x > (xDomain[0] + xDomain[1]) / 2 ? -8 : 8)} y={sy(marker.y) + 16} textAnchor={marker.x > (xDomain[0] + xDomain[1]) / 2 ? "end" : "start"} fontSize={10.5} fill="var(--fg)">{marker.label}</text>
        </>}
        {hoverX !== null && series[0]?.points.length > 0 && (
          <g pointerEvents="none">
            <line x1={hx!} x2={hx!} y1={M.t} y2={M.t + ih} stroke="var(--line-strong)" strokeWidth={1} />
            {series.map((s) => { const p = nearest(s, hoverX); return p ? <circle key={s.id} cx={sx(p.x)} cy={sy(p.y)} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={2} /> : null; })}
          </g>
        )}
      </svg>
      {hoverX !== null && series[0]?.points.length > 0 && (
        <div className="pointer-events-none absolute top-8 z-10 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[11.5px] shadow-lg"
          style={{ left: Math.min(w - 170, Math.max(0, hx! + 10)) }}>
          {series.map((s) => { const p = nearest(s, hoverX); return p ? (
            <div key={s.id} className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              <span className="text-muted">{s.label}</span>
              <span className="tabular">{xLabel.split(" ")[0]} {fmtX(p.x)} → {fmtY(p.y)}{p.n ? ` · n=${p.n}` : ""}</span>
            </div>) : null; })}
        </div>
      )}
    </div>
  );
}

/** Clean axis steps: 0, 1, 2, 5 × 10ⁿ, about four of them. */
export function niceTicks(max: number, n = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / n, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toFixed(6));
}

export interface ColSeries { key: string; label: string; color: string }

function useWidth(min = 220) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(min);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(min, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [min]);
  return [ref, w] as const;
}

/** A column per x (a day), stacked when there is more than one series: ≤24px columns, 4px rounded top on the
 *  column's top segment only, a 2px surface gap between segments, hairline grid, and a per-column readout on
 *  hover or keyboard focus that lists every series. */
export function ColumnChart({ rows, xKey, series, xFmt, yFmt = (v) => v.toLocaleString("en-IN"), extra, height = 210, ariaLabel, testId }: {
  rows: Record<string, any>[]; xKey: string; series: ColSeries[]; xFmt: (x: any) => string; yFmt?: (v: number) => string;
  extra?: (row: Record<string, any>) => string | null; height?: number; ariaLabel: string; testId?: string;
}) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const totals = rows.map((r) => series.reduce((a, s) => a + (Number(r[s.key]) || 0), 0));
  const ticks = niceTicks(Math.max(...totals, 0));
  const top = ticks[ticks.length - 1] || 1;
  const longest = Math.max(...ticks.map((t) => yFmt(t).length));
  const M = { l: 14 + longest * 6.4, r: 8, t: 10, b: 24 };
  const iw = w - M.l - M.r, ih = height - M.t - M.b;
  const band = iw / Math.max(rows.length, 1);
  const bw = Math.min(24, band * 0.62);
  const sy = (v: number) => M.t + ih - (v / top) * ih;
  const every = Math.ceil(rows.length / Math.max(2, Math.floor(iw / 64)));
  const topPath = (x: number, y: number, bwid: number, h: number) => {
    const r = Math.min(4, h, bwid / 2);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + bwid - r}Q${x + bwid},${y} ${x + bwid},${y + r}V${y + h}Z`;
  };
  return (
    <div ref={ref} className="relative w-full" data-testid={testId}>
      {series.length > 1 && (
        <div className="mb-1.5 flex flex-wrap gap-3 text-[11.5px] text-muted">
          {series.map((s) => <span key={s.key} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</span>)}
        </div>
      )}
      <svg width={w} height={height} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.l} x2={M.l + iw} y1={sy(t)} y2={sy(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={M.l - 6} y={sy(t)} textAnchor="end" dominantBaseline="middle" fontSize={10.5} fill="var(--faint)" className="tabular">{yFmt(t)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = M.l + band * i + (band - bw) / 2;
          let acc = 0;
          const segs = series.map((s) => ({ s, v: Number(r[s.key]) || 0 })).filter((g) => g.v > 0);
          return (
            <g key={i} opacity={hover === null || hover === i ? 1 : 0.55}>
              {segs.map((g, j) => {
                const y0 = sy(acc), y1 = sy(acc + g.v);
                acc += g.v;
                const h = Math.max(1, y0 - y1 - (j < segs.length - 1 ? 2 : 0));   // the 2px surface gap
                const y = y0 - h;
                return j === segs.length - 1
                  ? <path key={g.s.key} d={topPath(x, y, bw, h)} fill={g.s.color} />
                  : <rect key={g.s.key} x={x} y={y} width={bw} height={h} fill={g.s.color} />;
              })}
              {i % every === 0 && <text x={x + bw / 2} y={height - 8} textAnchor="middle" fontSize={10.5} fill="var(--faint)">{xFmt(r[xKey])}</text>}
              <rect x={M.l + band * i} y={M.t} width={band} height={ih} fill="transparent" tabIndex={0}
                aria-label={`${xFmt(r[xKey])}: ${series.map((s) => `${s.label} ${yFmt(Number(r[s.key]) || 0)}`).join(", ")}`}
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
            </g>
          );
        })}
        <line x1={M.l} x2={M.l + iw} y1={sy(0)} y2={sy(0)} stroke="var(--line-strong)" strokeWidth={1} />
      </svg>
      {hover !== null && rows[hover] && (
        <div className="pointer-events-none absolute top-6 z-10 min-w-36 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[11.5px] shadow-lg"
          style={{ left: Math.min(w - 180, Math.max(0, M.l + band * hover + band / 2 + 12)) }}>
          <div className="mb-0.5 text-muted">{xFmt(rows[hover][xKey])}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <span className="h-0.5 w-3 rounded" style={{ background: s.color }} />
              <b className="tabular">{yFmt(Number(rows[hover][s.key]) || 0)}</b><span className="text-muted">{s.label}</span>
            </div>
          ))}
          {extra?.(rows[hover]) && <div className="mt-0.5 text-muted">{extra(rows[hover])}</div>}
        </div>
      )}
    </div>
  );
}

/** Horizontal bars for a ranked list: label, bar (≤16px, 4px rounded end), value at the tip. */
export function BarList({ rows, color, fmt = (v) => v.toLocaleString("en-IN"), sub, ariaLabel }: {
  rows: { label: string; value: number; title?: string }[]; color: string; fmt?: (v: number) => string; sub?: (i: number) => string | null; ariaLabel: string;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-2" aria-label={ariaLabel}>
      {rows.map((r, i) => (
        <li key={r.label} title={r.title} className="grid grid-cols-[minmax(96px,34%)_1fr] items-center gap-2 text-[12px]">
          <span className="leading-tight text-muted">{r.label}</span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="h-3.5 rounded-r" style={{ width: `${Math.max(1.5, (r.value / max) * 78)}%`, background: color }} />
            <span className="shrink-0 tabular">{fmt(r.value)}{sub?.(i) ? <span className="text-faint"> · {sub(i)}</span> : null}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
