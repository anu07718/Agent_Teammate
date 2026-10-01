// The office's data: the /api/office snapshot, its API calls, a small store for what only the office
// needs (chats, activity feeds), and how cases and ops become cards on the Task Status panel.
import { useSyncExternalStore } from "react";
import { apiBase, ApiError } from "../api";
import { by } from "../team";
import { INTENT_LABEL, inr } from "../lib/format";
import type { AppState, CaseSummary } from "../types";
import type { PodId } from "./layout";

export interface Connector { key: string; name: string; depts: string[]; status: "connected" | "down" | "open"; breaker: string; calls: number; tools: string[]; moves_money: boolean }
export interface Op {
  id: string; kind: string; dept: PodId; agent: string; title: string; text: string; by: string; routine: string | null;
  state: "scheduled" | "next" | "doing" | "waiting" | "done"; created_at: number; started_at: number | null; done_at: number | null;
  due_at: number | null; waiting_at: number | null; result: string | null; ok: boolean | null; needs_ok: boolean; ask: string | null;
  approved: boolean; rejected: boolean; note: string | null; late: boolean; case_id: string | null; tools: string[];
  approved_by?: string; rejected_by?: string;
}
export interface Routine {
  id: string; kind: string; title: string; text: string; dept: PodId; agent: string; when: any; desc: string;
  needs_ok: boolean; paused: boolean; quiet: boolean; by: string; last: number | null; next_at: number | null;
  result: string | null; runs: number; last_op: string | null;
}
export interface Pod { id: PodId; name: string; blurb: string; lead: string }
export interface OfficeSnap {
  pods: Pod[]; connectors: Connector[]; kpis: Record<string, [string, string | number][]>; ops: Op[]; routines: Routine[];
  kinds: Record<string, { dept: PodId; agent: string; title: string; routine: boolean; help: string }>;
  llm: { enabled: boolean }; now: number;
  flow_waits: { run_id: string; node: string; flow: string; flow_id?: string; question: string; since: number; by: string }[];
}
export interface Interpretation {
  kind: "case" | "op" | "routine" | "error"; dept?: PodId; agent?: string; title?: string; op_kind?: string;
  when?: any; when_desc?: string; next_at?: number | null; needs_ok?: boolean; problem?: string | null; guessed?: string | null;
  intent?: string; confidence?: number; can?: string[];
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(apiBase() + path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const j = await r.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch { /* not json */ }
    throw new ApiError(r.status, msg);
  }
  return r.json() as Promise<T>;
}
const post = <T,>(p: string, b?: unknown) => req<T>(p, { method: "POST", body: b === undefined ? undefined : JSON.stringify(b) });

export const oapi = {
  snap: () => req<OfficeSnap>("/api/office"),
  interpret: (dept: string, text: string) => req<Interpretation>(`/api/office/interpret?dept=${dept}&text=${encodeURIComponent(text)}`),
  addTask: (b: { dept: string; text: string; customer_id?: string; channel?: string; at?: number; when?: any; needs_ok?: boolean }) =>
    post<{ kind: "case" | "op" | "routine"; case?: CaseSummary; op?: Op; routine?: Routine; guessed?: string }>("/api/office/tasks", { ...b, by: by() }),
  approveOp: (id: string) => post<Op>(`/api/office/ops/${id}/approve`, { by: by() }),
  rejectOp: (id: string, note: string) => post<Op>(`/api/office/ops/${id}/reject`, { note, by: by() }),
  decideFlow: (run: string, node: string, approve: boolean, note = "") =>
    post<any>(`/api/flows/runs/${run}/decide`, { node, approve, note, by: by() }),
  cancelOp: (id: string) => req<{ ok: boolean }>(`/api/office/ops/${id}`, { method: "DELETE" }),
  addRoutine: (b: { dept: string; text: string; when?: any; needs_ok?: boolean }) => post<{ routine: Routine }>("/api/office/routines", { ...b, by: by() }),
  routine: (id: string, action: "run" | "pause" | "resume") => post<{ routine: Routine; op?: Op }>(`/api/office/routines/${id}/${action}`),
  deleteRoutine: (id: string) => req<{ ok: boolean }>(`/api/office/routines/${id}`, { method: "DELETE" }),
  occurrences: (start: number, end: number) => req<Record<string, number[]>>(`/api/office/occurrences?start=${start}&end=${end}`),
  brain: () => req<{ nodes: { id: string; label: string; group: string; kind: string; props: any }[]; links: [number, number, string][]; groups: string[] }>("/api/office/brain"),
  chat: (agent: string, text: string) => post<{ reply: string; moved?: any; routine?: Routine }>("/api/office/chat", { agent, text, by: by() }),
  chats: () => req<Record<string, ServerMsg[]>>("/api/office/chats"),
  recent: (n = 800) => req<any[]>(`/api/events/recent?n=${n}`),
};

/** a message in the shared office chat, as the server keeps it */
export interface ServerMsg { id: number; agent: string; who: "user" | "agent" | "work"; text: string; by: string | null; icon: string | null; ref: string | null; ts: number }

// ── the office store ─────────────────────────────────────────────────────────
export interface ChatMsg { who: "agent" | "user" | "work"; text: string; ts: number; icon?: string; id?: number; by?: string | null; local?: boolean }
export interface FeedLine { icon: string; text: string; ts: number }
interface OState {
  snap: OfficeSnap | null;
  chats: Record<string, ChatMsg[]>;
  feeds: Record<string, FeedLine[]>;
  reads: Record<string, { agent: string; ts: number }>;
  rejecting: Record<string, { kind: "case" | "op" | "flow"; id: string }>; // agent → the item whose REJECT note comes next
  version: number;
}
let os: OState = { snap: null, chats: {}, feeds: {}, reads: {}, rejecting: {}, version: 0 };
const ls = new Set<() => void>();
export function getOffice() { return os; }
export function setOffice(p: Partial<OState> | ((s: OState) => Partial<OState>)) {
  os = { ...os, ...(typeof p === "function" ? p(os) : p), version: os.version + 1 };
  ls.forEach((l) => l());
}
export function useOffice<T>(sel: (s: OState) => T): T {
  return useSyncExternalStore((l) => { ls.add(l); return () => ls.delete(l); }, () => sel(os));
}

let snapTimer: ReturnType<typeof setTimeout> | null = null;
export async function refreshOffice() {
  try {
    setOffice({ snap: await oapi.snap() });
  } catch { /* the server is away; the page says so */ }
}
/** coalesce bursts of events into one snapshot fetch */
export function softRefreshOffice(ms = 300) {
  if (snapTimer) return;
  snapTimer = setTimeout(() => { snapTimer = null; void refreshOffice(); }, ms);
}

/** a note only this browser sees (a prompt, an error); the shared chat comes from the server */
export function say(agent: string, msg: Omit<ChatMsg, "ts">) {
  setOffice((s) => ({ chats: { ...s.chats, [agent]: [...(s.chats[agent] || []).slice(-120), { ...msg, ts: Date.now(), local: true }] } }));
}

const fromServer = (m: ServerMsg): ChatMsg => ({ id: m.id, who: m.who, text: m.text, ts: m.ts * 1000, by: m.by, icon: m.icon ?? undefined });

/** the shared chat for every agent (on opening the office) */
export async function loadChats() {
  try {
    const all = await oapi.chats();
    setOffice((s) => {
      const chats: Record<string, ChatMsg[]> = {};
      for (const [agent, msgs] of Object.entries(all)) chats[agent] = [...msgs.map(fromServer), ...(s.chats[agent] || []).filter((m) => m.local)];
      for (const [agent, msgs] of Object.entries(s.chats)) if (!chats[agent]) chats[agent] = msgs;
      return { chats };
    });
  } catch { /* the server is away */ }
}

/** one new message from anyone on the team */
export function heard(m: ServerMsg) {
  setOffice((s) => {
    const list = s.chats[m.agent] || [];
    if (list.some((x) => x.id === m.id)) return {};
    return { chats: { ...s.chats, [m.agent]: [...list.slice(-120), fromServer(m)] } };
  });
}
export function feed(agent: string, icon: string, text: string, ts = Date.now()) {
  setOffice((s) => ({ feeds: { ...s.feeds, [agent]: [{ icon, text, ts }, ...(s.feeds[agent] || [])].slice(0, 40) } }));
}

// ── cards ────────────────────────────────────────────────────────────────────
export type TState = "scheduled" | "next" | "doing" | "waiting" | "done";
export interface OTask {
  id: string; kind: "case" | "op" | "flow"; dept: PodId; agent: string; title: string; state: TState; progress: number;
  changedAt: number; addedAt: number; doneAt?: number; dueAt?: number; routine?: string | null; late?: boolean;
  approved?: boolean; ok?: boolean | null; route?: string | null; c?: CaseSummary; op?: Op;
  flow?: { run_id: string; node: string; flow: string; flow_id?: string; question: string; by: string };
}
const STEPS = ["intake", "understand", "evidence", "plan", "calibrate", "shadow", "route", "commit", "respond", "learn"];

export function caseTitle(c: CaseSummary) {
  const who = c.customer_name ? ` · ${c.customer_name}` : "";
  if (!c.intent) {
    const t = c.preview || c.id;
    return t.length > 70 ? t.slice(0, 68).replace(/\s+\S*$/, "") + "…" : t;
  }
  const amt = c.amount ? ` ${inr(c.amount)}` : "";
  return `${INTENT_LABEL[c.intent] ?? c.intent}${amt}${who}`;
}

export function deriveTasks(app: AppState | null, snap: OfficeSnap | null, podOf: (agent: string) => PodId): OTask[] {
  const out: OTask[] = [];
  for (const c of app?.cases ?? []) {
    const owner = (c as any).owner || c.specialist || "triage";
    const state: TState = c.status === "running" ? "doing" : c.pending ? "waiting" : "done";
    const i = STEPS.indexOf(c.step || "");
    const at = (c.updated_at || c.created_at) * 1000;
    out.push({
      id: c.id, kind: "case", dept: podOf(owner), agent: owner, title: caseTitle(c), state,
      progress: state === "done" ? 1 : i >= 0 ? (i + 1) / STEPS.length : 0.05,
      changedAt: at, addedAt: c.created_at * 1000, doneAt: state === "done" ? at : undefined, route: c.route, c,
      approved: false,
    });
  }
  for (const o of snap?.ops ?? []) {
    if (o.kind === "case" && o.state === "done") continue; // the case it opened carries on as its own card
    const at = (o.done_at || o.waiting_at || o.started_at || o.created_at) * 1000;
    out.push({
      id: o.id, kind: "op", dept: o.dept, agent: o.agent, title: o.title, state: o.state === "next" ? "doing" : o.state,
      progress: o.state === "done" ? 1 : o.state === "doing" ? 0.5 : 0, changedAt: at, addedAt: o.created_at * 1000,
      doneAt: o.done_at ? o.done_at * 1000 : undefined, dueAt: o.due_at ? o.due_at * 1000 : undefined,
      routine: o.routine, late: o.late, approved: o.approved, ok: o.ok, op: o,
    });
  }
  for (const w of snap?.flow_waits ?? []) {
    out.push({
      id: `${w.run_id}:${w.node}`, kind: "flow", dept: "oversight", agent: "human", title: `${w.flow}: ${w.question}`,
      state: "waiting", progress: 0.5, changedAt: w.since * 1000, addedAt: w.since * 1000, flow: w,
    });
  }
  return out.sort((a, b) => b.changedAt - a.changedAt);
}

/** who did it, when it was a person (routines, flows and the office itself are not) */
export function byWhom(t: OTask): string | null {
  const b = t.kind === "case" ? t.c?.opened_by : t.op?.by;
  return b && !["you", "routine", "system", "Nirnaya"].includes(b) ? b : null;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
