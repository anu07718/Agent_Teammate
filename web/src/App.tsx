import { Building2, CheckCheck, FlaskConical, Gauge, KeyRound, LayoutGrid, MessagesSquare, ScrollText, Settings, Sheet, Terminal, Waypoints, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, setAccessKey } from "./api";
import { ChannelsView } from "./channels/ChannelsView";
import { People } from "./components/People";
import { Clock, ConnTiles, ReasonsWith, ThemeToggle } from "./components/TopBar";
import { CollabButton, JoinedPill } from "./components/Collab";
import { cx } from "./components/ui";
import { FlowsView } from "./flows/FlowsView";
import { clock, pct } from "./lib/format";
import { OfficePage } from "./office/OfficePage";
import { connect, getState, openCase, refresh, setState, useUI, type View, EMPTY } from "./store";
import { tellView } from "./team";
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
  { id: "channels", label: "Channels", icon: MessagesSquare, mobile: true },
  { id: "flows", label: "Flows", icon: Workflow, mobile: true },
  { id: "supervisor", label: "Supervisor", icon: Gauge, mobile: true },
  { id: "brain", label: "Brain", icon: Waypoints },
  { id: "ledger", label: "Ledger", icon: Sheet },
  { id: "benchmark", label: "Benchmark", icon: FlaskConical },
  { id: "trail", label: "Trail", icon: ScrollText },
  { id: "settings", label: "Settings", icon: Settings, mobile: true },
];

function LogPanel() {
  const events = useUI((s) => s.events);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [events.length]);
  const color = (k: string) =>
    k.startsWith("tool") ? "text-sky-400" : k.startsWith("approval") || k.startsWith("seal") ? "text-amber-400" : k.startsWith("drift") ? "text-red-400" :
    k.startsWith("decision") ? "text-violet-400" : k.startsWith("case") ? "text-emerald-400" : "text-neutral-400";
  const line = (e: any) => {
    const who = (b?: string | null) => (b && !["you", "routine", "system"].includes(b) ? ` · by ${b}` : "");
    switch (e.kind) {
      case "channel.message": return `${e.conv?.channel} ${e.message?.dir === "in" ? "←" : "→"} ${e.conv?.name}: ${String(e.message?.text ?? "").split("\n")[0].slice(0, 160)}${e.message?.status ? ` · ${e.message.status}` : ""}${e.message?.error ? ` (${e.message.error})` : ""}`;
      case "channel.error": return `${e.channel} could not send: ${e.error}`;
      case "channels.changed": return "channel settings saved";
      case "reply.sent": return `${e.case_id} reply ready for the customer (${String(e.text ?? "").length} chars)`;
      case "op.updated": return `${e.op.id} ${e.op.agent} ${e.op.state} · ${e.op.title}${e.op.state === "done" && e.op.result ? ` → ${String(e.op.result).split("\n")[0]}` : ""}${who(e.op.by)}`;
      case "op.removed": return `${e.op_id} cancelled`;
      case "routine.ran": return `${e.routine} ran · ${e.result ?? ""}`;
      case "routine.changed": return `${e.routine?.title ?? e.routine?.id} · ${e.routine?.desc ?? ""}${e.routine?.paused ? " · paused" : ""}`;
      case "chat.message": return `${e.message.agent} · ${e.message.by ?? e.message.who}: ${e.message.text.split("\n")[0].slice(0, 160)}`;
      case "flow.run": return `${e.run.id} “${e.run.name}” ${e.run.state} · ${Math.round(e.run.progress * 100)}%${who(e.run.by)}`;
      case "flow.saved": return `“${e.flow.name}” saved (v${e.flow.version})${who(e.by)}`;
      case "flow.deleted": return `${e.flow_id} deleted${who(e.by)}`;
      case "brain.read": return `${e.agent} read ${(e.nodes || []).length} node(s) for ${e.case_id}`;
      case "approval.requested": return `${e.case_id} sealed ${e.seal}… · waiting for a person`;
      case "approval.granted": return `${e.case_id} approved${who(e.by)}${e.edited ? " (edited)" : ""}`;
      case "approval.rejected": return `${e.case_id} rejected${who(e.by)}${e.note ? ` · “${e.note}”` : ""}`;
      case "rail.event": return `${e.txn_id} ${String(e.event).replace("_", " ")} → version ${e.version}`;
      case "policy.changed": return `${e.action} α ${e.alpha} rung ${e.rung}`;
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
          <span className="shrink-0 whitespace-nowrap text-neutral-600">{clock(e.ts)}</span>
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
          className={cx("slide-in shadow-card pointer-events-auto cursor-pointer rounded-xl border bg-raised px-3.5 py-2.5 text-left text-[12.5px]",
            { info: "border-line-strong", good: "border-act/40", warn: "border-hedge/40", bad: "border-escalate/40" }[t.tone])}>
          {t.text}
        </button>
      ))}
    </div>
  );
}

function KeyPrompt() {
  const [k, setK] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-bg/95 p-4" role="dialog" aria-label="Access key">
      <form className="w-full max-w-sm space-y-3 rounded-xl border border-line bg-panel p-5" onSubmit={async (e) => {
        e.preventDefault();
        setAccessKey(k.trim());
        await refresh();
        if (getState().needKey) { setBad(true); return; }
        connect(api.eventsUrl());
      }}>
        <div className="flex items-center gap-2 text-[15px] font-semibold"><KeyRound size={16} /> This Nirnaya server is locked</div>
        <p className="text-[12.5px] text-muted">It was started with an access key (NIRNAYA_ACCESS_KEY). Enter it to continue; this browser remembers it.</p>
        <input autoFocus type="password" aria-label="Access key" value={k} onChange={(e) => { setK(e.target.value); setBad(false); }}
          className="h-9 w-full rounded-md border border-line-strong bg-panel-2 px-2.5 text-[13px]" />
        {bad && <p className="text-[12px] text-escalate">That key is not right.</p>}
        <button type="submit" className="caps h-9 w-full cursor-pointer rounded-full bg-fg text-bg">Unlock</button>
      </form>
    </div>
  );
}

export default function App() {
  const needKey = useUI((s) => s.needKey);
  const view = useUI((s) => s.view);
  const app = useUI((s) => s.app);
  const connected = useUI((s) => s.connected);
  const logOpen = useUI((s) => s.logOpen);
  const error = useUI((s) => s.error);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (getState().view === "office") return; // the office has its own keys
      if (e.key === "`") setState((s) => ({ logOpen: !s.logOpen }));
      const n = Number(e.key);
      const i = e.key === "0" ? 9 : n - 1; // 1–9, then 0 for the tenth
      if (e.key.length === 1 && /[0-9]/.test(e.key) && i < NAV.length && !e.metaKey && !e.ctrlKey) setState({ view: NAV[i].id });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => { if (view !== "office") tellView(view); }, [view]);

  const pending = app?.waiting ? app.waiting.cases + app.waiting.ops + app.waiting.flows : app?.stats.pending_approvals ?? 0;
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const casesToday = (app?.cases ?? EMPTY).filter((c) => c.created_at * 1000 >= midnight.getTime()).length;
  if (needKey) return <KeyPrompt />;
  if (view === "office") return <><OfficePage /><Toasts /></>;
  return (
    <div className="flex h-full flex-col">
      {/* the office's top bar, in the same type and colours */}
      <header className="o-top o-top-static max-md:gap-2.5! max-md:px-3!" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <span className="o-brand max-sm:text-[19px]!">NIRNAYA<small className="max-sm:hidden!">WORKSPACE</small></span>
        <ConnTiles className="max-lg:hidden!" />
        <span className="o-sp" />
        {app && <>
          <ReasonsWith llm={app.integrations.llm} className="max-[1600px]:hidden!" tileClass="max-[1400px]:hidden!" />
          <span className="o-gauge o-caps max-lg:hidden!" title="today's cases, how many Nirnaya finished on its own, and the cost per case">
            TODAY<b>{casesToday}</b>{casesToday === 1 ? "CASE" : "CASES"}<span className="sep">·</span><b>{pct(app.stats.autonomy)}</b>ALONE
            {app.stats.cost_per_case != null && <><span className="sep max-2xl:hidden!">·</span><b className="max-2xl:hidden!">₹{app.stats.cost_per_case.toFixed(1)}</b><span className="max-2xl:hidden!">PER CASE</span></>}
          </span>
        </>}
        <span className={cx("o-live o-caps", !connected && "off")} title={connected ? "live updates from the server" : "the server is out of reach"}>
          <span className="o-dot" />{connected ? "LIVE" : "OFFLINE"}
        </span>
        <button className="o-btn o-caps max-md:hidden!" onClick={() => setState({ view: "office" })} aria-label="Back to the office" title="the 3D office">
          <Building2 size={13} /> OFFICE
        </button>
        {pending > 0 && (
          <button className="o-btn amber o-caps max-sm:hidden!" onClick={() => setState({ view: "approvals" })} title="waiting for a person: open Approvals" aria-label={`${pending} waiting for you`}>⚠ {pending}</button>
        )}
        <button aria-label="Toggle the live log" title="the live log (`)" onClick={() => setState((s) => ({ logOpen: !s.logOpen }))} className={cx("o-tile o-theme max-sm:hidden!", logOpen && "on")}><Terminal /></button>
        <JoinedPill className="max-sm:max-w-[130px]" />
        <CollabButton />
        <ThemeToggle />
        <People size={26} max={4} />
        <Clock className="max-xl:hidden!" />
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-14 shrink-0 flex-col items-center gap-1.5 border-r border-line bg-bg py-3 md:flex" aria-label="Views">
          {NAV.map((n, i) => (
            <button key={n.id} onClick={() => setState({ view: n.id })} title={i < 10 ? `${n.label} (${(i + 1) % 10})` : n.label} aria-label={n.label} aria-current={view === n.id}
              className={cx("relative grid h-9 w-9 cursor-pointer place-items-center rounded-full border transition-colors", view === n.id ? "border-fg bg-fg text-bg" : "border-transparent text-muted hover:border-line-strong hover:text-fg")}>
              <n.icon size={17} />
              {n.id === "approvals" && pending > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-escalate px-1 text-[9.5px] font-bold text-white">{pending}</span>}
            </button>
          ))}
        </nav>
        <main className="flex min-w-0 flex-1 flex-col">
          {error && !app && <div className="m-4 rounded-lg border border-escalate/40 bg-escalate/10 p-3 text-[12.5px]">Cannot reach the Nirnaya server ({error}). Start it with <code className="font-mono">python -m nirnaya</code>, or set the server address under Settings.</div>}
          <div className="min-h-0 flex-1">
            {!app ? null : view === "workspace" ? <WorkspaceView /> : view === "approvals" ? <ApprovalsView /> : view === "channels" ? <ChannelsView /> :
              view === "flows" ? <FlowsView /> : view === "supervisor" ? <SupervisorView /> : view === "brain" ? <BrainView /> : view === "ledger" ? <LedgerView /> :
              view === "benchmark" ? <BenchmarkView /> : view === "trail" ? <TrailView /> : <SettingsView />}
          </div>
          {logOpen && <LogPanel />}
        </main>
      </div>
      <footer className="caps hidden h-7 shrink-0 items-center gap-5 border-t border-line bg-bg px-4 text-muted md:flex">
        {app && <>
          <span>{app.stats.cases} case(s)</span>
          <span>alone <span className="text-act">{pct(app.stats.autonomy)}</span></span>
          <button className={cx("caps cursor-pointer", pending ? "text-escalate" : "")} onClick={() => setState({ view: "approvals" })}>{pending} awaiting approval</button>
          <span className={app.drift.alarm ? "text-escalate" : ""}>drift PSI {app.drift.psi.toFixed(2)}{app.drift.alarm ? " · failing closed" : ""}</span>
          <span className="ml-auto">policy <span className="font-mono normal-case tracking-normal">{app.policy_hash}</span></span>
          <span className="max-lg:hidden">1–9, 0 switch views · ` the log</span>
        </>}
      </footer>
      <nav className="flex h-14 shrink-0 items-stretch border-t border-line bg-bg md:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }} aria-label="Views">
        {NAV.filter((n) => n.mobile).map((n) => (
          <button key={n.id} onClick={() => setState({ view: n.id })} aria-current={view === n.id}
            className={cx("relative flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 text-[10px] tracking-tight max-[359px]:text-[9px]", view === n.id ? "font-semibold text-fg" : "text-muted")}>
            <n.icon size={18} /><span className="max-w-full truncate">{n.label}</span>
            {n.id === "approvals" && pending > 0 && <span className="absolute right-[28%] top-1.5 h-2 w-2 rounded-full bg-escalate" />}
          </button>
        ))}
      </nav>
      <Toasts />
    </div>
  );
}
