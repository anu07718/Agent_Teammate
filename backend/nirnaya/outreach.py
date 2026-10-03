"""Outreach: the agents pay someone, ask them for money, message them or call them, from one sentence.

"Pay ₹500 to Anushka (anushka@example.com) for dinner", "ask Rahul +91 98765 43210 for ₹1,200 on WhatsApp
and call him if he hasn't paid in 2 hours", "call Priya about the ₹349 refund", "anushka ko 500 bhej do".

Reading: rules first; the free model only fills in what the rules could not (and only ever sees the
sentence with the email and phone masked). Whatever is missing — who, how much, an email or a phone number
for the channel asked — is asked back, never guessed. People already known (an earlier task, Channels →
Contacts, the ledger's customers) are found by name without asking.

Doing: each task is an office op that walks through the desks that own each part, so the office shows it
moving: Sentry screens it, the Tokeniser masks the contact details, Triage reads it, Accounts & KYC (a
payment) or the UPI desk (a payment request) prepares it, Risk & Fraud checks the payee, the amount and how
often this person was contacted, the Router routes it, the Seal Keeper seals a payment, a person approves
it, Commit runs it through the Tool Gateway exactly once, the Responder words the message, the Promise Guard
checks it, the Responder sends it, and the Ledger Trail records it.

Money: a payment out always waits for a named person, sealed over the payee, the amount, the float's
version and the policy; if anything moved in between, the seal breaks and nothing is paid. A payment
request is a Razorpay test-mode payment link when Razorpay is set up (Ledger → Real UPI payments), else a
plain request (to your UPI ID, when one is set). Nothing claims more than happened: a simulated payout
says so in the message.

Sending: a channel set up in Nirnaya (Channels) sends from here; otherwise — or always, by the setting in
Channels → Webhooks — the task is POSTed to n8n, whose workflow sends it with Gmail, WhatsApp or Twilio.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any

from . import guard as promise_guard
from . import scope
from .replies import rs

log = logging.getLogger("nirnaya.outreach")

KEY = "outreach"                  # settings
PEOPLE = "outreach_people"        # people met in earlier tasks: name → email / phone
LOG = "outreach_log"              # who was contacted when (the per-person rate limit)
DRAFTS = "outreach_drafts"        # a task still missing something, per agent chat
DEFAULTS = {"from_name": "", "upi_id": "", "pay_cap": 10_000.0, "daily_pay_cap": 50_000.0,
            "request_cap": 100_000.0, "per_contact_hour": 3}
CHANNELS = ("email", "whatsapp", "call", "sms")
CH_WORD = {"email": "email", "whatsapp": "WhatsApp", "call": "a call", "sms": "SMS"}
DRAFT_TTL = 15 * 60

# ── reading the sentence ─────────────────────────────────────────────────────
EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
PHONE = re.compile(r"(?<![\w₹@.])(?:(?:\+|00)?91[\s-]?|0)?([6-9]\d{4}[\s-]?\d{5})(?![\w@])|(?<![\w@])\+(?!91)(\d[\d\s-]{7,15}\d)(?![\w@])")
MONEY = re.compile(r"(?:₹|\brs\.?|\binr\b|\brupees?\b)\s?(\d[\d,]*(?:\.\d{1,2})?)\s*(k|lakhs?|lacs?)?\b"
                   r"|\b(\d[\d,]*(?:\.\d{1,2})?)\s*(k|lakhs?|lacs?)?\s*(?:₹|rs\b\.?|rupees?\b|inr\b|/-)", re.I)
BARE = re.compile(r"(?<![\w.,:/+-])(\d{1,3}(?:,\d{2,3})+|\d{1,7})(\.\d{1,2})?\s*(k|lakhs?|lacs?)?(?![\w:/]|\.\d)", re.I)
TIME_AFTER = re.compile(r"^\s*(?:am|pm|a\.m|p\.m|hours?|hrs?|h\b|minutes?|mins?|m\b|days?|d\b|weeks?|:\d|th\b|st\b|nd\b|rd\b)", re.I)

LEAD = re.compile(r"^\s*(?:(?:hey|hi|hello|ok|okay|so|now|please|pls|plz|kindly|nirnaya|team|triage|agents?)\b[,!.:]?\s*)*"
                  r"(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:want|need|would\s+like|'d\s+like)\s+(?:you\s+)?to\s+"
                  r"|go\s+ahead\s+and\s+|let'?s\s+|please\s+)?", re.I)
IMPERATIVE = re.compile(r"^(?:make\s+(?:a\s+)?payment|do\s+(?:a\s+)?payment|send|pay|give|transfer|credit|reimburse|ask|request"
                        r"|collect|claim|remind|message|msg|text|tell|inform|notify|let\s+\w+\s+know|whats\s?app|wa|e-?mail"
                        r"|mail|sms|call|phone|ring|dial|talk|speak|contact|reach\s+out)\b", re.I)
HINDI = re.compile(r"\b(?:ko|se)\b[^.?!]{0,50}\b(?:bhej\w*|de\s+do|dedo|maang\w*|mangwa\w*|call\s+kar\w*|phone\s+kar\w*"
                   r"|message\s+kar\w*|whats\s?app\s+kar\w*|bata\s+do|batao|yaad\s+dila\w*)\b", re.I)
SELF = re.compile(r"^(?:\w+\s+){0,2}?(?:me|my|us|our|mine|mera|meri|mujhe)\b", re.I)
COMPLAINT = re.compile(r"\b(?:i|we)\s+(?:was|were|have\s+been|got|paid|sent|transferred|did\s*n['’]?t|didn['’]t|haven['’]?t|have\s+not"
                       r"|never|am|made)\b|\bmy\s+(?:upi|payment|money|refund|account|card|balance|transaction)\b", re.I)

REQUEST = re.compile(r"\b(?:ask|asking|request|requesting|collect|collecting|claim|recover)\b[^.?!]*?\b(?:for|to\s+pay|money|amount|₹|rs|\d)"
                     r"|\bremind\w*\b[^.?!]*?(?:₹|\brs\b|\d|\bpay|\bowe)|\bowes?\b|\bmaang\w*|\bmangwa\w*|\bpayment\s+(?:link|request)"
                     r"|\bpay\s+request\b|\b(?:request|collect)\s+(?:₹|rs|\d)", re.I)
PAY = re.compile(r"\b(?:make|do)\s+(?:a\s+)?payment\b|\b(?:pay|paying|transfer|credit|reimburse)\b"
                 r"|\b(?:send|give)\b(?![^.?!]{0,30}\b(?:link|message|msg|reminder|e-?mail|mail|whats\s?app|text|sms|request|invoice|bill|note)\b)"
                 r"[^.?!]{0,40}(?:₹|\brs\b|\binr\b|rupees|\d)|\bbhej\w*|\bde\s+do\b|\bdedo\b", re.I)
CALL = re.compile(r"\b(?:call|calling|ring|dial)\b(?!\s+(?:back|centre|center|me)\b)|\bphone\b(?!\s*(?:no\b|number|num\b|#))"
                  r"|\b(?:talk|speak)\s+(?:to|with)\b|\bcall\s+kar\w*|\bphone\s+kar\w*", re.I)
CH_RE = {
    "email": re.compile(r"\b(?:e-?mail|mail|gmail|inbox)\b", re.I),
    "whatsapp": re.compile(r"\b(?:whats\s?app|watsapp|whatsap|wa)\b", re.I),
    "call": CALL,
    "sms": re.compile(r"\bsms\b|\btext\s+(?!message\b)(?:him|her|them|[a-z]{2,}|\+?\d)", re.I),
}
NOT_NAME = set("""me him her them us it the a an my our your his their this that money payment amount back via on by at for and
with using please rs inr rupees rupee pay send give call email mail whatsapp wa sms text message msg link request ask remind tell
inform notify phone number ring dial to from into of ko se do de kar karo bhej bhejo maango maang paise paisa about regarding
link today tomorrow now someone somebody everyone customer customers person friend payee them all make sure also then if""".split())
NAME_AFTER = re.compile(
    r"\b(?:to|pay|paying|ask|asking|call|calling|message|msg|text|e-?mail|mail|whats\s?app|wa|remind|tell|inform|notify|from|"
    r"request(?:ing)?(?:\s+money)?\s+from|collect(?:ing)?\s+from|ring|dial|contact|reach\s+out\s+to|talk\s+to|speak\s+to)\s+"
    r"([A-Za-z][A-Za-z.'’-]{1,24})(?:\s+([A-Z][a-z][A-Za-z'’-]{0,23}))?", re.I)
NAME_HINDI = re.compile(r"\b([A-Za-z][A-Za-z.'’-]{1,24})\s+(?:ko|se)\b", re.I)
FOR_REASON = re.compile(r"\bfor\s+(?!₹|rs\b|inr\b|\d)((?:the|her|his|their|my|our|a|an)\s+)?([a-z][\w'’ -]{1,40}?)"
                        r"(?=\s*(?:$|[.,;!?)]|\band\b|\bon\b|\bvia\b|\bby\b|\bif\b|\bthen\b|\bthrough\b|\bover\b|\busing\b|\bto\b|\bfrom\b))", re.I)
ABOUT = re.compile(r"\b(?:about|regarding|re:?)\s+((?:the|her|his|their|my|our)\s+)?(.{2,60}?)(?=\s*(?:$|[.;!?]|\band\s+(?:call|whats|e-?mail|text|if)\b|\bif\b|\bon\b|\bvia\b))", re.I)
SAY = re.compile(r"[\"“”']([^\"“”']{3,400})[\"“”']|:\s*(.{3,400})$|\b(?:and\s+)?(?:say|tell\s+(?:him|her|them)|saying)\s+(?:that\s+)?(.{3,400})$", re.I)
FOLLOW = re.compile(
    r"(?:,?\s*(?:and\s+)?(?:then\s+)?(call|phone|ring|whats\s?app|e-?mail|mail|text|sms|remind|message)\s+(?:him|her|them|[a-z]+)?\s*(?:again\s+)?)?"
    r"\b(?:if|unless)\s+(?:s?he|they|he|she|it|[a-z]+)?\s*(?:has\s*n['’]?t|hasn['’]t|haven['’]t|has\s+not|have\s+not|does\s*n['’]?t|doesn['’]t"
    r"|did\s*n['’]?t|didn['’]t|does\s+not|did\s+not|is\s+not|isn['’]t|not)\s+(?:yet\s+)?(?:paid|pay)\s*(?:it|up|back|yet)?\s*"
    r"(?:in|within|after|by)\s+(\d{1,3})\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)\b"
    r"(?:\s*,?\s*(?:then\s+)?(call|phone|ring|whats\s?app|e-?mail|mail|text|sms|remind|message)\s*(?:him|her|them)?\s*(?:again)?)?", re.I)
HINGLISH_OUT = {"ko", "se", "bhej", "bhejo", "maang", "maango", "karo", "kar", "de", "do", "dedo", "paisa", "paise", "usko",
                "isko", "unko", "bata", "batao", "hai", "hain", "aur", "ka", "ki", "ke"}
UNIT = {"m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60, "h": 3600, "hr": 3600, "hrs": 3600, "hour": 3600,
        "hours": 3600, "d": 86400, "day": 86400, "days": 86400}


def _amount(num: str, suffix: str | None) -> float:
    v = float(num.replace(",", ""))
    s = (suffix or "").lower()
    if s == "k":
        v *= 1_000
    elif s.startswith(("lakh", "lac")):
        v *= 1_00_000
    return round(v, 2)


def e164(raw: str) -> str:
    """+91XXXXXXXXXX for an Indian mobile, + and the digits for anything else."""
    d = re.sub(r"\D", "", raw or "")
    if len(d) == 10 and d[0] in "6789":
        return "+91" + d
    if len(d) == 12 and d.startswith("91") and d[2] in "6789":
        return "+" + d
    if len(d) == 11 and d.startswith("0") and d[1] in "6789":
        return "+91" + d[1:]
    return "+" + d if 8 <= len(d) <= 15 else ""


def mask(addr: str) -> str:
    if "@" in addr:
        user, _, dom = addr.partition("@")
        return f"{user[:2]}…@{dom}"
    d = re.sub(r"\D", "", addr)
    return f"+{d[:2]} …{d[-4:]}" if len(d) > 6 else addr


def looks_like(text: str) -> bool:
    """An instruction to pay, ask, message or call someone — not a customer telling us about their payment."""
    t = (text or "").strip()
    if not t or len(t) > 600:
        return False
    body = LEAD.sub("", t, count=1)
    if HINDI.search(t) and not COMPLAINT.search(t):
        return True
    m = IMPERATIVE.match(body)
    if not m:
        return False
    rest = body[m.end():]
    if SELF.match(rest.strip()) or COMPLAINT.search(t):
        return False
    return True


def _strip(text: str, spans: list[tuple[int, int]]) -> str:
    out, last = [], 0
    for a, b in sorted(spans):
        out.append(text[last:a])
        out.append(" ⟂ ")
        last = b
    out.append(text[last:])
    return "".join(out)


def parse(text: str) -> dict:
    """What the sentence asks for. Missing parts stay None; `ask()` turns them into questions."""
    raw = (text or "").strip()
    t: dict[str, Any] = {"text": raw, "money": None, "action": None, "amount": None, "name": None, "email": None,
                         "phone": None, "channels": [], "channels_named": False, "reason": None, "say": None,
                         "followup": None, "lang": "en"}
    words = re.findall(r"[a-z]+", raw.lower())
    t["lang"] = "hinglish" if sum(w in HINGLISH_OUT for w in words) >= 2 else "en"

    # the "if they haven't paid in 2 hours, call them" clause comes out first, so its channel is not the main one
    work = raw
    fm = FOLLOW.search(work)
    if fm:
        unit = UNIT.get(fm.group(3).lower().rstrip("s") if fm.group(3).lower() not in UNIT else fm.group(3).lower(), 3600)
        ch_word = (fm.group(1) or fm.group(4) or "").lower()
        ch = next((c for c, rx in CH_RE.items() if ch_word and rx.search(ch_word)), None)
        t["followup"] = {"after_s": int(fm.group(2)) * unit, "channels": [ch] if ch else []}
        work = (work[:fm.start()] + work[fm.end():]).strip(" ,.")

    # who: an email and a phone number, then a name
    em = EMAIL.search(work)
    if em:
        t["email"] = em.group(0).lower()
    phones = [(m.span(), m.group(1) or m.group(2)) for m in PHONE.finditer(work)]
    spans = [em.span()] if em else []
    for span, num in phones:
        p = e164(num)
        if p and not t["phone"]:
            t["phone"] = p
        spans.append(span)
    clean = _strip(work, spans)

    # the explicit message, if one was given (quoted, after a colon, or "and say …")
    sm = SAY.search(clean)
    if sm:
        said = (sm.group(1) or sm.group(2) or sm.group(3) or "").strip()
        if said and not re.fullmatch(r"[⟂\s]*", said):
            t["say"] = said.replace(" ⟂ ", " ").strip()
            clean = clean[:sm.start()] + clean[sm.end():]

    # how much: a marked amount first, then a bare number that is not a time
    mm = MONEY.search(clean)
    if mm:
        t["amount"] = _amount(mm.group(1) or mm.group(3), mm.group(2) or mm.group(4))
    else:
        for b in BARE.finditer(clean):
            if TIME_AFTER.match(clean[b.end():]) or re.search(r"\b(?:at|by)\s*$", clean[:b.start()], re.I):
                continue
            t["amount"] = _amount(b.group(1) + (b.group(2) or ""), b.group(3))
            break
    if t["amount"] is not None and t["amount"] <= 0:
        t["amount"] = None

    # what: ask for money, pay, or only talk to them
    low = clean.lower()
    if REQUEST.search(clean):
        t["money"] = "request"
    elif PAY.search(clean) and not re.search(r"\bpay\w*\b[^.?!]{0,30}\b(?:link|request)\b", low):
        t["money"] = "pay"
    found = sorted((m.start(), c) for c, rx in CH_RE.items() for m in [rx.search(clean)] if m)
    t["channels"] = [c for _, c in found]
    t["channels_named"] = bool(found)
    is_call = "call" in t["channels"]
    t["action"] = t["money"] or ("call" if is_call else ("message" if found or re.search(
        r"\b(?:message|msg|text|tell|inform|notify|let\s+\w+\s+know|remind|bata\w*|yaad)\b", low) else None))

    # the name: after the verb or "to/from", or before "ko/se"
    for rx in (NAME_AFTER, NAME_HINDI):
        for m in rx.finditer(clean):
            first = m.group(1).strip(".'’-")
            if first.lower() in NOT_NAME or "⟂" in first or len(first) < 2:
                continue
            second = m.group(2) if rx is NAME_AFTER and len(m.groups()) > 1 else None
            if second and second.lower() in NOT_NAME:
                second = None
            t["name"] = " ".join(w[:1].upper() + w[1:] for w in [first, second] if w)
            break
        if t["name"]:
            break
    if not t["name"] and t["email"]:
        local = re.split(r"[._+\d-]", t["email"].split("@")[0])[0]
        if len(local) >= 3 and local.isalpha():
            t["name"] = local.title()

    # why: "for dinner", "about the ₹2,000 he owes"
    fr = FOR_REASON.search(clean)
    if fr:
        t["reason"] = ((fr.group(1) or "") + fr.group(2)).strip()
    else:
        ab = ABOUT.search(clean)
        if ab:
            t["reason"] = ((ab.group(1) or "") + ab.group(2)).replace(" ⟂ ", " ").strip(" ,.")
    if t["reason"] and (t["reason"].lower() in NOT_NAME or "⟂" in t["reason"]):
        t["reason"] = None
    return t


def merge_model(t: dict, got: dict | None) -> dict:
    """Fill what the rules missed from the model's reading (never contacts: those come from the words)."""
    if not got:
        return t
    if not t["action"] and got.get("action") in ("pay", "request", "message", "call"):
        t["action"] = got["action"]
        t["money"] = got["action"] if got["action"] in ("pay", "request") else t["money"]
    if not t["name"] and isinstance(got.get("name"), str) and re.fullmatch(r"[A-Za-z][A-Za-z .'-]{1,40}", got["name"]) \
            and got["name"].split()[0].lower() not in NOT_NAME:
        t["name"] = got["name"].strip().title()
    if t["amount"] is None and isinstance(got.get("amount"), (int, float)) and 0 < got["amount"] <= 10_000_000:
        t["amount"] = float(got["amount"])
    if not t["channels"] and isinstance(got.get("channels"), list):
        t["channels"] = [c for c in got["channels"] if c in CHANNELS][:3]
        t["channels_named"] = bool(t["channels"])
    if not t["reason"] and isinstance(got.get("reason"), str) and 2 <= len(got["reason"]) <= 60:
        t["reason"] = got["reason"].strip()
    return t


# ── what Nirnaya knows: settings, people, channels ───────────────────────────
class Ctx:
    """The engine, the channels hub and the ops, as one task needs them (any may be missing in a hint or a test)."""

    def __init__(self, e, channels=None, ops=None):
        self.e, self.ch, self.ops = e, channels, ops

    def settings(self) -> dict:
        s = {**DEFAULTS, **{k: v for k, v in (self.e.store.kv_get(KEY) or {}).items() if k in DEFAULTS}}
        if not s["from_name"]:
            name = ((self.ch.config()["email"].get("name") if self.ch else "") or "").strip()
            s["from_name"] = name if name and name != "Nirnaya Support" else "Nirnaya"
        return s

    def update(self, patch: dict) -> dict:
        cur = {**DEFAULTS, **(self.e.store.kv_get(KEY) or {})}
        for k, v in (patch or {}).items():
            if k not in DEFAULTS:
                raise ValueError(f"unknown setting {k}")
            if k in ("pay_cap", "daily_pay_cap", "request_cap"):
                v = float(v)
                if not 1 <= v <= 1_00_00_000:
                    raise ValueError(f"{k.replace('_', ' ')} must be between ₹1 and ₹1,00,00,000")
            elif k == "per_contact_hour":
                v = int(v)
                if not 1 <= v <= 50:
                    raise ValueError("contacts per hour must be between 1 and 50")
            else:
                v = re.sub(r"[\x00-\x1f<>]", "", str(v or "")).strip()[:80]
                if k == "upi_id" and v and not re.fullmatch(r"[\w.\-]{2,256}@[A-Za-z][A-Za-z0-9.\-]{1,64}", v):
                    raise ValueError("a UPI ID looks like name@bank")
            cur[k] = v
        self.e.store.kv_set(KEY, {k: cur[k] for k in DEFAULTS})
        return self.settings()

    # people: an earlier task, then the ledger's customers and the addresses linked to them
    def find(self, name: str | None) -> dict | None:
        if not name:
            return None
        key = name.strip().lower()
        known = (self.e.store.kv_get(PEOPLE) or {}).get(key)
        if known:
            return {**known, "from": "an earlier task"}
        first = key.split()[0]
        hits = [c for c in self.e.rails.customers()
                if c["name"].lower() == key or c["name"].lower().split()[0] == first]
        if len(hits) != 1:
            return None
        c = hits[0]
        out = {"name": c["name"], "email": (c.get("email") or "").lower() or None,
               "phone": e164(c.get("phone") or "") or None, "customer_id": c["id"], "from": "the ledger"}
        if self.ch:
            for ct in self.ch.contacts():
                if ct.get("customer_id") != c["id"]:
                    continue
                addr = ct.get("key") or ct.get("address") or ""
                if addr.startswith("email:") and not out["email"]:
                    out["email"] = addr[6:]
                elif addr.startswith("phone:") and not out["phone"]:
                    out["phone"] = e164(addr[6:]) or None
        return out

    def remember(self, t: dict) -> None:
        if not t.get("name") or not (t.get("email") or t.get("phone")):
            return
        people = self.e.store.kv_get(PEOPLE) or {}
        key = t["name"].lower()
        cur = people.get(key, {})
        people[key] = {"name": t["name"], "email": t.get("email") or cur.get("email"),
                       "phone": t.get("phone") or cur.get("phone"), "last": time.time()}
        self.e.store.kv_set(PEOPLE, dict(list(people.items())[-500:]))

    def route(self, channel: str) -> str | None:
        """native (a channel set up here), n8n, or None (nothing can send it yet)."""
        if not self.ch:
            return None
        cfg = self.ch.config()
        hook = cfg["hook"]
        pref = hook.get("outreach") or "auto"
        native = {"email": cfg["email"]["enabled"], "whatsapp": cfg["whatsapp"]["enabled"],
                  "call": cfg["voice"]["enabled"], "sms": False}.get(channel, False)
        n8n = bool(hook.get("outreach_url") or hook.get("url")) and pref != "never"
        if pref == "always" and n8n:
            return "n8n"
        if native:
            return "native"
        return "n8n" if n8n else None

    def recent(self, t: dict, within: float = 3600) -> int:
        keys = {k for k in (t.get("email"), t.get("phone")) if k}
        now = time.time()
        return sum(1 for x in (self.e.store.kv_get(LOG) or []) if x["key"] in keys and now - x["ts"] < within)

    def paid_today(self) -> float:
        start = time.mktime(time.localtime()[:3] + (0, 0, 0, 0, 0, -1))
        return sum(p["amount"] for p in self.e.rails.payouts() if p["at"] >= start)


def complete(t: dict, ctx: Ctx | None) -> dict:
    """Fill a person's email and phone from what is known, and pick a channel when none was named."""
    t = dict(t)
    t["contact_from"] = "your message" if (t.get("email") or t.get("phone")) else None
    if ctx and t.get("name"):
        p = ctx.find(t["name"])
        if p:
            if not t.get("email") and p.get("email"):
                t["email"] = p["email"]
                t["contact_from"] = t["contact_from"] or p["from"]
            if not t.get("phone") and p.get("phone"):
                t["phone"] = p["phone"]
                t["contact_from"] = t["contact_from"] or p["from"]
            t["name"] = p.get("name") or t["name"]
            t["customer_id"] = p.get("customer_id")
    if not t["channels"]:
        if t["action"] == "call":
            t["channels"] = ["call"]
        elif t.get("phone") and (t["action"] in ("request", "message") or not t.get("email")):
            t["channels"] = ["whatsapp"]
        elif t.get("email"):
            t["channels"] = ["email"]
        elif t.get("phone"):
            t["channels"] = ["whatsapp"]
    return t


def ask(t: dict, ctx: Ctx | None = None) -> str | None:
    """The one question to ask back, or None when the task can run."""
    who = t.get("name") or "them"
    sc = scope.check(t.get("text") or "", scope.STAFF)       # words only: code or general questions never go out
    if not sc["in_scope"]:
        return "Finance only: " + scope.refusal(scope.STAFF, sc["category"])
    if not t.get("action"):
        return "What should the agents do: pay them, ask them for money, message them, or call them?"
    if not (t.get("name") or t.get("email") or t.get("phone")):
        return "Who is it for? Add a name and an email or a phone number."
    if t["money"] in ("pay", "request") and not t.get("amount"):
        return f"How much should {'go to' if t['money'] == 'pay' else 'I ask'} {who}{'' if t['money'] == 'pay' else ' for'}? Add an amount, e.g. ₹500."
    if t["money"] is None and not (t.get("amount") or t.get("say") or (t.get("reason") and scope.FINANCE.search(t["reason"]))):
        return (f"What is the {'call' if t['action'] == 'call' else 'message'} about? Agents only reach out about money, "
                f"e.g. “about the ₹500 {who} owes”.")
    if t.get("say") and t["money"] is None and not scope.FINANCE.search(t["say"]) and not t.get("amount"):
        return "Agents only send messages about money (a payment, a request, a refund). Say what it is about."
    needs_phone = [c for c in t.get("channels", []) if c in ("whatsapp", "call", "sms")]
    needs_email = "email" in t.get("channels", [])
    if not t.get("channels"):
        return f"What's {who}'s email or phone number?"
    if needs_phone and not t.get("phone"):
        return f"What's {who}'s phone number (10 digits) for {CH_WORD[needs_phone[0]]}?"
    if needs_email and not t.get("email"):
        return f"What's {who}'s email address?"
    if t.get("followup") and t["money"] != "request":
        return "A follow-up “if they haven't paid” only fits a request for money."
    if ctx:
        s = ctx.settings()
        amt = t.get("amount") or 0
        if t["money"] == "pay" and amt > s["pay_cap"]:
            return f"{rs(amt)} is above the {rs(s['pay_cap'])} limit for one payment (Settings → Outreach)."
        if t["money"] == "request" and amt > s["request_cap"]:
            return f"{rs(amt)} is above the {rs(s['request_cap'])} limit for one request (UPI's usual limit)."
        for c in t["channels"]:
            if not ctx.route(c):
                where = {"email": "Channels → Email", "whatsapp": "Channels → WhatsApp", "call": "Channels → Calls",
                         "sms": "n8n"}[c]
                return (f"Nothing can send {CH_WORD[c]} yet: set it up in {where}, or connect n8n in Channels → "
                        "Webhooks.")
    return None


# ── who does what ────────────────────────────────────────────────────────────
def steps_for(t: dict) -> list[tuple[str, str]]:
    """(agent, what it does) in order: the desks a task like this goes through."""
    who = t.get("name") or "them"
    chans = " and ".join(CH_WORD[c] for c in t.get("channels") or []) or "their channel"
    out = [("sentry", "screens the instruction"), ("pii", "masks the email and phone"),
           ("triage", f"reads it: {describe(t)}")]
    if t["money"] == "pay":
        out += [("kyc", f"prepares the payout to {who}"), ("fraud", "checks the payee, the amount and today's total"),
                ("router", "routes it: a payment out always waits for a person"), ("seal", "seals the payment"),
                ("human", "approves it"), ("commit", "pays it through the Tool Gateway, once")]
    elif t["money"] == "request":
        out += [("upi", f"prepares the request for {rs(t['amount']) if t.get('amount') else 'the amount'}"),
                ("fraud", "checks the amount and how often we reached them"),
                ("router", "routes it: a request moves no money, so it goes ahead"),
                ("commit", "creates the payment link through the Tool Gateway")]
    else:
        out += [("fraud", "checks how often we reached them"), ("router", "routes it: no money moves, so it goes ahead")]
    out += [("responder", "words the message"), ("guard", "checks every amount and link in it"),
            ("responder", f"sends it by {chans}"), ("trail", "records it on the audit trail")]
    return out


def describe(t: dict) -> str:
    who = t.get("name") or (mask(t["email"]) if t.get("email") else mask(t["phone"]) if t.get("phone") else "someone")
    amt = rs(t["amount"]) if t.get("amount") else ""
    why = f" for {t['reason']}" if t.get("reason") and t["money"] else ""
    if t["money"] == "pay":
        head = f"pay {amt} to {who}{why}"
    elif t["money"] == "request":
        head = f"ask {who} for {amt}{why}"
    elif t["action"] == "call":
        head = f"call {who}" + (f" about {t['reason']}" if t.get("reason") else (f" about {amt}" if amt else ""))
    else:
        head = f"message {who}" + (f" about {t['reason']}" if t.get("reason") else (f" about {amt}" if amt else ""))
    if t.get("channels") and t["action"] != "call":
        head += " by " + " and ".join(CH_WORD[c] for c in t["channels"])
    elif t.get("channels") and t["action"] == "call" and len(t["channels"]) > 1:
        head += " (and " + " and ".join(CH_WORD[c] for c in t["channels"] if c != "call") + ")"
    if t.get("followup"):
        f = t["followup"]
        n, u = (f["after_s"] // 3600, "hour") if f["after_s"] % 3600 == 0 else (f["after_s"] // 60, "minute")
        head += f"; if unpaid after {n} {u}{'s' if n != 1 else ''}, " + (
            " and ".join(CH_WORD[c] for c in f["channels"]) if f["channels"] else "remind them") + " again"
    return head


def plan(text: str, ctx: Ctx | None = None) -> dict:
    """What the office bar shows while you type, and what a task will do."""
    t = complete(parse(text), ctx)
    q = ask(t, ctx)
    routes = {c: (ctx.route(c) if ctx else None) for c in t.get("channels") or []}
    title = describe(t)
    title = title[:1].upper() + title[1:]
    return {"kind": "outreach", "dept": "intake", "agent": "triage", "title": title[:120], "task": public(t),
            "steps": [{"agent": a, "doing": d} for a, d in steps_for(t)], "needs_ok": t["money"] == "pay",
            "routes": routes, "problem": q, "found": t.get("contact_from") if t.get("contact_from") not in (None, "your message") else None}


def public(t: dict) -> dict:
    return {"action": t.get("action"), "money": t.get("money"), "amount": t.get("amount"), "name": t.get("name"),
            "email": t.get("email"), "phone": t.get("phone"), "channels": t.get("channels") or [],
            "reason": t.get("reason"), "say": t.get("say"), "followup": t.get("followup"), "lang": t.get("lang")}


# ── the words that go out ────────────────────────────────────────────────────
def compose(t: dict, *, sender: str, link: str | None = None, test_link: bool = False, upi_id: str = "",
            simulated: bool = False, reminder: bool = False, channel: str = "whatsapp") -> tuple[str, str]:
    """(subject, text) from the task's facts only. Calls get a short script to be spoken."""
    first = (t.get("name") or "there").split()[0]
    amt = rs(t["amount"]) if t.get("amount") else ""
    why = f" for {t['reason']}" if t.get("reason") else ""
    hi = t.get("lang") == "hinglish"
    test = " (Razorpay test mode: no real money moves.)" if test_link else ""
    pay_line = (f" You can pay here: {link}{test}" if link else
                (f" Please pay to UPI ID {upi_id}." if upi_id else " Please reply to arrange it."))
    if reminder:
        subject = f"Reminder: {amt} pending" if amt else f"Reminder from {sender}"
        text = (f"Hi {first}, a gentle reminder: {amt}{why} is still pending.{pay_line} "
                "If you've already paid, please ignore this.")
    elif t["money"] == "request":
        subject = f"Payment request: {amt} from {sender}"
        text = (f"Namaste {first}, {sender} ne aapse {amt}{why} maange hain.{pay_line}" if hi else
                f"Hi {first}, {sender} has asked you for {amt}{why}.{pay_line}")
    elif t["money"] == "pay":
        subject = f"{amt} from {sender}"
        note = (" (Test: yeh Nirnaya demo payout hai; asli paisa nahi gaya.)" if hi else
                " (Test: this is a Nirnaya demo payout; no real money has moved.)") if simulated else ""
        text = (f"Namaste {first}, {sender} ne aapko {amt}{why} bheje hain.{note}" if hi else
                f"Hi {first}, {sender} has sent you {amt}{why}.{note}")
    else:
        subject = f"A note from {sender}"
        about = t.get("say") or (f"a reminder about {amt}{why}." if amt else (f"about {t['reason']}." if t.get("reason") else ""))
        text = f"Namaste {first}, {about}" if hi else f"Hi {first}, {about}"
    if channel == "call" and reminder:
        return subject, (f"Hello {first}, this is {sender}'s assistant with a gentle reminder: the {amt}{why} is still "
                         f"pending.{' We have sent you a link to pay.' if link else ''} If you've already paid, please "
                         "ignore this. Thank you.")
    if channel == "call":
        topic = (f"the {amt} you've been asked for{why}" if t["money"] == "request" else
                 f"the {amt} sent to you{why}" if t["money"] == "pay" else (t.get("say") or t.get("reason") or amt))
        extra = " We've also sent you a link to pay." if link and t["money"] == "request" and not reminder else ""
        text = f"Hello {first}, this is {sender}'s assistant calling about {topic}.{extra} Thank you."
    return subject, re.sub(r"\s+", " ", text).strip()


def check_words(text: str, t: dict, link: str | None) -> dict:
    """The Promise Guard on an outgoing message: amounts must be the task's own, the link must be intact."""
    facts = [f"amount {rs(t['amount'])}" if t.get("amount") else "", f"reason {t.get('reason') or ''}", t.get("say") or ""]
    g = promise_guard.check(text, [f for f in facts if f], True)
    if link and link not in text:
        g["ok"] = False
        g["violations"].append({"kind": "ungrounded", "detail": "the payment link is missing or changed"})
    for u in re.findall(r"https?://\S+", text):
        if not link or u.rstrip(".,)") != link:
            g["ok"] = False
            g["violations"].append({"kind": "ungrounded", "detail": f"a link that is not ours: {u[:40]}"})
    if not scope.answer_ok(text):
        g["ok"] = False
        g["violations"].append({"kind": "scope", "detail": "not a message about money"})
    return g


# ── running a task ───────────────────────────────────────────────────────────
def _dept(e, agent: str) -> str:
    a = e.roster.agents.get(agent)
    return a["department"] if a else "intake"


def _name(e, agent: str) -> str:
    a = e.roster.agents.get(agent)
    return a["name"] if a else agent


async def _step(ctx: Ctx, op: dict, agent: str, doing: str, fn=None):
    """One desk does one part: the office shows it working, the op card shows the step."""
    e = ctx.e
    rec = {"agent": agent, "name": _name(e, agent), "doing": doing, "at": time.time(), "ok": None, "note": ""}
    op.setdefault("steps", []).append(rec)
    op["doing"] = f"{rec['name']}: {doing}"
    ctx.ops._put(op)
    e.roster.work(agent, op["id"], doing)
    e.bus.publish("agent.status", agent=agent, status="working", case_id=op["id"], doing=doing, department=_dept(e, agent))
    if e.step_delay:
        await asyncio.sleep(min(0.4, e.step_delay))
    try:
        out = fn() if fn else None
        if asyncio.iscoroutine(out):
            out = await out
        rec.update(ok=True, note=str(out or "")[:240])
        return out
    except Exception as ex:
        rec.update(ok=False, note=str(ex)[:240])
        raise
    finally:
        e.roster.idle(agent)
        e.bus.publish("agent.status", agent=agent, status="idle", case_id=None, doing=None, department=_dept(e, agent))
        ctx.ops._put(op)


class Refused(Exception):
    """A desk stopped the task; the message says why, for the op card."""


async def run(ctx: Ctx, op: dict, *, approved: bool = False) -> dict:
    """Run (or continue, after an approval) one outreach op. Returns {"wait", "ask"} or {"ok", "result", "extra"}."""
    e = ctx.e
    t = op["outreach"]
    if t.get("followup_of"):
        return await _followup(ctx, op, t)
    try:
        if not approved:
            await _prepare(ctx, op, t)
            if t["money"] == "pay":
                return {"wait": True, "ask": op["prep"]["ask"]}
        else:
            await _step(ctx, op, "human", f"approved by {op.get('approved_by') or 'you'}")
        return await _finish(ctx, op, t)
    except Refused as r:
        e.trail.append("-", "outreach.refused", "outreach", {"op": op["id"], "why": str(r)})
        return {"ok": False, "result": f"Not done: {r}", "extra": {}}


async def _prepare(ctx: Ctx, op: dict, t: dict) -> None:
    e = ctx.e
    s = ctx.settings()

    def screen():
        v = e.sentry.check("outreach", t["text"])
        if v["verdict"] == "block":
            raise Refused("Sentry blocked it: " + "; ".join(r["detail"] for r in v["reasons"]))
        return f"Sentry {v['verdict']} ({v['latency_ms']} ms)"
    await _step(ctx, op, "sentry", "screens the instruction", screen)

    def masked():
        _, found = e.tok.tokenise(t["text"])
        return f"{len(found)} identifier(s) masked before any model reads it"
    await _step(ctx, op, "pii", "masks the email and phone", masked)
    await _step(ctx, op, "triage", f"reads it: {describe(t)}", lambda: describe(t))

    if t["money"] == "pay":
        await _step(ctx, op, "kyc", f"prepares the payout to {t.get('name') or 'them'}",
                    lambda: f"from the float ({rs(e.rails.float_balance())} available)")
    elif t["money"] == "request":
        await _step(ctx, op, "upi", f"prepares the request for {rs(t['amount'])}",
                    lambda: "a Razorpay test payment link" if e.pg and e.pg.ready() else
                    (f"a request to pay UPI ID {s['upi_id']}" if s["upi_id"] else "a request, no link (Razorpay is not set up)"))

    def risk():
        notes = []
        n = ctx.recent(t)
        if n >= s["per_contact_hour"]:
            raise Refused(f"{t.get('name') or 'this person'} was already contacted {n} times in the last hour "
                          f"(limit {s['per_contact_hour']}); try later")
        notes.append(f"{n} contact(s) in the last hour")
        amt = t.get("amount") or 0
        if t["money"] == "pay":
            if amt > s["pay_cap"]:
                raise Refused(f"{rs(amt)} is above the {rs(s['pay_cap'])} limit for one payment")
            today = ctx.paid_today()
            if today + amt > s["daily_pay_cap"]:
                raise Refused(f"{rs(today)} already paid out today; {rs(amt)} more would pass the "
                              f"{rs(s['daily_pay_cap'])} daily limit")
            if amt > e.rails.float_balance():
                raise Refused(f"the float has only {rs(e.rails.float_balance())}")
            first = not any(p["to"].get("email") == t.get("email") and t.get("email") or
                            p["to"].get("phone") == t.get("phone") and t.get("phone") for p in e.rails.payouts())
            notes += [f"{'new payee' if first else 'paid before'}", f"{rs(amt)} of the {rs(s['pay_cap'])} limit",
                      f"{rs(today)} paid out today"]
        elif t["money"] == "request" and amt > s["request_cap"]:
            raise Refused(f"{rs(amt)} is above the {rs(s['request_cap'])} limit for one request")
        return " · ".join(notes)
    op["risk"] = await _step(ctx, op, "fraud", "checks the payee, the amount and how often we reached them", risk)
    await _step(ctx, op, "router", "routes it", lambda: "ESCALATE: a payment out always waits for a person"
                if t["money"] == "pay" else "ACT: no money leaves, so it goes ahead")

    if t["money"] == "pay":
        payload = {"op": op["id"], "to": {"name": t.get("name"), "email": t.get("email"), "phone": t.get("phone")},
                   "amount": t["amount"], "reason": t.get("reason"), "channels": t["channels"]}
        seal = await _step(ctx, op, "seal", "seals the payment", lambda: e.gateway.seal_payout(payload))
        to = " · ".join(x for x in (t.get("email"), t.get("phone")) if x)
        op["prep"] = {"payload": payload, "seal": seal,
                      "ask": (f"Pay {rs(t['amount'])} to {t.get('name') or to} ({to}){' for ' + t['reason'] if t.get('reason') else ''}, "
                              f"then tell them by {' and '.join(CH_WORD[c] for c in t['channels'])}. "
                              f"Risk & Fraud: {op['risk']}. Sealed {seal[:12]}… — if the float moves before you approve, "
                              f"nothing is paid.")}
        ctx.ops._put(op)


async def _finish(ctx: Ctx, op: dict, t: dict) -> dict:
    e = ctx.e
    s = ctx.settings()
    link, test_link, simulated, receipt = None, False, False, None
    if t["money"] == "pay":
        prep = op.get("prep") or {}

        def pay():
            r = e.gateway.execute_payout(op_id=op["id"], payload=prep["payload"], seal=prep["seal"], agent="commit")
            if not r["ok"]:
                raise Refused("the ground moved: the float changed after the seal, so the old approval does not apply. "
                              "Nothing was paid; add the task again" if r.get("reason") == "seal_mismatch" else r.get("error") or "the payment failed")
            return r
        receipt = await _step(ctx, op, "commit", "pays it through the Tool Gateway, once", pay)
        simulated = True
    elif t["money"] == "request" and e.pg and e.pg.ready():
        def make_link():
            r = e.gateway.request_link(op_id=op["id"], to={"name": t.get("name"), "email": t.get("email"),
                                                             "phone": t.get("phone")},
                                       amount=t["amount"], description=t.get("reason") or f"Request from {s['from_name']}",
                                       agent="commit")
            if not r["ok"]:
                raise Refused(r.get("error") or "the payment link could not be made")
            return r
        receipt = await _step(ctx, op, "commit", "creates the payment link through the Tool Gateway", make_link)
        link, test_link = receipt["result"].get("short_url"), True

    words: dict[str, tuple[str, str]] = {}

    def word():
        for c in t["channels"]:
            subject, text = compose(t, sender=s["from_name"], link=link, test_link=test_link, upi_id=s["upi_id"],
                                    simulated=simulated, channel=c)
            if c != "call" and e.llm.enabled:
                facts = [f"Amount: {rs(t['amount'])}" if t.get("amount") else "", f"Link: {link}" if link else "",
                         f"Reason: {t['reason']}" if t.get("reason") else "", f"Recipient: {(t.get('name') or '').split(' ')[0]}"]
                draft = e.llm.draft_reply([f for f in facts if f], text, t.get("lang") or "en")
                keep = (not test_link or "test" in (draft or "").lower()) and (not simulated or "test" in (draft or "").lower())
                if draft and keep and check_words(draft, t, link)["ok"]:
                    text = draft
            words[c] = (subject, text)
        return f"{len(words)} message(s) worded" + (" by the free model" if e.llm.enabled else "")
    await _step(ctx, op, "responder", "words the message", word)

    def guard():
        bad = {c: check_words(txt, t, link) for c, (_, txt) in words.items()}
        for c, g in bad.items():
            if not g["ok"]:   # the plain version from the facts goes instead
                words[c] = compose(t, sender=s["from_name"], link=link, test_link=test_link, upi_id=s["upi_id"],
                                   simulated=simulated, channel=c)
        return "every amount and link checked against the task"
    await _step(ctx, op, "guard", "checks every amount and link in it", guard)

    sent = []

    async def send_all():
        for c in t["channels"]:
            subject, text = words[c]
            r = await deliver(ctx, op, t, c, subject, text, link=link)
            sent.append(r)
        ok = [x for x in sent if x["ok"]]
        return ", ".join(f"{CH_WORD[x['channel']]} via {x['via']}: {'sent' if x['ok'] else x['error']}" for x in sent) \
            if ok or sent else "nothing to send"
    await _step(ctx, op, "responder", f"sends it by {' and '.join(CH_WORD[c] for c in t['channels'])}", send_all)

    good = [x for x in sent if x["ok"]]
    ctx.remember(t)
    log_ = (e.store.kv_get(LOG) or []) + [{"key": k, "ts": time.time(), "op": op["id"]} for k in (t.get("email"), t.get("phone")) if k]
    e.store.kv_set(LOG, log_[-500:])
    follow_id = None
    if t.get("followup") and good and ctx.ops is not None:
        f = t["followup"]
        task = {**t, "followup_of": op["id"], "channels": f["channels"] or t["channels"], "link": link,
                "link_id": (receipt or {}).get("result", {}).get("id") if receipt else None, "followup": None}
        fop = ctx.ops.create("outreach", dept="intake", agent="triage", title=f"Follow up: {describe(task)}"[:120],
                             text=t["text"], by=op.get("by") or "you", due_at=time.time() + f["after_s"],
                             needs_ok=False, extra={"outreach": task})
        follow_id = fop["id"]

    def record():
        e.trail.append("-", "outreach.done", "trail", {"op": op["id"], "action": t["action"], "amount": t.get("amount"),
                                                         "channels": [x["channel"] for x in good],
                                                         "failed": [x["channel"] for x in sent if not x["ok"]],
                                                         "receipt": (receipt or {}).get("idempotency_key")})
        return "recorded"
    await _step(ctx, op, "trail", "records it on the audit trail", record)

    what = describe(t)
    what = what[:1].upper() + what[1:]
    parts = [f"{what}."]
    if receipt and t["money"] == "pay":
        parts.append(f"Paid ({receipt['result']['id']}, simulated payout).")
    if link:
        parts.append(f"Link: {link}.")
    parts.append("; ".join(f"{CH_WORD[x['channel']]} via {x['via']}: " + ("sent" if x["ok"] else f"failed — {x['error']}") for x in sent))
    if follow_id:
        parts.append(f"Follow-up booked as {follow_id}.")
    extra = {"sent": sent, "link": link, "receipt": receipt, "followup_id": follow_id}
    return {"ok": bool(good) and len(good) == len(sent), "result": " ".join(p for p in parts if p), "extra": extra}


async def _followup(ctx: Ctx, op: dict, t: dict) -> dict:
    """The "if they haven't paid in N hours" check: look at the link, and remind them only if it is unpaid."""
    e = ctx.e
    s = ctx.settings()
    status = None

    def look():
        nonlocal status
        if t.get("link_id") and e.pg and e.pg.ready():
            status = e.pg.link_status(t["link_id"])
            return f"the payment link is {status}"
        return "no link to check; the reminder says to ignore it if already paid"
    await _step(ctx, op, "upi", "checks whether they have paid", look)
    if status == "paid":
        e.trail.append("-", "outreach.followup", "trail", {"op": op["id"], "of": t["followup_of"], "paid": True})
        return {"ok": True, "result": f"{t.get('name') or 'They'} paid {rs(t['amount'])}: no reminder needed.", "extra": {"paid": True}}
    sent = []

    async def remind():
        for c in t["channels"]:
            subject, text = compose(t, sender=s["from_name"], link=t.get("link"), test_link=bool(t.get("link")),
                                    upi_id=s["upi_id"], reminder=True, channel=c)
            sent.append(await deliver(ctx, op, t, c, subject, text, link=t.get("link")))
        return "; ".join(f"{CH_WORD[x['channel']]}: {'sent' if x['ok'] else x['error']}" for x in sent)
    await _step(ctx, op, "responder", f"reminds them by {' and '.join(CH_WORD[c] for c in t['channels'])}", remind)
    e.trail.append("-", "outreach.followup", "trail", {"op": op["id"], "of": t["followup_of"], "paid": False,
                                                       "channels": [x["channel"] for x in sent if x["ok"]]})
    good = [x for x in sent if x["ok"]]
    return {"ok": bool(good), "result": f"Not paid yet ({status or 'unknown'}): reminded {t.get('name') or 'them'} by "
            + ", ".join(f"{CH_WORD[x['channel']]} ({'sent' if x['ok'] else 'failed: ' + x['error']})" for x in sent) + ".",
            "extra": {"sent": sent, "paid": False}}


async def deliver(ctx: Ctx, op: dict, t: dict, channel: str, subject: str, text: str, *, link: str | None) -> dict:
    """Send one message (or place one call) natively or through n8n. Never raises: the result says what happened."""
    via = ctx.route(channel)
    to = t.get("email") if channel == "email" else t.get("phone")
    out = {"channel": channel, "via": via or "nothing", "to": mask(to or ""), "ok": False, "error": None, "id": None}
    if not via:
        out["error"] = "not set up (Channels, or n8n in Channels → Webhooks)"
        return out
    if not to:
        out["error"] = f"no {'email' if channel == 'email' else 'phone number'}"
        return out
    try:
        r = await ctx.e.gateway.outreach_send(op["id"], channel, _sender(ctx, op, t, channel, via, to, subject, text, link))
        out.update(ok=True, id=r.get("id") or r.get("msg_id") or r.get("sid") or r.get("conv_id"))
    except Exception as ex:
        out["error"] = str(ex)[:200]
    return out


def _sender(ctx: Ctx, op, t, channel, via, to, subject, text, link):
    async def go() -> dict:
        by = (op.get("by") if op.get("by") not in (None, "you") else "outreach")[:32]
        if via == "native":
            if channel == "call":
                return await ctx.ch.call(to, text, by=by)
            return await ctx.ch.send(channel, to, text, subject=subject if channel == "email" else "", by=by)
        payload = {"event": "outreach.send", "dry_run": False, "op_id": op["id"], "channel": channel,
                   "to": {"name": t.get("name"), "email": t.get("email"), "phone": t.get("phone")},
                   "subject": subject, "text": text, "lang": t.get("lang") or "en",
                   "money": {"kind": t.get("money"), "amount": t.get("amount"), "currency": "INR", "link": link,
                             "test_mode": bool(link)},
                   "from": {"name": ctx.settings()["from_name"], "by": op.get("by")}}
        return await asyncio.to_thread(post_n8n, ctx.ch, payload)
    return go


def post_n8n(channels, payload: dict) -> dict:
    """POST one task to the n8n workflow (Channels → Webhooks URL, with the token) and read its answer."""
    from .channels.http import ChannelError, request
    hook = channels.config()["hook"]
    url = hook.get("outreach_url") or hook.get("url")      # its own URL, so case events do not reach it
    if not url:
        raise ChannelError("n8n is not connected (Channels → Webhooks → Agents' outreach URL)")
    headers = {"X-Nirnaya-Token": hook["token"]} if hook.get("token") else {}
    r = request("POST", url, json_body=payload, headers=headers, timeout=30)
    if r.get("ok") is False:
        raise ChannelError(f"n8n: {r.get('error') or 'refused'}")
    if r.get("ok") is not True:    # a workflow that only says "received" has not said it sent anything
        raise ChannelError("n8n did not confirm it was sent (is the Nirnaya workflow published at that URL?)")
    return {"id": r.get("id") or "n8n"}


# ── the office bar and the agent chat ────────────────────────────────────────
async def create(ctx: Ctx, text: str, *, by: str = "you", due_at: float | None = None, model: bool = True) -> dict:
    """A new outreach op, or ValueError with the question to ask."""
    t = parse(text)
    if model and (not t["action"] or not t["name"]) and ctx.e.llm.enabled:
        masked, _ = ctx.e.tok.tokenise(text)
        t = merge_model(t, await asyncio.to_thread(ctx.e.llm.extract_outreach, masked))
    t = complete(t, ctx)
    q = ask(t, ctx)
    if q:
        raise ValueError(q)
    title = describe(t)
    return ctx.ops.create("outreach", dept="intake", agent="triage", title=(title[:1].upper() + title[1:])[:120],
                          text=text, by=by, due_at=due_at, needs_ok=t["money"] == "pay",
                          extra={"outreach": t, "plan_steps": len(steps_for(t))})


CANCEL = re.compile(r"^\s*(?:cancel|stop|never\s*mind|nevermind|forget\s+it|drop\s+it|no\b|nahi|rehne\s+do|chhodo)", re.I)
QUESTION = re.compile(r"^\s*(?:what|who|when|where|why|how|which|is|are|do|does|did|can|could|show|list|status)\b", re.I)


def answerish(text: str) -> bool:
    """Could this be the answer to "what's her email?" (an address, a number, an amount, a channel, a name)?"""
    t = text.strip()
    if EMAIL.search(t) or PHONE.search(t) or MONEY.search(t) or any(rx.search(t) for rx in CH_RE.values()):
        return True
    if t.endswith("?") or QUESTION.match(t):
        return False
    return len(re.findall(r"\w+", t)) <= 4 or bool(BARE.search(t))


async def chat(ctx: Ctx, agent: str, text: str, by: str) -> dict | None:
    """In an agent's chat: start a task, or answer the question a task is waiting on. None: not outreach."""
    drafts = ctx.e.store.kv_get(DRAFTS) or {}
    d = drafts.get(agent)
    if d and time.time() - d["ts"] > DRAFT_TTL:
        d = None
    fresh = looks_like(text)
    if not fresh:
        if not d:
            return None
        if CANCEL.match(text):
            drafts.pop(agent, None)
            ctx.e.store.kv_set(DRAFTS, drafts)
            return {"reply": "OK, I've dropped it. Nothing was sent or paid."}
        if not answerish(text):
            return None          # talking about something else; the task keeps waiting for its answer
        text = f"{d['text']} {text}"
    try:
        op = await create(ctx, text, by=by)
    except ValueError as q:
        drafts[agent] = {"text": text, "ts": time.time()}
        ctx.e.store.kv_set(DRAFTS, drafts)
        return {"reply": f"{q} (or say “cancel”)", "asking": True}
    drafts.pop(agent, None)
    ctx.e.store.kv_set(DRAFTS, drafts)
    t = op["outreach"]
    desks = " → ".join(dict.fromkeys(_name(ctx.e, a) for a, _ in steps_for(t)))
    tail = (" It will wait for your OK in Approvals before any money moves." if t["money"] == "pay" else "")
    return {"reply": f"On it as {op['id']}: {op['title'][:1].lower() + op['title'][1:]}. {desks}.{tail}", "op": op}
