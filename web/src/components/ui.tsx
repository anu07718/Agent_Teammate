import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Route } from "../types";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "ghost" | "outline" | "danger" | "good";
export function Button({ variant = "outline", size = "md", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  const v: Record<Variant, string> = {
    primary: "bg-accent text-accent-fg hover:opacity-90 border-transparent",
    ghost: "border-transparent hover:bg-panel-2 text-muted hover:text-fg",
    outline: "border-line-strong hover:bg-panel-2",
    danger: "border-transparent bg-escalate/15 text-escalate hover:bg-escalate/25",
    good: "border-transparent bg-act/15 text-act hover:bg-act/25",
  };
  return (
    <button
      {...p}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none cursor-pointer select-none",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
        v[variant],
        className,
      )}
    />
  );
}

const ROUTE_STYLE: Record<string, string> = {
  ACT: "text-act bg-act/12 border-act/30",
  HEDGE: "text-hedge bg-hedge/12 border-hedge/30",
  ESCALATE: "text-escalate bg-escalate/12 border-escalate/30",
  REFUSE: "text-refuse bg-refuse/12 border-refuse/30",
  REJECTED: "text-refuse bg-refuse/12 border-refuse/30",
  APPROVED: "text-act bg-act/12 border-act/30",
};

export function RouteBadge({ route, className }: { route: Route | string | null | undefined; className?: string }) {
  if (!route) return <span className="text-faint text-xs">—</span>;
  return (
    <span className={cx("inline-flex h-5 items-center rounded border px-1.5 text-[10.5px] font-semibold tracking-wide", ROUTE_STYLE[route] ?? "text-muted border-line", className)}>
      {route}
    </span>
  );
}

export function Badge({ children, tone = "muted", className }: { children: ReactNode; tone?: "muted" | "accent" | "gold" | "good" | "warn" | "bad"; className?: string }) {
  const t = {
    muted: "text-muted bg-panel-2 border-line",
    accent: "text-accent bg-accent/12 border-accent/30",
    gold: "text-gold bg-gold/12 border-gold/30",
    good: "text-act bg-act/12 border-act/30",
    warn: "text-hedge bg-hedge/12 border-hedge/30",
    bad: "text-escalate bg-escalate/12 border-escalate/30",
  }[tone];
  return <span className={cx("inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[10.5px] font-medium", t, className)}>{children}</span>;
}

export function StatusDot({ status }: { status: string }) {
  const c: Record<string, string> = {
    running: "bg-accent blink",
    parked: "bg-escalate blink",
    resolved: "bg-act",
    refused: "bg-refuse",
    working: "bg-accent blink",
    waiting: "bg-escalate blink",
    idle: "bg-faint/50",
  };
  return <span className={cx("inline-block h-2 w-2 shrink-0 rounded-full", c[status] ?? "bg-faint")} />;
}

export function Card({ title, actions, children, className, pad = true, fill = false }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean; fill?: boolean }) {
  return (
    <section className={cx("rounded-lg border border-line bg-panel", className)}>
      {(title || actions) && (
        <header className="flex min-h-10 items-center justify-between gap-2 border-b border-line px-3.5 py-2">
          <h3 className="text-[12.5px] font-semibold">{title}</h3>
          <div className="flex items-center gap-1.5">{actions}</div>
        </header>
      )}
      <div className={cx(pad && "p-3.5", fill && "flex min-h-0 flex-1 flex-col")}>{children}</div>
    </section>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div role="tablist" className={cx("flex items-center gap-0.5 overflow-x-auto border-b border-line px-2", className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            "relative h-9 shrink-0 cursor-pointer px-3 text-[12.5px] transition-colors",
            value === t.id ? "text-fg" : "text-muted hover:text-fg",
          )}
        >
          {t.label}
          {value === t.id && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded bg-accent" />}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "warn" | "bad" | "accent" }) {
  const t = tone ? { good: "text-act", warn: "text-hedge", bad: "text-escalate", accent: "text-accent" }[tone] : "text-fg";
  return (
    <div className="rounded-lg border border-line bg-panel px-3.5 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className={cx("mt-1 text-2xl font-semibold tabular", t)}>{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-muted">{sub}</div>}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-8 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <div className="text-[13px] font-medium">{title}</div>
      {children && <div className="max-w-sm text-[12.5px] text-muted">{children}</div>}
    </div>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[11.5px]", className)}>{children}</span>;
}

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
