export type Route = "ACT" | "HEDGE" | "ESCALATE" | "REFUSE";

export interface Agent {
  id: string;
  name: string;
  emoji: string;
  department: string;
  description: string;
  vibe: string;
  status: "idle" | "working" | "waiting";
  lead?: boolean;
  systems?: string[];
  case_id: string | null;
  doing: string | null;
  since: number;
  handled: number;
  log: { ts: number; case_id: string; doing: string }[];
}

export interface Department { id: string; name: string; blurb: string }

export interface Tool {
  name: string;
  system: string;
  description: string;
  kind: "read" | "write";
  moves_money: boolean;
  calls: number;
  last_ms: number;
  breaker: "closed" | "warning" | "open";
  fails: number;
}

export interface CaseSummary {
  id: string;
  customer_id: string;
  customer_name?: string;
  channel: string;
  status: "running" | "parked" | "resolved" | "refused";
  route: Route | null;
  intent: string | null;
  step: string | null;
  created_at: number;
  updated_at?: number;
  amount?: number | null;
  txn_id?: string | null;
  preview: string;
  specialist?: string | null;
  owner?: string;
  pending: boolean;
  seal_broken: boolean;
  first_reply_s?: number | null;
  opened_by?: string | null;
  approved_by?: string | null;
}

export interface Action {
  type: string;
  amount: number;
  txn_id: string | null;
  reason: string;
  evidence_agree: number;
  key?: string;
  instrument?: string;
  dispute_kind?: string;
}

export interface Threshold {
  lambda: number | null;
  acted?: number;
  error?: number | null;
  certified?: boolean;
  n?: number;
  n_needed?: number;
}

export interface Score {
  action: string;
  features: Record<string, number>;
  stated: number;
  calibrated: number;
  threshold: { band: string; alpha: number; act: Threshold; hedge: Threshold };
  route: Route;
  why: string;
}

export interface DecisionT {
  action: Action;
  route: Route | "REJECTED";
  why: string;
  score: number;
  committed: boolean;
  receipt?: Record<string, unknown>;
  undone?: boolean;
  approved_by?: string;
}

export interface TrailEntry {
  seq: number;
  ts: number;
  case_id: string;
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export interface CaseDetail extends CaseSummary {
  text?: string;
  pii?: { kind: string; token: string }[];
  conversation: { role: "customer" | "nirnaya" | "agent"; text: string; ts: number }[];
  supersteps: { name: string; agents: string[]; started: number; ended?: number; note: string }[];
  sentry?: { verdict: string; risk: number; reasons: { rule: string; detail: string }[]; latency_ms: number };
  understanding?: { intent: string; confidence: number; entities: Record<string, unknown>; source: string };
  match?: { txn_id: string | null; confidence: number; why: string[]; candidates: string[] };
  evidence?: {
    errors: string[];
    memory: { case_id: string; score: number; text: string; action: string; state: string; ground_moved: boolean }[];
    upi?: Record<string, unknown>;
    debit?: Record<string, unknown>;
    refund?: Record<string, unknown>;
    profile?: Record<string, unknown>;
    novelty?: number;
  };
  txn?: { id: string; amount: number; merchant: string; utr: string; created_at: number } | null;
  plan?: { specialist: string; txn_id: string | null; actions: Action[]; facts: string[] };
  scores?: Score[];
  shadow?: { baseline: string; diff: { field: string; before: unknown; after: unknown }[] } | null;
  recheck?: { ok: boolean; baseline: string; result: string; tries: { try: number; live: string; ok: boolean }[] };
  decisions: DecisionT[];
  pending: null | {
    actions: Action[];
    seal: string | null;
    recheck: Record<string, unknown> | null;
    shadow: { diff: { field: string; before: unknown; after: unknown }[] } | null;
    ledger_version: string | null;
    policy_hash: string;
    requested_at: number;
  } | any;
  seal_broken: any;
  guard?: { ok: boolean; violations: { kind: string; detail: string }[]; claims_checked: number };
  labels: { action: string; correct: boolean; source: string }[];
  checkpoints?: { id: string; prev_id: string | null; superstep: string; status: string; graph_hash: string; policy_hash: string; created_at: number }[];
  trail?: TrailEntry[];
  commits: { at: number; by: string; note?: string; edited?: boolean }[];
  error?: string;
}

export interface Stats {
  cases: number;
  done: number;
  by_route: Record<string, number>;
  autonomy: number;
  pending_approvals: number;
  avg_first_reply_s: number | null;
  cost_per_case: number | null;
  human_only_cost_per_case: number;
  labels: number;
  memory: Record<string, number>;
}

export interface Drift { psi: number; audit_error: number; window: number; alarm: boolean; reason: string | null; alpha_scale: number; rung_cap: number }

export interface Preset { id: string; customer: string; label: string; text: string }

export interface AppState {
  agents: Agent[];
  departments: Department[];
  tools: Tool[];
  cases: CaseSummary[];
  stats: Stats;
  customers: { id: string; name: string; segment: string }[];
  presets: Preset[];
  supersteps: string[];
  drift: Drift;
  policy_hash: string;
  integrations: Record<string, any>;
  waiting?: { cases: number; ops: number; flows: number };
}

export interface NEvent {
  id: number;
  ts: number;
  kind: string;
  [k: string]: any;
}
