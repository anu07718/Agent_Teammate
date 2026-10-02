// Being in someone else's shared workspace. With a code, every /api/ request this app makes goes through the
// free Firebase Realtime Database to the host's server (which answers it from its own API) and their live
// events come back the same way, so every view works on their agents exactly as on yours. See
// backend/nirnaya/relay.py for the layout under /w/<code>.
import { nativeFetch } from "./net";
import { me } from "./team";

const JKEY = "nirnaya.joined";
const RKEY = "nirnaya.relay";

export interface Joined { code: string; url: string; name: string; since: number }

export const normCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const showCode = (c: string) => (c.length === 10 ? `${c.slice(0, 5)}-${c.slice(5)}` : c);
export const codeOk = (c: string) => /^[A-Z0-9]{10}$/.test(c);

let serverRelay = "";
/** the database address: one typed in Settings, else the one this device's server uses, else the build's */
export function relayUrl(): string {
  try {
    const saved = localStorage.getItem(RKEY);
    if (saved) return saved;
  } catch { /* storage off */ }
  return serverRelay || ((import.meta.env.VITE_NIRNAYA_RELAY as string | undefined) ?? "").replace(/\/$/, "");
}
export function setRelayUrl(u: string) {
  try { if (u) localStorage.setItem(RKEY, u.replace(/\/$/, "")); else localStorage.removeItem(RKEY); } catch { /* storage off */ }
}
export function learnServerRelay(u: string | undefined) { serverRelay = (u || "").replace(/\/$/, ""); }

let current: Joined | null = (() => {
  try { return JSON.parse(localStorage.getItem(JKEY) || "null"); } catch { return null; }
})();
export const joined = () => current;

/** a path under the database, keeping ?ns=… (the emulator) and any other query the address carries */
export function dbUrl(base: string, path: string): string {
  const u = new URL(base);
  const prefix = u.pathname.replace(/\/$/, "");
  return `${u.origin}${prefix}/${path.replace(/^\//, "")}.json${u.search}`;
}

async function db<T = unknown>(method: string, path: string, body?: unknown, base = current?.url ?? relayUrl()): Promise<T> {
  const r = await nativeFetch(dbUrl(base, path), { method, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 401 || r.status === 403) throw new Error("The database refused it: its rules need the ones in firebase/database.rules.json.");
  if (!r.ok) throw new Error(`The database answered ${r.status}.`);
  return r.json() as Promise<T>;
}

/** who hosts this code, or why you cannot join it */
export async function lookup(code: string, url = relayUrl()): Promise<{ name: string; ts: number; offline?: boolean }> {
  if (!url) throw new Error("Add the database address first (it comes from the person who set up Nirnaya's sharing).");
  if (!codeOk(code)) throw new Error("A code has 10 letters and digits, like K7QM2-XRP4T.");
  let host: { name: string; ts: number; offline?: boolean } | null;
  try { host = await db("GET", `w/${code}/host`, undefined, url); } catch (e) {
    throw new Error(`Can't reach the database: ${(e as Error).message}`);
  }
  if (!host) throw new Error("No workspace has that code. Check it with the person who shared it.");
  return host;
}

/** join: check the code, check the host answers, then reload into their workspace */
export async function join(code: string, url = relayUrl()) {
  const host = await lookup(code, url);
  if (host.offline) throw new Error(`${host.name} is offline right now: their Nirnaya server is not running.`);
  const candidate = { code, url, name: host.name, since: Date.now() };
  try {
    const r = await relayFetch("/api/health", { method: "GET" }, 12000, candidate);
    if (!r.ok) throw new Error();
  } catch {
    closeAnswers();
    throw new Error(`${host.name} did not answer: their Nirnaya server may be asleep or offline. Try again in a minute.`);
  }
  closeAnswers();
  try { localStorage.setItem(JKEY, JSON.stringify(candidate)); } catch { /* storage off */ }
  location.reload();
}

export async function leave() {
  if (current) {
    try { await db("DELETE", `w/${current.code}/members/${me().client}`); } catch { /* already gone */ }
  }
  current = null;
  try { localStorage.removeItem(JKEY); } catch { /* storage off */ }
  location.reload();
}

// ── requests and their answers ─────────────────────────────────────────────
const pending = new Map<string, { resolve: (r: Response) => void; timer: ReturnType<typeof setTimeout> }>();
let resStream: EventSource | null = null;
let resReady: Promise<void> | null = null;
const canInflate = typeof DecompressionStream !== "undefined";

async function inflate(b64: string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const out = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")));
  return new Uint8Array(await out.arrayBuffer());
}

async function bodyOf(d: { b?: string; x?: string; z?: string }): Promise<BodyInit> {
  if (d.z) return new Blob([await inflate(d.z)]);
  if (d.x) return new Blob([Uint8Array.from(atob(d.x), (c) => c.charCodeAt(0))]);
  return d.b ?? "";
}

function settle(j: Joined, rid: string, d: { s: number; t?: string; b?: string; x?: string; z?: string } | null) {
  const p = pending.get(rid);
  if (!p || !d || typeof d.s !== "number") return;
  pending.delete(rid);
  clearTimeout(p.timer);
  void bodyOf(d).then((body) => p.resolve(new Response(d.s === 204 ? null : body, { status: d.s, headers: { "Content-Type": d.t || "application/json" } })));
  void db("DELETE", `w/${j.code}/res/${me().client}/${rid}`, undefined, j.url).catch(() => undefined);
}

/** the database streams a write as "put" (one path) or "patch" (several children at once, as the host answers) */
function onTree(es: EventSource, fn: (path: string, data: any, kind: "put" | "patch") => void) {
  for (const kind of ["put", "patch"] as const) {
    es.addEventListener(kind, (m) => {
      try { const { path, data } = JSON.parse((m as MessageEvent).data); fn(path, data, kind); } catch { /* not ours */ }
    });
  }
}

function openAnswers(j: Joined): Promise<void> {
  if (resReady) return resReady;
  resReady = new Promise((ready) => {
    resStream = new EventSource(dbUrl(j.url, `w/${j.code}/res/${me().client}`));
    onTree(resStream, (path, data, kind) => {
      if (path === "/") {
        Object.entries(data || {}).forEach(([rid, d]) => settle(j, rid, d as never));
        if (kind === "put") ready();
      } else settle(j, path.slice(1).split("/")[0], data);
    });
    resStream.onerror = () => { /* EventSource reconnects by itself; answers sent meanwhile come in its first put */ };
    setTimeout(ready, 4000);
  });
  return resReady;
}

function closeAnswers() {
  resStream?.close();
  resStream = null;
  resReady = null;
}

const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

/** fetch(), through the workspace's host */
export async function relayFetch(input: RequestInfo | URL, init?: RequestInit, timeoutMs = 45000, to: Joined | null = current): Promise<Response> {
  const j = to;
  if (!j) throw new Error("not in a shared workspace");
  const req = new Request(typeof input === "string" && !/^https?:/.test(input) ? new URL(input, "http://relay.invalid").href : input, init);
  const u = new URL(req.url);
  const path = u.pathname.slice(u.pathname.indexOf("/api/")) + u.search;
  const ct = req.headers.get("Content-Type") || "";
  let body: { b?: string; x?: string } = {};
  if (!["GET", "HEAD"].includes(req.method)) {
    const buf = new Uint8Array(await req.arrayBuffer());
    if (/json|text|urlencoded/.test(ct) || !ct) body = { b: new TextDecoder().decode(buf) };
    else { let s = ""; buf.forEach((c) => { s += String.fromCharCode(c); }); body = { x: btoa(s) }; }
  }
  await openAnswers(j);
  const id = rid();
  const answer = new Promise<Response>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(new Response(JSON.stringify({ detail: `${j.name} did not answer in time: their server may be offline.` }),
        { status: 504, headers: { "Content-Type": "application/json" } }));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
  });
  await db("PUT", `w/${j.code}/req/${id}`, {
    c: me().client, m: req.method, p: path, ...(ct ? { h: { ct } } : {}), ...body, ...(canInflate ? { za: 1 } : {}),
    who: me().name, ts: { ".sv": "timestamp" },
  }, j.url);
  return answer;
}

// ── the host's live events, and whether the host is still there ────────────
export function relayEvents(onEvent: (ev: any) => void, onState: (connected: boolean, why?: string) => void): () => void {
  const j = current!;
  let last = -1;
  const decode = async (slot: { n: number; b?: string; z?: string }) => {
    const raw = slot.z ? new TextDecoder().decode(await inflate(slot.z)) : slot.b ?? "[]";
    return JSON.parse(raw) as any[];
  };
  const es = new EventSource(dbUrl(j.url, `w/${j.code}/ev`));
  let chain = Promise.resolve();
  let first = true;
  onTree(es, (path, data) => {
    chain = chain.then(async () => {
      const slots = (path === "/" ? Object.values(data || {}) : [data]) as { n: number; b?: string; z?: string }[];
      if (first && path === "/") {  // the ring as it is now: only note where it has got to
        first = false;
        last = Math.max(last, ...slots.map((s) => s?.n ?? -1));
        onState(true);
        return;
      }
      for (const slot of slots.filter((s) => s && typeof s.n === "number" && s.n > last).sort((a, b) => a.n - b.n)) {
        last = slot.n;
        for (const ev of await decode(slot)) onEvent(ev);
      }
    }).catch(() => undefined);
  });
  es.onerror = () => onState(false, "reconnecting");
  // the heartbeat: the host writes every 15 s; no change for 45 s means it has stopped
  let seen = 0, changed = Date.now();
  const beat = setInterval(async () => {
    try {
      const h = await db<{ ts: number; offline?: boolean } | null>("GET", `w/${j.code}/host`);
      if (!h) { onState(false, "closed"); return; }
      if (h.ts !== seen) { seen = h.ts; changed = Date.now(); }
      onState(!h.offline && Date.now() - changed < 45000, h.offline ? "offline" : undefined);
    } catch { onState(false, "unreachable"); }
  }, 15000);
  return () => { es.close(); clearInterval(beat); };
}

// ── your presence in their office ──────────────────────────────────────────
let presence = { view: "office", focus: null as string | null };
let beatTimer: ReturnType<typeof setInterval> | null = null;
// which app you are in, for the host's member list: the Windows window opens the page with ?app=exe
try { if (new URLSearchParams(location.search).get("app") === "exe") sessionStorage.setItem("nirnaya.app", "exe"); } catch { /* storage off */ }
const via = () => {
  if ((window as any).Capacitor?.isNativePlatform?.()) return "apk";
  try { if (sessionStorage.getItem("nirnaya.app") === "exe") return "exe"; } catch { /* storage off */ }
  return "web";
};
function announce() {
  const j = current;
  if (!j) return;
  void db("PUT", `w/${j.code}/members/${me().client}`, { name: me().name, view: presence.view, focus: presence.focus, via: via(), ts: { ".sv": "timestamp" } }).catch(() => undefined);
}
export function relayPresence(p: { view?: string; focus?: string | null; name?: string }) {
  presence = { view: p.view ?? presence.view, focus: p.focus !== undefined ? p.focus : presence.focus };
  announce();
  if (!beatTimer) beatTimer = setInterval(announce, 20000);
}
