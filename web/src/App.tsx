import { Building2, CheckCheck, Cpu, FlaskConical, Gauge, LayoutGrid, Moon, ScrollText, Settings, Sheet, Sun, Terminal, Waypoints } from "lucide-react";
import { useEffect, useRef } from "react";
import { cx } from "./components/ui";
import { clock, pct } from "./lib/format";
import { OfficePage } from "./office/OfficePage";
import { getState, openCase, setState, setTheme, useUI, type View, EMPTY } from "./store";
import { BenchmarkView } from "./views/Benchmark";
import { BrainView } from "./views/Brain";
import { LedgerView } from "./views/Ledger";
import { SettingsView } from "./views/Settings";
import { SupervisorView } from "./views/Supervisor";
import { TrailView } from "./views/Trail";
import { ApprovalsView, WorkspaceView } from "./views/Workspace";

const NAV: { id: View; label: string; icon: any; mobile?: boolean }[] = [
  { id: "office", label: "Office", icon: Building2, mobile: true },
  { id: "workspace", label: "Cases", icon: LayoutGrid, mobile: true },
  { id: "approvals", label: "Approvals", icon: CheckCheck, mobile: true },
  { id: "supervisor", label: "Supervisor", icon: Gauge, mobile: true },
  { id: "brain", label: "Brain", icon: Waypoints },
  { id: "ledger", label: "Ledger", icon: Sheet },
  { id: "benchmark", label: "Benchmark", icon: FlaskConical },
  { id: "trail", label: "Trail", icon: ScrollText },
  { id: "settings", label: "Settings", icon: Settings, mobile: true },
];

function Connectors() {
  const tools = useUI((s) => s.app?.tools ?? EMPTY);
  const pulses = useUI((s) => s.pulses);
  const systems = [...new Set(tools.map((t) => t.system))];
  const now = Date.now();
  return (
    <div className="hidden items-center gap-2.5 lg:flex" aria-label="Connected systems">
      <span className="text-[10.5px] font-medium uppercase tracking-wider text-faint">Connected</span>
      {systems.map((s) => {
        const p = pulses[s];
        const open = tools.some((t) => t.system === s && t.breaker === "open");
        const hot = p && now - p.ts < 900;
        return (
          <span key={s} className="flex items-center gap-1.5 text-[11.5px] text-muted" title={open ? `${s}: circuit open` : s}>
            <span key={p?.ts} className={cx("h-2 w-2 rounded-full", open ? "bg-escalate" : hot ? (p!.ok ? "bg-act pulse" : "bg-escalate pulse") : "bg-faint/40")} />
            <span className="hidden whitespace-nowrap 2xl:inline">{s}</span>
          </span>
        );
      })}
    </div>
  );
}

function LogPanel() {
  const events = useUI((s) => s.events);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [events.length]);
  const color = (k: string) =>
    k.startsWith("tool") ? "text-sky-400" : k.startsWith("approval") || k.startsWith("seal") ? "text-amber-400" : k.startsWith("drift") ? "text-red-400" :
    k.startsWith("decision") ? "text-violet-400" : k.startsWith("case") ? "text-emerald-400" : "text-neutral-400";
  const line = (e: any) => {
    switch (e.kind) {
      case "superstep": return `${e.case_id} ${e.step} ${e.phase}${e.note ? ` · ${e.note}` : ""}`;
      case "tool.called": return `${e.agent} → ${e.tool} ${e.ok ? `ok ${e.ms ?? ""}ms` : `FAILED ${e.error}`}`;
      case "agent.status": return `${e.agent} ${e.status}${e.doing ? ` · ${e.doing}` : ""}`;
      case "decision.routed": return `${e.case_id} ${e.route} · ${e.decisions.map((d: any) => `${d.action}=${d.route}`).join(" ")}`;
      case "case.created": case "case.updated": case "case.finished": return `${e.case.id} ${e.case.status} ${e.case.route ?? ""} ${e.case.step ?? ""}`;
      default: return JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !["id", "ts", "kind"].includes(k))));
    }
  };
  return (
    <div ref={ref} className="h-44 shrink-0 overflow-y-auto border-t border-line bg-[#0b0b0c] px-3 py-2 font-mono text-[11.5px] leading-5">
      {events.filter((e) => e.kind !== "case.updated").slice(-250).map((e) => (
        <div key={e.id} className="flex gap-2 whitespace-pre-wrap">
          <span className="text-neutral-600">{clock(e.ts)}</span>
          <span className={cx("w-32 shrink-0", color(e.kind))}>{e.kind}</span>
          <button className="text-left text-neutral-300 cursor-pointer" onClick={() => e.case_id && openCase(e.case_id)}>{line(e)}</button>
        </div>
      ))}
    </div>
  );
}

function Toasts() {
  const toasts = useUI((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-16 right-4 z-50 flex w-80 flex-col gap-2 md:bottom-9" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} onClick={() => t.caseId && openCase(t.caseId)}
          className={cx("slide-in pointer-events-auto cursor-pointer rounded-lg border bg-raised px-3 py-2 text-left text-[12.5px] shadow-xl",
            { info: "border-line-strong", good: "border-act/40", warn: "border-hedge/40", bad: "border-escalate/40" }[t.tone])}>
          {t.text}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const view = useUI((s) => s.view);
  const app = useUI((s) => s.app);
  const connected = useUI((s) => s.connected);
  const theme = useUI((s) => s.theme);
  const logOpen = useUI((s) => s.logOpen);
  const error = useUI((s) => s.error);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (getState().view === "office") return; // the office has its own keys
      if (e.key === "`") setState((s) => ({ logOpen: !s.logOpen }));
      const n = Number(e.key);
      if (n >= 1 && n <= NAV.length && !e.metaKey && !e.ctrlKey) setState({ view: NAV[n - 1].id });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pending = app?.stats.pending_approvals ?? 0;
  if (view === "office") return <OfficePage />;
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-4 border-b border-line bg-panel px-3" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="flex items-center gap-2">
          <img src="./favicon.svg" alt="" className="h-6 w-6" />
          <span className="text-[14px] font-semibold tracking-tight">Nirnaya</span>
          <span className="hidden whitespace-nowrap text-[12px] text-muted xl:inline">the support teammate that knows when to stop</span>
        </div>
        <div className="flex-1" />
        <Connectors />
        <div className="flex items-center gap-2">
          <span className={cx("flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium", connected ? "border-act/40 text-act" : "border-escalate/40 text-escalate")}>
            <span className={cx("h-1.5 w-1.5 rounded-full", connected ? "bg-act blink" : "bg-escalate")} />{connected ? "LIVE" : "OFFLINE"}
          </span>
          {app && <span className="hidden items-center gap-1 text-[11px] text-muted sm:flex" title="Language model"><Cpu size={12} />{app.integrations.llm.enabled ? "Claude" : "rules"}</span>}
          <button aria-label="Toggle the live log" onClick={() => setState((s) => ({ logOpen: !s.logOpen }))} className={cx("rounded p-1.5 cursor-pointer hover:bg-panel-2", logOpen ? "text-accent" : "text-muted")}><Terminal size={15} /></button>
          <button aria-label="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="rounded p-1.5 text-muted cursor-pointer hover:bg-panel-2">{theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}</button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2 md:flex" aria-label="Views">
          {NAV.map((n, i) => (
            <button key={n.id} onClick={() => setState({ view: n.id })} title={`${n.label} (${i + 1})`} aria-label={n.label} aria-current={view === n.id}
              className={cx("relative grid h-9 w-9 cursor-pointer place-items-center rounded-md", view === n.id ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel-2 hover:text-fg")}>
              <n.icon size={17} />
              {n.id === "approvals" && pending > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-escalate px-1 text-[9.5px] font-bold text-white">{pending}</span>}
            </button>
          ))}
        </nav>
        <main className="flex min-w-0 flex-1 flex-col">
          {error && !app && <div className="m-4 rounded-lg border border-escalate/40 bg-escalate/10 p-3 text-[12.5px]">Cannot reach the Nirnaya server ({error}). Start it with <code className="font-mono">python -m nirnaya</code>, or set the server address under Settings.</div>}
          <div className="min-h-0 flex-1">
            {!app ? null : view === "workspace" ? <WorkspaceView /> : view === "approvals" ? <ApprovalsView /> :
              view === "supervisor" ? <SupervisorView /> : view === "brain" ? <BrainView /> : view === "ledger" ? <LedgerView /> :
              view === "benchmark" ? <BenchmarkView /> : view === "trail" ? <TrailView /> : <SettingsView />}
          </div>
          {logOpen && <LogPanel />}
        </main>
      </div>
      <footer className="hidden h-6 shrink-0 items-center gap-4 border-t border-line bg-panel px-3 text-[11px] text-muted md:flex">
        {app && <>
          <span>{app.stats.cases} case(s)</span>
          <span>alone <span className="text-act">{pct(app.stats.autonomy)}</span></span>
          <button className={cx("cursor-pointer", pending ? "text-escalate" : "")} onClick={() => setState({ view: "approvals" })}>{pending} awaiting approval</button>
          <span className={app.drift.alarm ? "text-escalate" : ""}>drift PSI {app.drift.psi.toFixed(2)}{app.drift.alarm ? " · failing closed" : ""}</span>
          <span className="ml-auto">policy <span className="font-mono">{app.policy_hash}</span></span>
          <span>press 1–9 to switch views · ` for the log</span>
        </>}
      </footer>
      <nav className="flex h-14 shrink-0 items-stretch border-t border-line bg-panel md:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }} aria-label="Views">
        {NAV.filter((n) => n.mobile).map((n) => (
          <button key={n.id} onClick={() => setState({ view: n.id })} aria-current={view === n.id}
            className={cx("relative flex flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 text-[10.5px]", view === n.id ? "text-accent" : "text-muted")}>
            <n.icon size={18} />{n.label}
            {n.id === "approvals" && pending > 0 && <span className="absolute right-[28%] top-1.5 h-2 w-2 rounded-full bg-escalate" />}
          </button>
        ))}
      </nav>
      <Toasts />
    </div>
  );
}
