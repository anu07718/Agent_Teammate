// The Flows API: flows the team draws, their runs, and the live pipeline of how the agents are working.
import { apiBase, ApiError } from "../api";
import { setState } from "../store";
import { by } from "../team";
import type { CaseSummary } from "../types";

export type NodeType = "start" | "case" | "task" | "if" | "approval" | "notify" | "wait";
export interface FNode { id: string; type: NodeType; x: number; y: number; config: Record<string, any> }
export interface FEdge { from: string; to: string; port: string }
export interface Flow {
  id: string; name: string; nodes: FNode[]; edges: FEdge[]; by: string; updated_by?: string; version: number;
  created_at: number; updated_at: number; when: any; when_desc: string; next_at: number | null; example?: boolean;
}
export type NState = "pending" | "running" | "waiting" | "done" | "failed" | "skipped";
export interface Run {
  id: string; flow_id: string; name: string; by: string; state: "running" | "waiting" | "done" | "failed" | "stopped";
  started_at: number; done_at: number | null; progress: number; total: number; result: string | null;
  nodes: Record<string, { state: NState; text: string; started_at: number | null; done_at: number | null; out: any }>;
  flow: { nodes: FNode[]; edges: FEdge[]; version: number };
}
export interface TypeSpec { label: string; group: string; icon: string; ports: string[]; help: string; config: Record<string, any> }
export interface FlowsData {
  flows: Flow[]; runs: Run[]; types: Record<NodeType, TypeSpec>; fields: Record<string, string>; ops: string[]; ops_for: Record<string, string[]>;
  task_depts: string[]; depts: { id: string; name: string }[]; customers: { id: string; name: string }[];
  can: Record<string, string[]>; waiting: { run_id: string; node: string; flow: string; flow_id?: string; question: string; since: number; by: string }[];
}
export interface Pipeline {
  steps: { name: string; i: number; agents: string[]; here: string[]; done: number; avg_ms: number | null }[];
  cases: (CaseSummary & { progress: number; passed: string[] })[];
  ops: Record<string, number>;
  runs: Run[];
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(apiBase() + path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j); } catch { /* not json */ }
    throw new ApiError(r.status, msg);
  }
  return r.json() as Promise<T>;
}
const send = <T,>(method: string, path: string, body?: unknown) => req<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export const fapi = {
  all: () => req<FlowsData>("/api/flows"),
  pipeline: () => req<Pipeline>("/api/flows/pipeline"),
  create: (f: { name: string; nodes: FNode[]; edges: FEdge[] }) => send<Flow>("POST", "/api/flows", { ...f, by: by() }),
  save: (id: string, f: { name: string; nodes: FNode[]; edges: FEdge[]; version: number }) => send<Flow>("PUT", `/api/flows/${id}`, { ...f, by: by() }),
  remove: (id: string) => send<{ ok: boolean }>("DELETE", `/api/flows/${id}?by=${encodeURIComponent(by())}`),
  run: (id: string) => send<Run>("POST", `/api/flows/${id}/run`, { by: by() }),
  decide: (run: string, node: string, approve: boolean, note = "") => send<Run>("POST", `/api/flows/runs/${run}/decide`, { node, approve, note, by: by() }),
  stop: (run: string) => send<Run>("POST", `/api/flows/runs/${run}/stop`, { by: by() }),
};

/** open Flows on this flow in the Builder, where its runs are drawn (from Approvals or the office) */
export function showFlow(id?: string | null) {
  try { if (id) { sessionStorage.setItem("nirnaya.flows.open", id); sessionStorage.setItem("nirnaya.flows.tab", "builder"); } } catch { /* storage off */ }
  setState({ view: "flows" });
}
