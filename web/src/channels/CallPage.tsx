// The call page (/call): a customer talks to Nirnaya from Chrome or Edge, on a phone or a computer, with no
// phone line and no account. The browser turns speech into text and reads the answer aloud (the Web Speech
// API, free in these browsers); Nirnaya sees text, so a call here is handled exactly like a phone call.
// Where the browser cannot listen, the same page is a chat. With "Record this call" on, the page records the
// microphone (echo cancellation off, so on a loudspeaker it hears the agent too) and sends it when the call ends,
// to keep with the call's report.
import { Mic, MicOff, PhoneCall, PhoneOff, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { capi } from "./api";

type Line = { who: "you" | "nirnaya" | "note"; text: string; case_id?: string | null };
type Phase = "idle" | "listening" | "thinking" | "speaking" | "ended";

const SR: any = typeof window !== "undefined" ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
const LANGS: [string, string][] = [["en-IN", "English (India)"], ["hi-IN", "हिन्दी / Hinglish"], ["en-US", "English (US)"], ["en-GB", "English (UK)"]];

export function CallPage() {
  const [customers, setCustomers] = useState<{ id: string; name: string }[] | null>(null);
  const [who, setWho] = useState("");
  const [lang, setLang] = useState("en-IN");
  const [session, setSession] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [heard, setHeard] = useState("");
  const [typed, setTyped] = useState("");
  const [muted, setMuted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [record, setRecord] = useState(true);
  const [recording, setRecording] = useState(false);
  const rec = useRef<any>(null);
  const tape = useRef<{ mr: MediaRecorder; chunks: Blob[]; stream: MediaStream; t0: number } | null>(null);
  const live = useRef({ session: null as string | null, phase: "idle" as Phase, muted: false, voice: !!SR });
  const box = useRef<HTMLDivElement>(null);
  live.current.session = session;
  live.current.phase = phase;
  live.current.muted = muted;

  useEffect(() => { document.title = "Talk to Nirnaya"; capi.webCustomers().then((c) => { setCustomers(c); setWho(c[0]?.id ?? ""); }).catch((e) => { setCustomers([]); setErr(e.message); }); }, []);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" }); }, [lines.length, heard]);
  useEffect(() => () => { try { rec.current?.abort(); } catch { /* not listening */ } window.speechSynthesis?.cancel(); tape.current?.stream.getTracks().forEach((t) => t.stop()); }, []);

  // the call's recording: one MediaRecorder for the whole call, sent when it ends
  const startTape = async () => {
    if (!record || typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported?.(t));
      const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.start(1000);
      tape.current = { mr, chunks, stream, t0: Date.now() };
      setRecording(true);
    } catch { setRecording(false); /* no microphone or not allowed: the call goes on unrecorded */ }
  };
  const stopTape = (s: string | null) => new Promise<void>((done) => {
    const t = tape.current;
    tape.current = null;
    setRecording(false);
    if (!t) { done(); return; }
    t.mr.onstop = async () => {
      t.stream.getTracks().forEach((x) => x.stop());
      const blob = new Blob(t.chunks, { type: t.mr.mimeType || "audio/webm" });
      if (s && blob.size) await capi.webRecording(s, blob, (Date.now() - t.t0) / 1000).catch(() => {});
      done();
    };
    try { t.mr.stop(); } catch { done(); }
  });

  const say = (text: string, then: () => void) => {
    const synth = window.speechSynthesis;
    if (!synth || !live.current.voice) { then(); return; }
    setPhase("speaking");
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const v = synth.getVoices().find((x) => x.lang === lang) ?? synth.getVoices().find((x) => x.lang?.startsWith(lang.split("-")[0]));
    if (v) u.voice = v;
    u.onend = () => then();
    u.onerror = () => then();
    synth.speak(u);
  };

  const listen = () => {
    if (!SR || !live.current.voice || live.current.muted || !live.current.session || live.current.phase === "ended") { setPhase((p) => (p === "ended" ? p : "idle")); return; }
    const r = new SR();
    rec.current = r;
    r.lang = lang;
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let final = "", over = false;
    r.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      setHeard(final || interim);
    };
    r.onerror = (e: any) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        live.current.voice = false;
        setErr("The microphone is blocked, so this is a chat now: type below. (Allow the microphone in the address bar to talk.)");
      }
    };
    r.onend = () => {
      if (over) return; // once per recognizer: what it heard is handled once
      over = true;
      if (rec.current === r) rec.current = null;
      setHeard("");
      if (final.trim()) void turn(final.trim(), "voice");
      else if (live.current.session && live.current.phase === "listening") setTimeout(listen, 250);
    };
    setPhase("listening");
    try { r.start(); } catch { /* already started */ }
  };

  const turn = async (text: string, mode: "voice" | "text") => {
    const s = live.current.session;
    if (!s) return;
    setLines((l) => [...l, { who: "you", text }]);
    setPhase("thinking");
    try {
      const r = await capi.webTurn(s, text, mode, lang.startsWith("hi") ? "hi" : "en");
      setLines((l) => [...l, { who: "nirnaya", text: r.reply, case_id: r.case_id }]);
      say(r.reply, () => { if (r.end) void hangUp(true); else listen(); });
    } catch (e) {
      setLines((l) => [...l, { who: "note", text: (e as Error).message }]);
      setPhase("idle");
    }
  };

  const start = async () => {
    setErr(null);
    setLines([]);
    try {
      const r = await capi.webStart(who || null, lang.startsWith("hi") ? "hi" : "en");
      setSession(r.session);
      live.current.session = r.session;
      setLines([{ who: "nirnaya", text: r.greeting }]);
      await startTape();
      say(r.greeting, listen);
    } catch (e) { setErr((e as Error).message); }
  };

  const hangUp = async (byAgent = false) => {
    const s = live.current.session;
    try { rec.current?.abort(); } catch { /* not listening */ }
    window.speechSynthesis?.cancel();
    setPhase("ended");
    live.current.phase = "ended";
    await stopTape(s);
    if (s) await capi.webEnd(s).catch(() => {});
    setSession(null);
    live.current.session = null;
    setLines((l) => [...l, { who: "note", text: byAgent ? "The call has ended." : "You ended the call." }]);
  };

  const inCall = !!session;
  const canTalk = !!SR && live.current.voice;
  const status = { idle: inCall ? (canTalk && !muted ? "Your turn" : "Type your message") : "", listening: "Listening…", thinking: "Checking…", speaking: "Speaking…", ended: "Call ended" }[phase];
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <div className="mx-auto flex min-h-dvh max-w-xl flex-col px-4 py-6">
        <header className="mb-4 flex items-center gap-3">
          <span className="serif grid h-10 w-10 shrink-0 place-items-center rounded-full bg-fg text-[22px] text-bg">N</span>
          <div>
            <h1 className="page-title text-[26px]">Talk to Nirnaya</h1>
            <p className="text-[12.5px] text-muted">Payment support: failed UPI debits, refunds, duplicate charges, unauthorised payments.</p>
          </div>
        </header>

        {!inCall && (
          <div className="shadow-card space-y-3 rounded-xl border border-line bg-panel p-4" data-testid="call-setup">
            <label className="block text-[12.5px]"><span className="mb-1 block caps text-faint">Who is calling (a demo customer)</span>
              <select aria-label="Who is calling" value={who} onChange={(e) => setWho(e.target.value)} className="h-10 w-full rounded-md border border-line-strong bg-panel-2 px-2.5">
                {(customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.id}</option>)}
                <option value="">Someone new (the agent asks who you are)</option>
              </select>
            </label>
            <label className="block text-[12.5px]"><span className="mb-1 block caps text-faint">Language</span>
              <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)} className="h-10 w-full rounded-md border border-line-strong bg-panel-2 px-2.5">
                {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-[12.5px]">
              <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} aria-label="Record this call" />
              Record this call (kept with the call's report; use the loudspeaker so the agent's voice is on it too)
            </label>
            <button onClick={() => void start()} disabled={customers === null} className="flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-act text-[12px] font-semibold uppercase tracking-[0.16em] text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-50">
              <PhoneCall size={18} /> {SR ? "Start the call" : "Start the chat"}
            </button>
            {!SR && <p className="text-[12px] text-muted">This browser can't listen (try Chrome or Edge to talk), so you can type instead.</p>}
            {phase === "ended" && <p className="text-[12px] text-faint">The last call has ended. Start another any time.</p>}
          </div>
        )}

        {err && <p className="mt-3 rounded-md border border-hedge/40 bg-hedge/10 px-3 py-2 text-[12.5px]" role="alert">{err}</p>}

        {(inCall || lines.length > 0) && (
          <div ref={box} className="mt-4 flex-1 space-y-2 overflow-y-auto" data-testid="transcript">
            {lines.map((l, i) => l.who === "note" ? (
              <div key={i} className="text-center text-[11.5px] text-faint">{l.text}</div>
            ) : (
              <div key={i} className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed ${l.who === "you" ? "ml-auto bg-fg text-bg" : "bg-panel-2"}`} data-who={l.who}>
                {l.text}
                {l.case_id && <div className="mt-0.5 text-[10.5px] opacity-70">case {l.case_id}</div>}
              </div>
            ))}
            {heard && <div className="ml-auto max-w-[85%] rounded-2xl bg-fg/15 px-3.5 py-2 text-[14px] italic">{heard}…</div>}
          </div>
        )}

        {inCall && (
          <div className="sticky bottom-0 mt-3 space-y-2 bg-bg pb-1 pt-2">
            <div className="flex items-center justify-center gap-2 text-[12.5px] text-muted" data-testid="call-status">
              {phase === "listening" && <span className="h-2 w-2 animate-pulse rounded-full bg-escalate" />}{status}
              {recording && <span className="ml-2 rounded-full border border-escalate/40 px-2 text-[11px] text-escalate" data-testid="call-recording">● REC</span>}
            </div>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (typed.trim() && phase !== "thinking") { try { rec.current?.abort(); } catch { /* */ } const t = typed.trim(); setTyped(""); void turn(t, "text"); } }}>
              <input aria-label="Type a message" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type here…" className="h-11 flex-1 rounded-full border border-line-strong bg-panel-2 px-4 text-[14px]" />
              <button type="submit" aria-label="Send" disabled={!typed.trim() || phase === "thinking"} className="grid h-11 w-11 cursor-pointer place-items-center rounded-full bg-fg text-bg disabled:opacity-40"><Send size={16} /></button>
            </form>
            <div className="flex justify-center gap-3">
              {canTalk && (
                <button aria-label={muted ? "Unmute" : "Mute"} onClick={() => { const m = !muted; setMuted(m); live.current.muted = m; if (m) { try { rec.current?.abort(); } catch { /* */ } setPhase("idle"); } else if (phase === "idle") listen(); }}
                  className="grid h-12 w-12 cursor-pointer place-items-center rounded-full border border-line-strong bg-panel">{muted ? <MicOff size={18} /> : <Mic size={18} />}</button>
              )}
              <button aria-label="End call" onClick={() => void hangUp()} className="flex h-12 cursor-pointer items-center gap-2 rounded-full bg-escalate px-5 font-semibold text-white"><PhoneOff size={18} /> End</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
