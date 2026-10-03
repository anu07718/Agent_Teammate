import { useSyncExternalStore } from "react";
import { api } from "./api";
import { joined, relayEvents, relayPresence } from "./relay";
import { me, streamParams, type Person } from "./team";
import type { Agent, AppState, CaseSummary, NEvent } from "./types";

export type View = "office" | "workspace" | "approvals" | "channels" | "flows" | "supervisor" | "brain" | "ledger" | "benchmark" | "trail" | "dashboard" | "settings";

export interface Toast { id: number; text: string; tone: "info" | "good" | "warn" | "bad"; caseId?: string }

export interface UIState {
  app: AppState | null;
  connected: boolean;
  error: string | null;
  events: NEvent[];
  view: View;
  openCases: string[];
  activeCase: string | null;
  selectedAgent: string | null;
  pulses: Record<string, { ts: number; ok: boolean; agent: string }>;
  toasts: Toast[];
  theme: "dark" | "light";
  logOpen: boolean;
  version: number;
  people: Person[];
  /** the server answered 401: it needs its access key */
  needKey: boolean;
  /** on a phone, Cases shows the open case (true) or the list (false) */
  caseOnPhone: boolean;
  /** in someone else's workspace: why their server is not answering ("offline", "closed"…), if it is not */
  hostState: string | null;
}

// light (paper) unless chosen otherwise; one theme for the office and the workspace (the office kept its own
// "nirnaya.office.dark" before, which still counts the first time)
const initialTheme = (() => {
  try {
    const saved = localStorage.getItem("nirnaya.theme") as "dark" | "light" | null;
    return saved ?? (localStorage.getItem("nirnaya.office.dark") === "1" ? "dark" : "light");
  } catch {
    return "light";
  }
})();

let state: UIState = {
  app: null, connected: false, error: null, events: [], view: "office", openCases: [], activeCase: null,
  selectedAgent: null, pulses: {}, toasts: [], theme: initialTheme, logOpen: false, version: 0, people: [], needKey: false,
  caseOnPhone: false, hostState: null,
};
const listeners = new Set<() => void>();

export function getState() {
  return state;
}

export function setState(patch: Partial<UIState> | ((s: UIState) => Partial<UIState>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

export function useUI<T>(sel: (s: UIState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sel(state),
  );
}

let toastId = 1;
export function toast(text: string, tone: Toast["tone"] = "info", caseId?: string) {
  const t = { id: toastId++, text, tone, caseId };
  setState((s) => ({ toasts: [...s.toasts.slice(-3), t] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), 5200);
}

/** open a case in Cases; `show` also puts it in front on a phone, where the list and the case take turns */
export function openCase(id: string, show = true) {
  setState((s) => ({
    view: "workspace",
    activeCase: id,
    openCases: s.openCases.includes(id) ? s.openCases : [...s.openCases.slice(-7), id],
    caseOnPhone: show || s.caseOnPhone,
  }));
}

export function closeCase(id: string) {
  setState((s) => {
    const open = s.openCases.filter((x) => x !== id);
    return { openCases: open, activeCase: s.activeCase === id ? open[open.length - 1] ?? null : s.activeCase, caseOnPhone: open.length ? s.caseOnPhone : false };
  });
}

export async function refresh() {
  try {
    const app = await api.state();
    setState({ app, error: null, needKey: false });
  } catch (e) {
    const keyRequired = (e as { keyRequired?: boolean }).keyRequired;
    setState({ error: (e as Error).message, ...(keyRequired ? { needKey: true } : {}) });
  }
}

function upsertCase(list: CaseSummary[], c: CaseSummary) {
  const i = list.findIndex((x) => x.id === c.id);
  if (i === -1) return [c, ...list];
  const next = list.slice();
  next[i] = { ...next[i], ...c };
  return next;
}

function patchAgent(list: Agent[], id: string, p: Partial<Agent>) {
  return list.map((a) => (a.id === id ? { ...a, ...p } : a));
}

const eventListeners = new Set<(ev: NEvent) => void>();
/** every live event, as it arrives (the office animates from these) */
export function onEvents(fn: (ev: NEvent) => void) {
  eventListeners.add(fn);
  return () => { eventListeners.delete(fn); };
}

function onEvent(ev: NEvent) {
  if (ev.kind === "presence") { setState({ people: ev.people ?? [] }); return; }
  eventListeners.forEach((fn) => {
    try { fn(ev); } catch { /* one bad listener never stops the stream */ }
  });
  setState((s) => {
    const events = [...s.events.slice(-399), ev];
    const app = s.app;
    if (!app) return { events };
    const next: Partial<UIState> = { events, version: s.version + 1 };
    let a: AppState = app;
    switch (ev.kind) {
      case "agent.status":
        a = { ...a, agents: patchAgent(a.agents, ev.agent, { status: ev.status, case_id: ev.case_id, doing: ev.doing, since: ev.ts }) };
        break;
      case "case.created":
      case "case.updated":
      case "case.finished":
        a = { ...a, cases: upsertCase(a.cases, ev.case) };
        break;
      case "tool.called":
        next.pulses = { ...s.pulses, [ev.system]: { ts: Date.now(), ok: ev.ok, agent: ev.agent } };
        a = { ...a, tools: a.tools.map((t) => (t.name === ev.tool ? { ...t, calls: t.calls + (ev.ok ? 1 : 0), fails: ev.ok ? 0 : t.fails + 1, breaker: ev.error === "circuit open" ? "open" : ev.ok ? "closed" : "warning" } : t)) };
        break;
      case "drift.alarm":
        a = { ...a, drift: ev.status };
        break;
      case "policy.changed":
        a = { ...a, policy_hash: ev.policy_hash };
        break;
    }
    next.app = a;
    return next;
  });
  if (ev.kind === "approval.requested") toast(`${ev.case_id} needs your approval`, "warn", ev.case_id);
  const other = ev.by && ev.by !== me().name ? ev.by : null; // a teammate did it: say who
  if (other && ev.kind === "approval.granted") toast(`${other} approved ${ev.case_id}`, "good", ev.case_id);
  if (other && ev.kind === "approval.rejected") toast(`${other} rejected ${ev.case_id}`, "info", ev.case_id);
  if (ev.kind === "seal.rejected_approval") toast(`${ev.case_id}: the ledger moved, so the old approval was not applied`, "bad", ev.case_id);
  if (ev.kind === "drift.alarm" && ev.status?.alarm) toast("Drift alarm: every α halved, autonomy capped at HEDGE", "bad");
  if (["case.finished", "approval.granted", "approval.rejected", "action.undone", "system.restarted", "rail.reset",
       "model.recalibrated", "policy.changed", "flow.run"].includes(ev.kind)) softRefresh();
  if (ev.kind === "op.updated" && (ev.op.state === "waiting" || ev.op.state === "done")) softRefresh();
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Coalesce bursts of events into one state refresh. */
function softRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, 350);
}

let es: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

let stopRelay: (() => void) | null = null;

export function connect(url: string) {
  es?.close();
  stopRelay?.();
  stopRelay = null;
  if (retry) clearTimeout(retry);
  if (joined()) { // someone else's workspace: their events come through the relay
    stopRelay = relayEvents(onEvent, (connected, why) => {
      const was = state.connected;
      setState({ connected, hostState: why ?? null });
      if (connected && !was) void refresh();
    });
    relayPresence({ view: state.view });
    return;
  }
  es = new EventSource(`${url}${url.includes("?") ? "&" : "?"}${streamParams(state.view)}`);
  es.onopen = () => {
    setState({ connected: true });
    void refresh();
  };
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {
      /* ignore malformed */
    }
  };
  es.onerror = () => {
    setState({ connected: false });
    es?.close();
    void refresh(); // a 401 here means the server wants its access key: refresh() finds out and asks
    retry = setTimeout(() => connect(url), 2500);
  };
}

export function setTheme(theme: "dark" | "light") {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem("nirnaya.theme", theme);
  } catch {
    /* ignore */
  }
  setState({ theme });
}

/** A shared empty list, so selectors never return a fresh array (which would re-render forever). */
export const EMPTY: any[] = [];
