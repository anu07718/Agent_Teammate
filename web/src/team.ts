// Who you are to the rest of the team, and who else is here. Your name travels with everything you do
// (approvals, tasks, chat, flows), and the event stream tells the server you are online and on which view.
import { apiBase } from "./api";

export interface Person { client: string; name: string; color: string; since: number; last: number; view: string; focus: string | null }

const KEY = "nirnaya.me";

function load(): { client: string; name: string } {
  let saved: { client?: string; name?: string } = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { /* storage off */ }
  const client = saved.client || Math.random().toString(36).slice(2, 10);
  const name = saved.name || `Guest ${client.slice(0, 3).toUpperCase()}`;
  return { client, name };
}

let current = load();
try {
  const as = new URLSearchParams(location.search).get("as");
  if (as) current = { ...current, name: as.trim().slice(0, 32) || current.name };
  localStorage.setItem(KEY, JSON.stringify(current));
} catch { /* storage off */ }

/** you, for this browser (one id per browser, the name you chose) */
export function me() { return current; }
export const by = () => current.name;

export function setMyName(name: string) {
  const n = name.replace(/[<>]/g, "").trim().slice(0, 32);
  if (!n) return;
  current = { ...current, name: n };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* storage off */ }
  void tell({ name: n });
}

export function streamParams(view: string) {
  return `who=${encodeURIComponent(current.name)}&client=${encodeURIComponent(current.client)}&view=${encodeURIComponent(view)}`;
}

let last = "";
let timer: ReturnType<typeof setTimeout> | null = null;
/** tell the team where you are (debounced; the office passes the department you are looking at) */
export function tellView(view: string, focus: string | null = null) {
  const key = `${view}|${focus ?? ""}`;
  if (key === last) return;
  last = key;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tell({ view, focus }), 250);
}

async function tell(body: { name?: string; view?: string; focus?: string | null }) {
  try {
    await fetch(apiBase() + "/api/team/me", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: current.client, ...body }),
    });
  } catch { /* offline: the stream re-announces you when it reconnects */ }
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

const VIEW_NAME: Record<string, string> = {
  office: "Office", workspace: "Cases", approvals: "Approvals", flows: "Flows", supervisor: "Supervisor", brain: "Brain",
  ledger: "Ledger", benchmark: "Benchmark", trail: "Trail", settings: "Settings",
};
export const where = (p: Person) => `${VIEW_NAME[p.view] ?? p.view}${p.focus ? ` · ${p.focus}` : ""}`;
