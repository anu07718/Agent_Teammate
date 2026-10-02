import { nativeFetch } from "./net";
import { joined, relayFetch } from "./relay";
import { by } from "./team";
import type { AppState, CaseDetail } from "./types";

const KEY = "nirnaya.server";

/** Where the API lives. Same origin when served by the backend; overridable for the mobile and desktop builds. */
export function apiBase(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved.replace(/\/$/, "");
  } catch {
    /* storage unavailable */
  }
  const env = (import.meta.env.VITE_API as string | undefined) ?? "";
  return env.replace(/\/$/, "");
}

export function setApiBase(url: string) {
  try {
    if (url) localStorage.setItem(KEY, url);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

// ── the access key (a server on the internet started with NIRNAYA_ACCESS_KEY asks for it) ──
const AKEY = "nirnaya.key";
export function accessKey(): string {
  try { return localStorage.getItem(AKEY) || ""; } catch { return ""; }
}
export function setAccessKey(k: string) {
  try { if (k) localStorage.setItem(AKEY, k); else localStorage.removeItem(AKEY); } catch { /* storage unavailable */ }
  // a cookie too, so links (the packet, the .xlsx) and the live stream carry it on the same origin
  document.cookie = `nirnaya_key=${encodeURIComponent(k)}; path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}${k ? "" : "; max-age=0"}`;
}
/** ?key=… for URLs the browser opens itself (links, EventSource), when a key is set */
export function withKey(url: string): string {
  const k = accessKey();
  return k ? `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(k)}` : url;
}
// every fetch to the API carries the key, and goes to the host while you are in someone's shared workspace:
// one wrapper instead of a change at every call site
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const k = accessKey();
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (joined() && /\/api\//.test(url)) return relayFetch(input, init);
  if (!k || !/\/api\/|\/mcp$/.test(url)) return nativeFetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("X-Nirnaya-Key", k);
  return nativeFetch(input, { ...init, headers });
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public keyRequired = false) {
    super(message);
  }
}

export async function apiReq<T>(path: string, init?: RequestInit): Promise<T> {
  return req<T>(path, init);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(apiBase() + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) {
    let msg = r.statusText;
    let keyRequired = false;
    try {
      const j = await r.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
      keyRequired = !!j.key_required;
    } catch {
      /* not json */
    }
    throw new ApiError(r.status, msg, keyRequired);
  }
  return r.json() as Promise<T>;
}

const post = <T,>(path: string, body?: unknown) => req<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });

export const api = {
  state: () => req<AppState>("/api/state"),
  health: () => req<{ ok: boolean; version: string; llm: boolean; policy_hash: string }>("/api/health"),
  caseDetail: (id: string) => req<CaseDetail>(`/api/cases/${id}`),
  createCase: (customer_id: string, message: string, channel: string) =>
    post<{ id: string }>("/api/cases", { customer_id, message, channel, by: by() }),
  approve: (id: string, edits?: Record<string, number>, note = "") =>
    post<CaseDetail>(`/api/cases/${id}/approve`, { by: by(), note, edits: edits ?? null }),
  reject: (id: string, note = "") => post<CaseDetail>(`/api/cases/${id}/reject`, { by: by(), note }),
  undo: (id: string) => post<CaseDetail>(`/api/cases/${id}/undo`, { by: by() }),
  audit: (id: string, correct: boolean) => post<CaseDetail>(`/api/cases/${id}/audit?correct=${correct}&by=${encodeURIComponent(by())}`),
  approvals: () => req<any[]>("/api/approvals"),
  supervisor: () => req<any>("/api/supervisor"),
  setPolicy: (action: string, patch: { alpha?: number; rung?: number }) => post<any>("/api/supervisor/policy", { action, ...patch, by: by() }),
  recalibrate: () => post<any>("/api/supervisor/recalibrate"),
  injectDrift: () => post<any>("/api/supervisor/drift/inject"),
  clearDrift: () => post<any>("/api/supervisor/drift/clear"),
  runRoutine: (id: string) => post<any>(`/api/routines/${id}/run`),
  trail: (limit = 300) => req<any[]>(`/api/trail?limit=${limit}`),
  verify: (tamper?: number) => req<any>(`/api/trail/verify${tamper ? `?tamper_seq=${tamper}` : ""}`),
  graph: () => req<{ nodes: any[]; edges: any[] }>("/api/graph"),
  graphNode: (id: string) => req<{ nodes: any[]; edges: any[] }>(`/api/graph/node/${encodeURIComponent(id)}`),
  memory: (q: string) => req<any[]>(`/api/memory/search?q=${encodeURIComponent(q)}`),
  ledger: () => req<any>("/api/ledger"),
  railEvent: (txn_id: string, event: string) => post<any>("/api/sim/rail-event", { txn_id, event }),
  outage: (system: string, down: boolean) => post<any>(`/api/sim/outage?system=${encodeURIComponent(system)}&down=${down}`),
  resetWorld: () => post<any>("/api/sim/reset"),
  restart: () => post<{ resumed: string[]; parked: string[] }>("/api/system/restart"),
  runBenchmark: (k: number) => post<any>(`/api/benchmark/run?k=${k}`),
  benchmarkRuns: () => req<any[]>("/api/benchmark/runs"),
  ask: (agent: string, question: string) => post<{ answer: string; llm: boolean }>(`/api/agents/${agent}/ask`, { question }),
  parseEvidence: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(apiBase() + "/api/evidence/parse", { method: "POST", body: fd });
    if (!r.ok) throw new ApiError(r.status, r.statusText);
    return r.json();
  },
  exportUrl: (id: string) => withKey(`${apiBase()}/api/cases/${id}/export.xlsx`),
  previewUrl: (id: string) => withKey(`${apiBase()}/api/cases/${id}/export.html`),
  eventsUrl: () => withKey(`${apiBase()}/api/events`),
};

/** a link to a file the API makes (the packet, the .xlsx): opened through the host in a shared workspace */
export function apiLink(url: string, download?: string) {
  if (!joined()) return { href: url };
  return {
    href: url,
    onClick: async (e: { preventDefault: () => void }) => {
      e.preventDefault();
      const win = download ? null : window.open("", "_blank");
      const r = await fetch(url);
      const blob = URL.createObjectURL(await r.blob());
      if (download) {
        const a = document.createElement("a");
        a.href = blob; a.download = download; a.click();
      } else if (win) win.location.href = blob;
      setTimeout(() => URL.revokeObjectURL(blob), 60_000);
    },
  };
}
