// The Task Status panel: a command bar that sends a sentence to a department (a customer message, a
// task, a routine), the office reads it back before you press Add, and a live feed of every card.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState } from "../types";
import { dayTime, span, timeStr, until } from "./bits";
import { byWhom, esc, oapi, refreshOffice, type Interpretation, type OfficeSnap, type OTask, type Routine, type TState } from "./data";
import { POD_IDS, POD_STYLE, type PodId } from "./layout";

const CASE_PODS: PodId[] = ["intake", "resolution"];
const EXAMPLES: Record<PodId, string[]> = {
  intake: [], resolution: [],
  verification: ["Check T-5001", "Pull the evidence for T-5006"],
  decision: ["Run the benchmark", "List the certified thresholds", "Score refund_duplicate 349", "Recalibrate"],
  commit: ["Undo NR-1002", "check: ₹500 will be credited in 2 hours, guaranteed"],
  oversight: ["Verify the audit trail", "Tamper test on the audit trail", "Check for drift", "Write today's digest"],
};
const CADENCES: [string, string][] = [["weekdays", "Every weekday"], ["daily", "Every day"], ["0", "Mondays"], ["1", "Tuesdays"],
  ["2", "Wednesdays"], ["3", "Thursdays"], ["4", "Fridays"], ["5", "Saturdays"], ["6", "Sundays"], ["hourly", "Every hour, 9–5, weekdays"], ["m5", "Every 5 minutes"]];
const CHANNELS = ["chat", "whatsapp", "email", "voice", "app"];

export function pickerWhen(cad: string, at: string) {
  if (cad === "hourly") return { kind: "hourly", every: 1, from: "09:00", to: "17:00", weekdays_only: true };
  if (cad === "m5") return { kind: "minutes", every: 5 };
  if (cad === "weekdays" || cad === "daily") return { kind: cad, at };
  return { kind: "weekly", days: [Number(cad)], at };
}

interface Props {
  app: AppState | null;
  snap: OfficeSnap | null;
  tasks: OTask[];
  connected: boolean;
  dept: PodId;
  setDept: (d: PodId) => void;
  text: string;
  setText: (t: string) => void;
  focused: PodId | "brain" | null;
  nameOf: (agent: string) => string;
  podOf: (agent: string) => PodId;
  openBig: () => void;
  onRow: (t: OTask) => void;
  onCalendar: () => void;
  submitRef: React.MutableRefObject<(() => void) | null>;
  width: number;
}

export function Panel(p: Props) {
  const { app, snap, tasks, dept } = p;
  const [menu, setMenu] = useState(false);
  const [customer, setCustomer] = useState("C-1001");
  const [channel, setChannel] = useState("chat");
  const [repeat, setRepeat] = useState(false);
  const [cad, setCad] = useState("weekdays");
  const [at, setAt] = useState("09:00");
  const [needsOk, setNeedsOk] = useState(false);
  const [samples, setSamples] = useState(false);
  const [hint, setHint] = useState<Interpretation | null>(null);
  const [said, setSaid] = useState<{ html: string; tone?: "err" | "busy" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "sched" | TState>("all");
  const [min, setMin] = useState(false);
  const inRef = useRef<HTMLTextAreaElement>(null);
  const seen = useRef(new Set<string>());
  const isCase = CASE_PODS.includes(dept);
  const panelRef = useRef<HTMLDivElement>(null);

  // a menu that is open closes on Escape or on a click anywhere outside it
  useEffect(() => {
    if (!menu && !samples) return;
    const close = () => { setMenu(false); setSamples(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.(".o-menu, .o-dd, .o-mini")) close(); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("mousedown", onDown); };
  }, [menu, samples]);

  // what the office will do with this sentence, read back as you type
  useEffect(() => {
    const t = p.text.trim();
    if (!t) { setHint(null); return; }
    const h = setTimeout(async () => {
      try {
        setHint(await oapi.interpret(dept, t));
      } catch { setHint(null); }
    }, 220);
    return () => clearTimeout(h);
  }, [p.text, dept, repeat]);

  useEffect(() => {
    const el = inRef.current;
    if (!el) return;
    el.style.height = "30px";
    el.style.height = Math.min(118, Math.max(30, el.scrollHeight)) + "px";
  }, [p.text]);

  const submit = async () => {
    const text = p.text.trim().replace(/[.!]+$/, "");
    if (!text || busy) return;
    setBusy(true);
    const outreach = hint?.kind === "outreach";
    setSaid({ html: outreach ? `Handing it to the desks — <b>Sentry</b> screens it first…` : isCase ? `Opening a case — <b>Sentry</b> screens it first…` : `Handing it to ${POD_STYLE[dept].name.toLowerCase()}…`, tone: "busy" });
    try {
      const body: any = { dept, text: text[0].toUpperCase() + text.slice(1) };
      if (isCase) Object.assign(body, { customer_id: customer, channel });
      if (repeat) Object.assign(body, { when: pickerWhen(cad, at), needs_ok: needsOk });
      const r = await oapi.addTask(body);
      const tok = r.tokens ? ` · ${r.tokens.prompt} token${r.tokens.prompt === 1 ? "" : "s"} in${r.tokens.read ? `, ${r.tokens.read} to read it` : ""}` : "";
      p.setText("");
      setRepeat(false);
      if (r.kind === "case" && r.case) setSaid({ html: `Added — <b>${r.case.id}</b> is with <b>Sentry</b>; triage names the desk in a moment${tok}.` });
      else if (r.kind === "routine" && r.routine) setSaid({ html: `Routine set — <b>${p.nameOf(r.routine.agent)}</b> · ${r.routine.desc} · next ${until(r.routine.next_at)}${r.routine.needs_ok ? " · waits for your OK" : ""}` });
      else if (r.op && r.op.kind === "outreach") setSaid({ html: r.op.state === "scheduled" ? `Booked — <b>${r.op.id}</b> runs ${dayTime(r.op.due_at! * 1000)}${tok}` : `On it as <b>${r.op.id}</b>${r.op.needs_ok ? " — it will wait for your OK before any money moves" : ""}${tok}.` });
      else if (r.op) setSaid({ html: r.op.state === "scheduled" ? `Booked — <b>${p.nameOf(r.op.agent)}</b> runs it ${dayTime(r.op.due_at! * 1000)}` : `Added — <b>${p.nameOf(r.op.agent)}</b> has it${r.op.needs_ok ? " and will ask for your OK" : ""}.` });
      if (r.kind === "routine") setFilter("sched");
      void refreshOffice();
      setTimeout(() => setSaid(null), 7000);
    } catch (e) {
      setSaid({ html: `Couldn't add it: ${esc((e as Error).message)}`, tone: "err" });
    } finally {
      setBusy(false);
      inRef.current?.blur();
    }
  };
  p.submitRef.current = submit;

  const hintHtml = useMemo(() => {
    if (said) return said;
    if (!hint || !p.text.trim()) return null;
    const av = (agent: string) => {
      const pod = p.podOf(agent), c = POD_STYLE[pod]?.chip ?? "#ccc";
      return `<span class="av" style="border-color:${c};background:${c}55">${p.nameOf(agent)[0]}</span>`;
    };
    if (hint.problem) return { html: esc(hint.problem), tone: "err" as const };
    if (hint.kind === "outreach") {
      const desks = [...new Set((hint.steps ?? []).map((s) => s.agent))];
      const via = Object.entries(hint.routes ?? {}).map(([c, r]) => `${c === "call" ? "call" : c === "sms" ? "SMS" : c === "whatsapp" ? "WhatsApp" : "email"} via ${r === "native" ? "Nirnaya" : r}`).join(", ");
      return { html: `${desks.map(av).join("")}<b>${esc(hint.title ?? "")}</b> · ${desks.length} desks${via ? ` · ${esc(via)}` : ""}${hint.found ? ` · contact from ${esc(hint.found)}` : ""}${hint.needs_ok ? " · <b>waits for your OK</b>" : ""}` };
    }
    if (hint.kind === "routine") return { html: `${av(hint.agent!)}⏱ Routine · <b>${hint.when_desc}</b> · <b>${p.nameOf(hint.agent!)}</b> in ${POD_STYLE[hint.dept!].name.toLowerCase()} · next ${until(hint.next_at)}${hint.needs_ok ? " · waits for your OK" : ""}${hint.guessed ? ` · “${esc(hint.guessed)}” taken as ${hint.when?.at}` : ""}` };
    if (repeat) return { html: `⏱ Repeats ${CADENCES.find((c) => c[0] === cad)?.[1].toLowerCase()}${cad === "hourly" || cad === "m5" ? "" : " at " + at} · the office names the desk when you press Add` };
    if (hint.kind === "case") return { html: `${av(hint.agent!)}Probably <b>${p.nameOf(hint.agent!)}</b> · triage confirms when you press Add · ${esc(app?.customers.find((c) => c.id === customer)?.name.split(" ")[0] ?? "")} (${customer}) over ${channel}` };
    if (hint.op_kind === "help") return { html: `${POD_STYLE[dept].name[0] + POD_STYLE[dept].name.slice(1).toLowerCase()} can: ${esc((hint.can || []).join("; "))}.`, tone: "err" as const };
    return { html: `${av(hint.agent!)}Goes to <b>${p.nameOf(hint.agent!)}</b>${hint.dept !== dept ? ` in ${POD_STYLE[hint.dept!].name.toLowerCase()}` : ""} · “${esc(hint.title ?? "")}”${hint.needs_ok ? " · waits for your OK" : ""}` };
  }, [hint, said, p.text, repeat, cad, at, customer, channel, dept, app]);

  const scoped = p.focused && p.focused !== "brain" ? tasks.filter((t) => t.dept === p.focused) : tasks;
  const routines = (snap?.routines ?? []).filter((r) => !p.focused || p.focused === "brain" || r.dept === p.focused);
  const count = (f: string) => f === "all" ? scoped.length : f === "sched" ? routines.length + scoped.filter((t) => t.state === "scheduled").length : scoped.filter((t) => t.state === f).length;
  const list = filter === "sched" ? scoped.filter((t) => t.state === "scheduled") : scoped.filter((t) => filter === "all" || t.state === filter);
  const nextUp = routines.filter((r) => !r.paused && !r.quiet && r.next_at).sort((a, b) => (a.next_at! - b.next_at!))[0];

  const act = async (r: Routine, a: "run" | "pause" | "resume" | "delete") => {
    try {
      if (a === "delete") await oapi.deleteRoutine(r.id);
      else await oapi.routine(r.id, a);
    } finally { void refreshOffice(); }
  };

  return (
    <div ref={panelRef} className={`o-panel${min ? " min" : ""}`} data-testid="task-panel">
      <div className="o-cmd">
        <div className="r1">
          <button className="o-dd" aria-label="Department" onClick={(e) => { e.stopPropagation(); setMenu(!menu); setSamples(false); }}>
            <span className="o-dot" style={{ background: POD_STYLE[dept].chip }} />
            <span className="o-caps">{POD_STYLE[dept].name}</span> ▾
          </button>
          <textarea ref={inRef} className="o-in" rows={1} value={p.text} aria-label="Task"
            placeholder={isCase ? (dept === "intake" ? "Type a customer message, or “pay / ask / message / call someone…”" : "Type a customer message…") : `Type a task for ${POD_STYLE[dept].name.toLowerCase()}…`}
            onChange={(e) => { p.setText(e.target.value); setSaid(null); }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
              if (e.key === "Escape") (e.target as HTMLElement).blur();
              if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "e") { e.preventDefault(); p.openBig(); }
            }} />
          <button className="o-big" title="open the big editor (⌘⇧E)" onClick={p.openBig}>⤢</button>
        </div>
        <div className="r2">
          {isCase && app && <>
            <select className="o-mini" value={customer} aria-label="Customer" onChange={(e) => setCustomer(e.target.value)} onKeyDown={(e) => e.stopPropagation()}>
              {app.customers.map((c) => <option key={c.id} value={c.id}>{c.name.split(" ")[0]}</option>)}
            </select>
            <select className="o-mini" value={channel} aria-label="Channel" onChange={(e) => setChannel(e.target.value)} onKeyDown={(e) => e.stopPropagation()}>
              {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </>}
          <button className={`o-mini${repeat ? " on" : ""}`} title="repeat on a schedule (or just say when: every weekday at 8am, …)" onClick={() => setRepeat(!repeat)}>Repeat</button>
          <button className={`o-mini${samples ? " on" : ""}`} title={isCase ? "sample customer messages" : "things this department can do"}
            onClick={(e) => { e.stopPropagation(); setSamples(!samples); setMenu(false); }}>Samples</button>
          {p.text.trim() && hint?.tokens !== undefined && <span className="o-tok" data-testid="intake-tokens" title="Tokens in what you typed (≈, counted the way Qwen splits text); the case's own model use shows on its card and on the Dashboard">≈ {hint.tokens} token{hint.tokens === 1 ? "" : "s"}</span>}
          <button className="o-add" disabled={busy || !p.text.trim()} onClick={() => void submit()}>ADD</button>
        </div>
      </div>
      {menu && (
        <div className="o-menu" style={{ top: 58, left: 14 }} onClick={(e) => e.stopPropagation()}>
          {(snap?.pods ?? []).map((d) => (
            <button key={d.id} onClick={() => { p.setDept(d.id); setMenu(false); inRef.current?.focus(); }}>
              <span className="o-dot" style={{ background: POD_STYLE[d.id].chip }} /><span className="o-caps">{POD_STYLE[d.id].name}</span>
              <span className="sub">{d.blurb.split(",")[0]}</span>
            </button>
          ))}
        </div>
      )}
      {samples && (
        <div className="o-menu" style={{ top: 94, left: 14, right: 14 }} onClick={(e) => e.stopPropagation()}>
          {(isCase ? (app?.presets ?? []).map((s) => ({ label: s.label, text: s.text, customer: s.customer })) : EXAMPLES[dept].map((t) => ({ label: t, text: t, customer: "" })))
            .map((s) => (
              <button key={s.label} onClick={() => { p.setText(s.text); if (s.customer) setCustomer(s.customer); setSamples(false); inRef.current?.focus(); }}>
                {s.label}{s.customer && <span className="sub">{s.customer}</span>}
              </button>
            ))}
        </div>
      )}
      {repeat && (
        <div className="o-rep">
          <select className="o-mini" value={cad} onChange={(e) => setCad(e.target.value)} aria-label="How often">
            {CADENCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input type="time" value={at} disabled={cad === "hourly" || cad === "m5"} onChange={(e) => setAt(e.target.value)} aria-label="At" />
          <label><input type="checkbox" checked={needsOk} onChange={(e) => setNeedsOk(e.target.checked)} /> needs my OK</label>
        </div>
      )}
      {hintHtml && <div className={`o-hint${hintHtml.tone === "err" ? " err" : ""}`} dangerouslySetInnerHTML={{ __html: hintHtml.html }} />}
      <div className="o-head" onClick={() => setMin(!min)}>
        <h2>TASK STATUS</h2>
        <span className={`o-mode${p.connected ? "" : " off"}`}>{p.connected ? "LIVE · NIRNAYA" : "OFFLINE"}</span>
        <span className="o-scope">{p.focused && p.focused !== "brain" ? POD_STYLE[p.focused].name : "WHOLE OFFICE"}</span>
      </div>
      <div className="o-chips" role="tablist" aria-label="Filter">
        {([["all", "All"], ["sched", "Scheduled"], ["next", "Backlog"], ["doing", "In progress"], ["waiting", "Waiting"], ["done", "Done"]] as const).map(([f, l]) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`o-chip${filter === f ? " on" : ""}${f === "waiting" ? " w" : ""}`} onClick={() => setFilter(f)}>
            {l}<b>{count(f)}</b>
          </button>
        ))}
      </div>
      {nextUp && <div className="o-next"><span className="o-caps">NEXT ⏱</span><b>{until(nextUp.next_at)}</b><span>{nextUp.title} · {p.nameOf(nextUp.agent)}</span></div>}
      <div className="o-rows" data-testid="task-rows">
        {filter === "sched" && routines.map((r) => (
          <div key={r.id} className="o-row">
            <span className="o-st scheduled">⏱</span>
            <div className="body">
              <div className="t">{r.title}</div>
              <div className="m">{r.desc} · {p.nameOf(r.agent)} · {r.needs_ok ? "waits for your OK" : "read-only"}{r.last ? ` · last ${timeStr(r.last * 1000)}` : ""}{r.by && !["you", "system"].includes(r.by) ? ` · set by ${r.by}` : ""}</div>
              <div className="acts">
                <button className="run" onClick={() => act(r, "run")}>RUN NOW</button>
                <button onClick={() => act(r, r.paused ? "resume" : "pause")}>{r.paused ? "RESUME" : "PAUSE"}</button>
                {r.by !== "system" && <button onClick={() => act(r, "delete")}>DELETE</button>}
              </div>
            </div>
            <span className="ago">{r.paused ? "PAUSED" : until(r.next_at)}</span>
          </div>
        ))}
        {list.slice(0, 80).map((t) => {
          const isNew = !seen.current.has(t.id + t.state);
          seen.current.add(t.id + t.state);
          return <Row key={t.id} t={t} isNew={isNew} scoped={!!p.focused && p.focused !== "brain"} nameOf={p.nameOf} onRow={p.onRow} onCalendar={p.onCalendar} />;
        })}
        {!list.length && !(filter === "sched" && routines.length) && (
          <div className="o-empty">{filter === "sched" ? "Nothing booked. Type a task with a time in it — “every weekday at 9am, verify the audit trail” — or press P to book one on the calendar." : "Nothing here right now."}</div>
        )}
      </div>
    </div>
  );
}

function Row({ t, isNew, scoped, nameOf, onRow, onCalendar }: { t: OTask; isNew: boolean; scoped: boolean; nameOf: (a: string) => string; onRow: (t: OTask) => void; onCalendar: () => void }) {
  const person = byWhom(t);
  const who = (scoped ? nameOf(t.agent) : `${nameOf(t.agent)} · ${POD_STYLE[t.dept]?.name ?? ""}`) + (person ? ` · for ${esc(person)}` : "");
  const pct = Math.round(t.progress * 100);
  const refused = t.route === "REFUSE";
  const failed = t.kind === "op" && t.state === "done" && t.ok === false;
  let chip: string = t.state, label: string = { scheduled: "◷", next: "BACKLOG", doing: `${pct}%`, waiting: "WAITING", done: "DONE" }[t.state];
  if (refused && t.state === "done") { chip = "fail"; label = "REFUSED"; }
  if (failed) { chip = "fail"; label = t.op?.rejected ? "NOT RUN" : "FLAGGED"; }
  let meta = who;
  if (t.state === "doing") meta += t.kind === "case" ? ` · step ${Math.max(1, Math.round(t.progress * 10))} of 10 · ${t.c?.step ?? ""}`
    : t.op?.kind === "outreach" && t.op.doing ? ` · ${esc(t.op.doing)}` : " · working";
  if (t.state === "waiting") meta = `<span class="o-amb">waiting ${span(Date.now() - t.changedAt)} for an OK</span> · ${who}${t.kind === "case" ? " · sealed" : t.kind === "flow" ? " · a flow asks" : ""}`;
  if (t.state === "scheduled") meta += ` · runs ${t.dueAt ? dayTime(t.dueAt) : ""}`;
  if (t.state === "done") {
    const how = t.kind === "case"
      ? (refused ? "refused" : t.c?.status === "resolved" && (t.route === "ACT" || t.route === "HEDGE") ? (t.route === "HEDGE" ? "done alone, with an undo" : "resolved alone") : t.c?.approved_by ? `resolved after ${esc(t.c.approved_by)}’s OK` : "resolved after a person’s OK")
      : t.op?.rejected ? `${t.op.rejected_by && t.op.rejected_by !== "you" ? esc(t.op.rejected_by) : "you"} said no`
      : t.approved ? `ran after ${t.op?.approved_by && t.op.approved_by !== "you" ? esc(t.op.approved_by) + "’s" : "your"} OK` : t.op?.routine ? "routine" : "done";
    const tokens = t.kind === "case" ? t.c?.tokens : t.op?.tokens;
    meta += ` · ${how} · ${timeStr(t.doneAt ?? t.changedAt)}` + (tokens ? ` · <span class="tok">${tokens.toLocaleString("en-IN")} tokens</span>` : "")
      + (failed || refused ? "" : ` · <span class="res">result →</span>`);
  }
  if (t.late) meta += " · ran late";
  return (
    <div className={`o-row ${t.state}${isNew ? " new" : ""} click`} data-id={t.id} onClick={() => onRow(t)}>
      <span className={`o-st ${chip}`}>{label}</span>
      <div className="body">
        <div className={`t${t.state === "done" && !failed && !refused ? " struck" : ""}`}>{t.op?.routine || t.state === "scheduled" ? "⏱ " : ""}{t.title}</div>
        <div className="m" dangerouslySetInnerHTML={{ __html: meta }} />
        {t.state === "doing" && <div className="bar"><i style={{ width: `${Math.max(4, pct)}%` }} /></div>}
        {t.state === "scheduled" && (
          <div className="acts">
            <button onClick={(e) => { e.stopPropagation(); void oapi.cancelOp(t.id).then(refreshOffice); }}>CANCEL</button>
            <button onClick={(e) => { e.stopPropagation(); onCalendar(); }}>CALENDAR</button>
          </div>
        )}
      </div>
      <span className="ago">{span(Date.now() - t.changedAt)}</span>
    </div>
  );
}

export { POD_IDS };
