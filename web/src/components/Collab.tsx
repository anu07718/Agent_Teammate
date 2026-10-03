// Working together across devices: the person+ button in both top bars opens Create / Join. Creating gives
// a code (your server hosts the workspace through the free relay database); anyone who enters it sees your
// agents live and can work with them from the website, the phone app or the Windows app.
import { Check, Copy, LogOut, RefreshCw, UserPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { accessKey, apiBase } from "../api";
import { nativeFetch } from "../net";
import { codeOk, join, joined, leave, learnServerRelay, normCode, relayUrl, setRelayUrl, showCode } from "../relay";
import { toast, useUI } from "../store";
import { initials, me } from "../team";
import { cx } from "./ui";
// the relay database's rules, built in so they can be copied from the dialog (no need to find the file)
import RULES from "../../../firebase/database.rules.json?raw";

interface Member { client: string; name: string; view: string; focus: string | null; via: string }
interface Hosting { code: string; display: string; name: string; since: number; connected: boolean; error: string | null; served: number; members: Member[] }
interface WS { relay_url: string; url_locked: boolean; hosting: Hosting | null }

/** this device's own server (not the host's, when you are in someone's workspace) */
async function own<T>(path: string, body?: unknown): Promise<T> {
  const k = accessKey();
  const r = await nativeFetch(apiBase() + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(k ? { "X-Nirnaya-Key": k } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("json")) throw new Error("no Nirnaya server here");
  const j = await r.json();
  if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : `error ${r.status}`);
  return j as T;
}

let ws: WS | null | undefined; // undefined: not asked yet; null: no server of our own
const subs = new Set<() => void>();
async function reload() {
  try { ws = await own<WS>("/api/workspace"); learnServerRelay(ws.relay_url); } catch { ws = null; }
  subs.forEach((f) => f());
}
function useWS(poll: number) {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    subs.add(f);
    if (ws === undefined) void reload();
    const h = setInterval(() => void reload(), poll);
    return () => { subs.delete(f); clearInterval(h); };
  }, [poll]);
  return ws;
}

const VIA: Record<string, string> = { web: "website", apk: "phone app", exe: "Windows app" };
const VIEW: Record<string, string> = { office: "Office", workspace: "Cases", approvals: "Approvals", channels: "Channels", flows: "Flows", supervisor: "Supervisor", settings: "Settings" };

/** copy text; on a plain-http page (a server on the LAN, the phone app) the clipboard API is often blocked */
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* try the old way */ }
  const t = document.createElement("textarea");
  t.value = text;
  t.style.position = "fixed"; t.style.opacity = "0";
  document.body.appendChild(t);
  t.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  t.remove();
  return ok;
}

function CopyBtn({ text, label, caption = "COPY" }: { text: string; label: string; caption?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="o-btn o-caps" aria-label={label} onClick={async () => {
      if (!(await copyText(text))) { toast("This browser blocked copying: select the text and copy it yourself", "warn"); return; }
      setDone(true); setTimeout(() => setDone(false), 1500);
    }}>{done ? <Check size={13} /> : <Copy size={13} />} {done ? "COPIED" : caption}</button>
  );
}

function Setup({ value, onChange, locked }: { value: string; onChange: (v: string) => void; locked: boolean }) {
  return (
    <div className="cw-setup">
      <label className="caps text-faint" htmlFor="cw-db">Relay database (free Firebase)</label>
      <input id="cw-db" className="cw-in" value={value} disabled={locked} onChange={(e) => onChange(e.target.value)}
        placeholder="https://your-project-default-rtdb.firebaseio.com" aria-label="Relay database address" />
      <details className="text-[11.5px] text-muted">
        <summary className="cursor-pointer">How to get one, free (about 5 minutes)</summary>
        <ol className="ml-4 mt-1 list-decimal space-y-0.5">
          <li>Open console.firebase.google.com and add a project (the free Spark plan; no card).</li>
          <li>Build → Realtime Database → Create database (any location, start in locked mode).</li>
          <li>Rules tab: delete everything there (Firebase's default <code>".read": false</code> rules are not enough), paste Nirnaya's rules and press <b>Publish</b>. <CopyBtn text={RULES} label="Copy the rules" caption="COPY THE RULES" />
            <details className="mt-1"><summary className="cursor-pointer">Show the rules</summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded border border-line p-2 text-[10.5px] select-all" data-testid="cw-rules">{RULES}</pre>
            </details></li>
          <li>Copy the address at the top of the Data tab and paste it here. Everyone uses the same one.</li>
        </ol>
      </details>
    </div>
  );
}

export function CollabDialog({ onClose, start = "create" }: { onClose: () => void; start?: "create" | "join" }) {
  const state = useWS(4000);
  const [tab, setTab] = useState<"create" | "join">(joined() ? "join" : start);
  const [name, setName] = useState(`${me().name}'s workspace`);
  const [db, setDb] = useState(relayUrl());
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (!db && relayUrl()) setDb(relayUrl()); }, [state, db]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const j = joined();
  const hosting = state?.hosting ?? null;
  const locked = !!state?.url_locked;
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const create = () => act(async () => {
    const url = db.trim();
    if (!url && !locked) throw new Error("Add the relay database address first.");
    if (url && !locked) setRelayUrl(url);
    ws = await own<WS>("/api/workspace/create", { url: locked ? null : url, name, by: me().name });
    subs.forEach((f) => f());
    toast(`Sharing: give people the code ${ws.hosting?.display}`, "good");
  });
  const doJoin = () => act(async () => {
    const c = normCode(code);
    if (!codeOk(c)) throw new Error("A code has 10 letters and digits, like K7QM2-XRP4T.");
    if (hosting && c === hosting.code) throw new Error("That is your own workspace: you are already in it.");
    const url = db.trim();
    if (url) setRelayUrl(url);
    await join(c, url || relayUrl());
  });
  return createPortal(
    <div className="cw-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={(e) => e.stopPropagation()}>
      <div className="cw" role="dialog" aria-label="Work together" data-testid="collab">
        <button className="cw-x" aria-label="Close" onClick={onClose}><X size={16} /></button>
        <div className="serif text-[26px] leading-none">WORK TOGETHER</div>
        <p className="mt-1.5 text-[12.5px] text-muted">Share your agents with your team, or join theirs. Works on the website, the phone app and the Windows app.</p>
        <div className="cw-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "create"} className={cx(tab === "create" && "on")} onClick={() => { setTab("create"); setErr(null); }}>Create a workspace</button>
          <button role="tab" aria-selected={tab === "join"} className={cx(tab === "join" && "on")} onClick={() => { setTab("join"); setErr(null); }}>Join a workspace</button>
        </div>

        {tab === "create" && (state === undefined ? <p className="text-muted">…</p> : state === null ? (
          <p className="cw-note" data-testid="no-server">Creating a workspace needs your agents running: open this in the Windows app, or on the computer
            that runs the Nirnaya server. You can still join someone else's here.</p>
        ) : hosting ? (
          <div data-testid="hosting">
            <p className="text-[12.5px] text-muted">People with this code see what your agents are doing, live, and can work with them: approve,
              reject, give tasks, run flows, answer customers. Only you can change keys and channel settings.</p>
            <div className="cw-code" data-testid="workspace-code">{hosting.display}</div>
            <div className="flex flex-wrap items-center gap-2">
              <CopyBtn text={hosting.display} label="Copy the code" />
              <span className={cx("o-live o-caps", !hosting.connected && "off")}><span className="o-dot" />{hosting.connected ? "SHARING" : "CONNECTING"}</span>
              <span className="caps text-faint">{hosting.name}</span>
            </div>
            {hosting.error && !hosting.connected && <p className="mt-2 text-[12px] text-escalate">{hosting.error}</p>}
            <div className="caps mt-4 text-faint">In your workspace now · {hosting.members.length}</div>
            <ul className="mt-1.5 space-y-1.5" data-testid="members">
              {hosting.members.length === 0 && <li className="text-[12.5px] text-muted">Nobody yet. Send them the code.</li>}
              {hosting.members.map((m) => (
                <li key={m.client} className="flex items-center gap-2 text-[12.5px]" data-member={m.name}>
                  <span className="cw-av">{initials(m.name)}</span><b>{m.name}</b>
                  <span className="text-muted">{VIEW[m.view] ?? m.view}{m.focus ? ` · ${m.focus}` : ""} · {VIA[m.via] ?? m.via}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="o-btn o-caps" disabled={busy} onClick={() => void act(async () => {
                if (!confirm("Make a new code? Everyone with the old one is shut out and needs the new one.")) return;
                ws = await own<WS>("/api/workspace/create", { url: null, name: hosting.name, by: me().name });
                subs.forEach((f) => f());
              })}><RefreshCw size={13} /> NEW CODE</button>
              <button className="o-btn o-caps" disabled={busy} onClick={() => void act(async () => {
                ws = await own<WS>("/api/workspace/stop", {});
                subs.forEach((f) => f());
                toast("Sharing stopped: the code no longer works", "info");
              })}>STOP SHARING</button>
            </div>
          </div>
        ) : (
          <div>
            <label className="caps text-faint" htmlFor="cw-name">Workspace name</label>
            <input id="cw-name" className="cw-in" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            <Setup value={locked ? state.relay_url : db} onChange={setDb} locked={locked} />
            <button className="o-btn dark o-caps mt-3" disabled={busy} onClick={() => void create()}><UserPlus size={13} /> CREATE A WORKSPACE</button>
          </div>
        ))}

        {tab === "join" && (j ? (
          <div data-testid="joined">
            <p className="text-[12.5px]">You are in <b>{j.name}</b>. Everything you see and do here is on their agents.</p>
            <div className="cw-code">{showCode(j.code)}</div>
            <button className="o-btn o-caps" onClick={() => void leave()}><LogOut size={13} /> LEAVE AND GO BACK</button>
          </div>
        ) : (
          <div>
            <label className="caps text-faint" htmlFor="cw-join">The code you were given</label>
            <input id="cw-join" className="cw-in cw-codein" value={code} autoFocus placeholder="K7QM2-XRP4T" maxLength={13} aria-label="Workspace code"
              onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === "Enter") void doJoin(); }} />
            {(!relayUrl() || db !== relayUrl()) && <Setup value={db} onChange={setDb} locked={false} />}
            <button className="o-btn dark o-caps mt-3" disabled={busy || !code.trim()} onClick={() => void doJoin()}>{busy ? "JOINING…" : "JOIN"}</button>
          </div>
        ))}
        {err && <p className="mt-3 text-[12.5px] text-escalate" role="alert" data-testid="collab-error">{err}</p>}
        {err && /refused|open to everyone/.test(err) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <CopyBtn text={RULES} label="Copy the rules" caption="COPY THE RULES" />
            <span>then Firebase → Realtime Database → Rules: replace everything with them, Publish, and try again.</span>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** the person+ tile: green while you share, ink while you are in someone else's workspace */
export function CollabButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const state = useWS(15000);
  const n = state?.hosting?.members.length ?? 0;
  const j = joined();
  return (
    <>
      <button className={cx("o-tile o-theme cw-btn", className, (state?.hosting || j) && "on")} aria-label="Work together"
        title={j ? `In ${j.name}` : state?.hosting ? `Sharing ${state.hosting.display} · ${n} in` : "Work together: create or join a workspace"}
        onClick={() => setOpen(true)} data-testid="collab-button">
        <UserPlus />
        {state?.hosting && <span className="cw-dot" data-testid="sharing-dot">{n || ""}</span>}
      </button>
      {open && <CollabDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/** in someone else's workspace: whose, and whether their server is answering */
export function JoinedPill({ className }: { className?: string }) {
  const host = useUI((s) => s.hostState);
  const connected = useUI((s) => s.connected);
  const [open, setOpen] = useState(false);
  const j = joined();
  if (!j) return null;
  const off = !connected && host;
  return (
    <>
      <button className={cx("o-btn o-caps", off ? "amber" : "dark", className)} onClick={() => setOpen(true)} data-testid="joined-pill"
        title={off ? `${j.name}: ${host === "closed" ? "the host stopped sharing" : "their server is not answering"}` : `You are in ${j.name}: everything here is their agents`}>
        <span className="max-w-[220px] truncate">{off ? (host === "closed" ? "WORKSPACE CLOSED" : `${j.name.toUpperCase()} · OFFLINE`) : `IN ${j.name.toUpperCase()}`}</span>
      </button>
      {open && <CollabDialog onClose={() => setOpen(false)} start="join" />}
    </>
  );
}
