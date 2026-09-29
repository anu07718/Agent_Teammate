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
