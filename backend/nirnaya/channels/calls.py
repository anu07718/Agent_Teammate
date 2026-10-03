"""Call reports: what was said on each call (in the caller's words, with the English the agents worked from),
the cases it opened and how they ended, and the recording, kept in Nirnaya.

A phone call (Twilio) or a call-page call keeps a transcript as it goes (`note`). When it ends, and again when
its recording arrives, `save` writes the report to kv "call_reports", so it outlives the conversation (the
Inbox keeps the last 300). Recordings are downloaded from Twilio into <data>/recordings next to the database
and served only to this server's own users (a joined workspace member cannot fetch them: relay.DENY).
"""
from __future__ import annotations

import html
import re
import tempfile
import time
from pathlib import Path

from ..dashboard import case_outcome

REPORTS = "call_reports"
MAX_REPORTS = 500
LANG_NAME = {"en": "English", "hi": "Hindi"}


def note(hub, conv_id: str, who: str, said: str, *, english: str | None = None, lang: str = "en",
         via: str | None = None) -> None:
    """One line of the transcript: who ("caller" or "agent"), what they said, and its English when different."""
    conv = hub.conversation(conv_id)
    if not conv or not said:
        return
    row = {"who": who, "said": said[:2000], "lang": lang, "ts": time.time()}
    if english and english.strip() != said.strip():
        row["english"] = english[:2000]
    if via and via != "as is":
        row["via"] = via
    conv.setdefault("transcript", []).append(row)
    conv["transcript"] = conv["transcript"][-200:]
    conv.setdefault("langs", [])
    if lang not in conv["langs"]:
        conv["langs"].append(lang)
    hub._put(conv)


def recordings_dir(e) -> Path:
    path = getattr(e.store, "path", ":memory:")
    base = Path(tempfile.gettempdir()) / "nirnaya" if path == ":memory:" else Path(path).resolve().parent
    d = base / "recordings"
    d.mkdir(parents=True, exist_ok=True)
    return d


def recording_file(e, conv_id: str, rec_sid: str) -> Path:
    safe = re.sub(r"[^\w-]", "_", f"{conv_id}-{rec_sid}")[:120]
    return recordings_dir(e) / f"{safe}.mp3"


def _dur(s: float | int | None) -> str:
    if not s:
        return "—"
    s = int(s)
    return f"{s // 60}m {s % 60:02d}s" if s >= 60 else f"{s}s"


def build(hub, conv: dict) -> dict:
    e = hub.E()
    cust = hub.customers().get(conv.get("customer_id") or "") or {}
    turns = conv.get("transcript") or [
        {"who": "caller" if m["dir"] == "in" else "agent", "said": m["text"], "lang": "en", "ts": m["ts"]}
        for m in conv.get("messages", []) if m.get("kind") not in ("call",)]
    cases = []
    for cid in conv.get("case_ids", []):
        c = e.store.get_case(cid)
        if not c:
            continue
        out, how = case_outcome(c)
        txn = c.get("txn") or {}
        reply = next((m["text"] for m in reversed(c.get("conversation", [])) if m.get("role") == "nirnaya"), None)
        cases.append({"id": cid, "intent": c.get("intent"), "amount": txn.get("amount"), "status": c.get("status"),
                      "route": c.get("route"), "outcome": out, "how": how, "reply": reply, "tokens": c.get("tokens") or 0})
    started = conv.get("created_at")
    ended = conv.get("ended_at") or (conv.get("updated_at") if conv.get("ended") else None)
    duration = conv.get("duration") or (round(ended - started) if ended and started else None)
    langs = conv.get("langs") or sorted({t.get("lang", "en") for t in turns}) or ["en"]
    rec = conv.get("recording") or {"status": "off"}
    worst = "waiting" if any(c["outcome"] == "waiting" for c in cases) else \
        "rejected" if any(c["outcome"] == "rejected" for c in cases) else \
        "running" if any(c["outcome"] == "running" for c in cases) else ("accepted" if cases else "no case")
    who = (cust.get("name") or conv.get("name") or conv.get("address") or "The caller").split(" ")[0]
    direction = "out" if conv["id"].startswith("voice:out-") else "in"
    kind = "phone" if conv["channel"] == "voice" else "call page"
    parts = [f"{'We called ' + who if direction == 'out' else who + ' called'} on the {kind}"
             + (f" on {time.strftime('%d %b %Y at %H:%M', time.localtime(started))}" if started else "")
             + (f", {_dur(duration)}" if duration else "") + ".",
             "Spoke " + " and ".join(LANG_NAME.get(x, x) for x in langs) + "."]
    for c in cases:
        amt = f" ₹{c['amount']:,.0f}" if c.get("amount") else ""
        parts.append(f"{c['id']}: {(c['intent'] or 'a question').replace('_', ' ')}{amt}, {c['how']}.")
    if not cases:
        parts.append("No case was opened.")
    parts.append({"kept": f"Recording kept ({_dur(rec.get('duration'))})." if rec.get("duration") else "Recording kept.", "off": "Not recorded (recording is off).",
                  "failed": f"Not recorded: {rec.get('error') or 'Twilio refused'}.",
                  "absent": "Twilio made no recording (no audio).", "recording": "Recording in progress.",
                  "downloading": "Recording is being saved."}.get(rec.get("status"), f"Recording: {rec.get('status')}."))
    return {
        "id": conv["id"], "channel": kind, "direction": direction, "name": conv.get("name"), "number": conv.get("address"),
        "customer": {"id": conv.get("customer_id"), "name": cust.get("name")} if conv.get("customer_id") else None,
        "started": started, "ended": ended, "duration": duration, "langs": langs, "turns": turns, "cases": cases,
        "outcome": worst, "summary": " ".join(parts), "ended_ok": bool(conv.get("ended")),
        "recording": {k: v for k, v in rec.items() if k in ("status", "duration", "error", "sid", "bytes", "file", "at")},
        "updated": time.time(),
    }


def save(hub, conv_id: str) -> dict | None:
    conv = hub.conversation(conv_id)
    if not conv or conv["channel"] not in ("voice", "web"):
        return None
    rep = build(hub, conv)
    e = hub.E()
    all_ = e.store.kv_get(REPORTS) or {}
    all_.pop(conv_id, None)
    all_[conv_id] = rep
    while len(all_) > MAX_REPORTS:
        all_.pop(next(iter(all_)))
    e.store.kv_set(REPORTS, all_)
    e.bus.publish("call.report", report=summary(rep))
    return rep


def summary(rep: dict) -> dict:
    return {k: rep.get(k) for k in ("id", "channel", "direction", "name", "number", "customer", "started", "duration",
                                    "langs", "outcome", "summary")} | {
        "cases": [c["id"] for c in rep.get("cases", [])], "turns": len(rep.get("turns", [])),
        "recording": (rep.get("recording") or {}).get("status")}


def listing(hub, limit: int = 100) -> list[dict]:
    reps = list((hub.E().store.kv_get(REPORTS) or {}).values())
    return [summary(r) for r in sorted(reps, key=lambda r: -(r.get("started") or 0))[:limit]]


def get(hub, conv_id: str) -> dict | None:
    """The report, rebuilt from the conversation while it is still there (its cases may have moved on)."""
    if hub.conversation(conv_id):
        return save(hub, conv_id)
    return (hub.E().store.kv_get(REPORTS) or {}).get(conv_id)


def as_html(rep: dict) -> str:
    """A page to keep or print: the summary, the cases, the transcript with translations."""
    esc = html.escape
    when = time.strftime("%d %b %Y, %H:%M", time.localtime(rep["started"])) if rep.get("started") else "—"
    rows = "".join(
        f"<tr><td class=w>{'Agent' if t['who'] == 'agent' else 'Caller'}</td><td>{esc(t['said'])}"
        + (f"<div class=en>English: {esc(t['english'])}</div>" if t.get("english") else "")
        + f"</td><td class=t>{time.strftime('%H:%M:%S', time.localtime(t['ts'])) if t.get('ts') else ''}</td></tr>"
        for t in rep.get("turns", []))
    cases = "".join(f"<li><b>{esc(c['id'])}</b> · {esc((c['intent'] or '').replace('_', ' '))}"
                    f"{' · ₹' + format(c['amount'], ',.0f') if c.get('amount') else ''} · {esc(c['outcome'])} ({esc(c['how'])})"
                    + (f"<div class=en>{esc(c['reply'])}</div>" if c.get("reply") else "") + "</li>"
                    for c in rep.get("cases", [])) or "<li>No case was opened.</li>"
    rec = rep.get("recording") or {}
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>Call report {esc(rep['id'])}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{{font:14px/1.5 Inter,system-ui,sans-serif;color:#171614;background:#fbfcf6;max-width:860px;margin:32px auto;padding:0 16px}}
h1{{font:400 28px Georgia,serif;letter-spacing:.02em;text-transform:uppercase;margin:0 0 4px}}.m{{color:#5f5e59}}
table{{width:100%;border-collapse:collapse;margin-top:8px}}td{{border-top:1px solid #e3e3dc;padding:8px 6px;vertical-align:top}}
.w{{width:70px;color:#5f5e59;font-size:12px;text-transform:uppercase;letter-spacing:.1em}}.t{{width:70px;color:#8f8d86;font-size:12px}}
.en{{color:#5f5e59;font-size:12.5px;margin-top:2px}}h2{{font-size:11px;letter-spacing:.16em;text-transform:uppercase;margin:24px 0 6px}}
.box{{background:#fff;border:1px solid #e3e3dc;border-radius:12px;padding:12px 16px}}</style></head><body>
<h1>Call report</h1><div class=m>{esc(rep['id'])} · {esc(rep['channel'])} · {'outgoing' if rep['direction'] == 'out' else 'incoming'} · {when}</div>
<h2>Summary</h2><div class=box>{esc(rep['summary'])}</div>
<h2>Caller</h2><div class=box>{esc(rep.get('name') or '')} · {esc(rep.get('number') or '')}{' · ' + esc(rep['customer']['name'] or '') + ' (' + esc(rep['customer']['id']) + ')' if rep.get('customer') else ''}<br>
Languages: {esc(', '.join(LANG_NAME.get(x, x) for x in rep.get('langs', [])))} · Duration: {_dur(rep.get('duration'))} · Outcome: {esc(rep['outcome'])}</div>
<h2>Cases</h2><div class=box><ul>{cases}</ul></div>
<h2>Recording</h2><div class=box>{esc(rec.get('status', 'off'))}{' · ' + _dur(rec.get('duration')) if rec.get('duration') else ''}{' · kept in Nirnaya as ' + esc(rec['file']) if rec.get('file') else ''}{' · ' + esc(rec['error']) if rec.get('error') else ''}</div>
<h2>Transcript</h2><table>{rows}</table>
<p class=m style="margin-top:24px;font-size:12px">Written by Nirnaya on {time.strftime('%d %b %Y, %H:%M')}. The caller's own words are shown as said; English is what the agents worked from.</p>
</body></html>"""
