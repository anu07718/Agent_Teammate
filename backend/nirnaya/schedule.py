"""Plain-words schedules: "every weekday at 8am, …" → a schedule, its next run, and its runs in a window.

A schedule is a dict:
  {"kind": "minutes", "every": N}
  {"kind": "hourly", "every": N, "from": "09:00", "to": "17:00", "weekdays_only": True}
  {"kind": "daily", "at": "HH:MM"} · {"kind": "weekdays", "at": "HH:MM"}
  {"kind": "weekly", "days": [0..6], "at": "HH:MM"}          (0 = Monday)
Any kind may carry "start": "YYYY-MM-DD": it never fires before that day. Times are the server's local clock.
"""
from __future__ import annotations

import datetime as dt
import re

DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
DAY_RE = r"(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?"
TIME_WORDS = {"morning": "09:00", "subah": "09:00", "noon": "12:00", "afternoon": "14:00", "evening": "18:00",
              "shaam": "18:00", "night": "21:00", "nightly": "02:00", "midnight": "00:00"}


def _day_index(word: str) -> int:
    w = word.lower()[:3]
    return [d[:3] for d in DAYS].index(w)


def _hhmm(h: int, m: int, ampm: str | None) -> str | None:
    if ampm:
        ampm = ampm.lower()
        if not 1 <= h <= 12:
            return None
        h = (h % 12) + (12 if ampm == "pm" else 0)
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return f"{h:02d}:{m:02d}"


def _cut(text: str, spans: list[tuple[int, int]]) -> str:
    out, last = [], 0
    for a, b in sorted(spans):
        if a < last:
            continue
        out.append(text[last:a])
        last = b
    out.append(text[last:])
    s = re.sub(r"\s{2,}", " ", "".join(out))
    s = re.sub(r"^[\s,;:.\-–—]+|[\s,;:\-–—]+$", "", s)
    s = re.sub(r"^(?:and|then|please)\s+", "", s, flags=re.I)
    return s[:1].upper() + s[1:] if s else s


def _find_time(s: str) -> tuple[str | None, tuple[int, int] | None]:
    for rx in (r"\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b", r"\b(\d{1,2}):(\d{2})\s*(am|pm)?\b",
               r"\b(\d{1,2})\s*(am|pm)\b"):
        m = re.search(rx, s, re.I)
        if m:
            g = m.groups()
            if len(g) == 2:
                t = _hhmm(int(g[0]), 0, g[1])
            else:
                t = _hhmm(int(g[0]), int(g[1] or 0), g[2])
            if t:
                return t, m.span()
    m = re.search(r"\b(?:at\s+)?(noon|midnight)\b", s, re.I)
    if m:
        return TIME_WORDS[m.group(1).lower()], m.span()
    return None, None


def parse(text: str) -> dict | None:
    """The schedule in a sentence, and the sentence without it. None when there is no schedule in it."""
    s = text.strip()
    spans: list[tuple[int, int]] = []
    when: dict | None = None
    needs_time = needs_day = False
    guessed = None

    m = re.search(r"\b(?:every|each)\s+(?:(\d+)\s*)?(?:min|mins|minutes?)\b", s, re.I)
    if m:
        return {"when": {"kind": "minutes", "every": max(1, int(m.group(1) or 1))}, "text": _cut(s, [m.span()]),
                "needs_time": False, "needs_day": False, "guessed": None}

    m = re.search(r"\b(?:hourly|every\s+(\d+)\s+hours?|every\s+hour|each\s+hour|har\s+ghante)\b", s, re.I)
    if m:
        when = {"kind": "hourly", "every": max(1, int(m.group(1) or 1))}
        spans.append(m.span())
        w = re.search(r"\b(?:between|from)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:and|to|-|–)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?",
                      s, re.I)
        if w:
            a = _hhmm(int(w.group(1)), int(w.group(2) or 0), w.group(3) or (None if int(w.group(1)) > 12 else "am"))
            b = _hhmm(int(w.group(4)), int(w.group(5) or 0), w.group(6) or (None if int(w.group(4)) > 12 else "pm"))
            if a and b and a < b:
                when.update({"from": a, "to": b})
                spans.append(w.span())
        wd = re.search(r"\b(?:on\s+)?weekdays?\b", s, re.I)
        if wd:
            when["weekdays_only"] = True
            spans.append(wd.span())
        return {"when": when, "text": _cut(s, spans), "needs_time": False, "needs_day": False, "guessed": None}

    m = re.search(r"\b(?:every\s+weekday|on\s+weekdays|weekdays|mon(?:day)?\s*(?:-|to|–)\s*fri(?:day)?)\b", s, re.I)
    if m:
        when = {"kind": "weekdays"}
        spans.append(m.span())
    else:
        m = re.search(rf"\b(?:every|each|on|har)\s+{DAY_RE}(?:(?:\s*,\s*|\s+and\s+|\s*&\s*){DAY_RE})*\b", s, re.I) or \
            re.search(rf"\b{DAY_RE[:-2]}s\b(?:(?:\s*,\s*|\s+and\s+|\s*&\s*){DAY_RE})*", s, re.I) or \
            re.search(rf"\b{DAY_RE}(?:(?:\s*,\s*|\s+and\s+|\s*&\s*){DAY_RE})+\b", s, re.I)
        if m:
            days = sorted({_day_index(d) for d in re.findall(DAY_RE, m.group(0), re.I)})
            when = {"kind": "weekly", "days": days}
            spans.append(m.span())
        else:
            m = re.search(r"\b(?:every\s+day|each\s+day|daily|every\s+(morning|evening|night)|each\s+(morning|evening)|"
                          r"nightly|roz(?:\s+(subah|shaam))?|har\s+din)\b", s, re.I)
            if m:
                when = {"kind": "daily"}
                spans.append(m.span())
                word = next((g for g in m.groups() if g), None) or ("nightly" if "nightly" in m.group(0).lower() else None)
                if word:
                    guessed = word.lower()
            elif re.search(r"\b(?:every|each)\s+week\b", s, re.I):
                m = re.search(r"\b(?:every|each)\s+week\b", s, re.I)
                when = {"kind": "weekly", "days": []}
                spans.append(m.span())
    if when is None:
        return None
    t, span = _find_time(s)
    if t:
        when["at"] = t
        spans.append(span)
        guessed = None
    elif guessed and guessed in TIME_WORDS:
        when["at"] = TIME_WORDS[guessed]
    else:
        guessed = None
        needs_time = True
    if when["kind"] == "weekly" and not when.get("days"):
        needs_day = True
    return {"when": when, "text": _cut(s, spans), "needs_time": needs_time, "needs_day": needs_day,
            "guessed": guessed}


def valid(when: dict | None) -> bool:
    if not isinstance(when, dict):
        return False
    t = lambda x: isinstance(x, str) and re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", x) is not None
    k = when.get("kind")
    if k == "minutes":
        return isinstance(when.get("every"), int) and when["every"] >= 1
    if k == "hourly":
        ok = isinstance(when.get("every"), int) and when["every"] >= 1
        if "from" in when or "to" in when:
            ok = ok and t(when.get("from")) and t(when.get("to")) and when["from"] < when["to"]
        return ok
    if k in ("daily", "weekdays"):
        return t(when.get("at"))
    if k == "weekly":
        d = when.get("days")
        return t(when.get("at")) and isinstance(d, list) and bool(d) and all(isinstance(x, int) and 0 <= x <= 6 for x in d)
    return False


def describe(when: dict | None) -> str:
    if not valid(when):
        return "not scheduled"
    k = when["kind"]
    if k == "minutes":
        s = f"every {when['every']} min" if when["every"] > 1 else "every minute"
    elif k == "hourly":
        s = (f"every {when['every']} hours" if when["every"] > 1 else "every hour") + \
            (f" {when['from']}–{when['to']}" if when.get("from") else "") + (" · weekdays" if when.get("weekdays_only") else "")
    elif k == "daily":
        s = f"every day · {when['at']}"
    elif k == "weekdays":
        s = f"every weekday · {when['at']}"
    else:
        names = [DAYS[d][:3].title() for d in sorted(when["days"])]
        s = ("every " + " & ".join(names) if len(names) <= 2 else ", ".join(names)) + f" · {when['at']}"
    if when.get("start"):
        s += f" · from {when['start']}"
    return s


def _start(when: dict) -> dt.datetime | None:
    try:
        return dt.datetime.strptime(when["start"], "%Y-%m-%d") if when.get("start") else None
    except ValueError:
        return None


def next_run(when: dict | None, after: float) -> float | None:
    """The first run strictly after `after` (a unix time), or None if the schedule is not valid."""
    if not valid(when):
        return None
    base = dt.datetime.fromtimestamp(after)
    st = _start(when)
    if st and st > base:
        base = st - dt.timedelta(seconds=1)
    k = when["kind"]
    if k == "minutes":
        step = when["every"] * 60
        nxt = (int(base.timestamp()) // step + 1) * step
        return float(nxt)
    if k == "hourly":
        fr = when.get("from", "00:00")
        to = when.get("to", "23:59")
        cand = base.replace(minute=0, second=0, microsecond=0)
        for _ in range(24 * 15):
            cand += dt.timedelta(hours=1)
            hm = cand.strftime("%H:%M")
            if when.get("weekdays_only") and cand.weekday() >= 5:
                continue
            if not (fr <= hm <= to):
                continue
            if (cand.hour - int(fr[:2])) % when["every"]:
                continue
            if cand > base:
                return cand.timestamp()
        return None
    h, m = map(int, when["at"].split(":"))
    day = base.replace(hour=h, minute=m, second=0, microsecond=0)
    if day <= base:
        day += dt.timedelta(days=1)
    for _ in range(15):
        wd = day.weekday()
        if k == "daily" or (k == "weekdays" and wd < 5) or (k == "weekly" and wd in when["days"]):
            return day.timestamp()
        day += dt.timedelta(days=1)
    return None


def occurrences(when: dict | None, start: float, end: float, limit: int = 800) -> list[float]:
    out: list[float] = []
    t = start
    while len(out) < limit:
        n = next_run(when, t)
        if n is None or n >= end:
            break
        out.append(n)
        t = n
    return out
