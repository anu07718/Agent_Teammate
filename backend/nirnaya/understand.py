"""Understanding: intent and entities from the tokenised message. English and Hinglish, no model needed.

When an LLM key is configured, `llm.extract` can refine this; the rules stay the fallback and the
floor, so the demo and the tests are deterministic.
"""
from __future__ import annotations

import re

from .pii import TXN_REF

DEBIT = ["debited", "deducted", "kat gaya", "kat gaye", "cut from", "money gone", "paisa kat", "amount cut",
         "charged", "kata", "gone from my account"]
FAIL = ["failed", "fail", "not credited", "didn't go through", "did not go through", "pending", "stuck",
        "unsuccessful", "declined", "not received", "nahi aaya", "nahi mila", "wapas nahi"]
INTENTS: dict[str, list[tuple[str, float]]] = {
    "refund_status": [("refund", 2.0), ("refunded", 2.0), ("money back", 1.5), ("return", 0.8), ("refund nahi", 2.0)],
    "duplicate_charge": [("twice", 2.5), ("two times", 2.5), ("double", 2.0), ("duplicate", 2.5), ("do baar", 2.5),
                         ("charged 2", 2.0)],
    "wrong_beneficiary": [("wrong upi", 3.0), ("wrong vpa", 3.0), ("wrong number", 2.5), ("wrong account", 3.0),
                          ("wrong person", 3.0), ("galat", 2.5), ("by mistake", 2.0), ("mistakenly sent", 3.0)],
    "unauthorized": [("not done by me", 3.0), ("didn't do", 2.0), ("did not do", 2.0), ("unauthori", 3.0),
                     ("fraud", 3.0), ("hacked", 3.0), ("scam", 2.0), ("someone used", 3.0), ("never made", 3.0),
                     ("i did not make", 3.0), ("maine nahi kiya", 3.0)],
    "block_request": [("block my card", 3.0), ("block card", 3.0), ("block upi", 3.0), ("block my upi", 3.0),
                      ("freeze", 2.0), ("card block", 3.0), ("upi block", 3.0), ("block kar", 2.0)],
    "kyc": [("kyc", 3.0), ("aadhaar update", 2.5), ("pan update", 2.5), ("limit", 1.2), ("re-kyc", 3.0)],
    "balance": [("balance", 2.5), ("statement", 2.5), ("mini statement", 3.0)],
}
HINGLISH = ["mera", "meri", "nahi", "hua", "paisa", "kal", "abhi", "kya", "wapas", "gaya", "kiya", "hai", "ka", "ki",
            "hain", "mujhe", "chahiye", "kaise", "kab", "kyun", "aaya", "mila", "karo", "kijiye"]
MERCHANT = re.compile(r"\b(?:to|at|from|on|for)\s+([A-Z][\w&'-]+(?:\s[A-Z][\w&'-]+)?)")
_NUM = r"(\d{1,3}(?:,\d{2,3})+|\d{2,7})(?:\.\d{1,2})?"
AMOUNT = [re.compile(r"(?:₹|rs\.?|inr|rupees?)\s?([\d,]+(?:\.\d{1,2})?)", re.I),
          re.compile(r"\b([\d,]{2,}(?:\.\d{1,2})?)\s?(?:₹|rs\b|rupees|inr)", re.I),
          # no currency said: "mera 1000 ka payment", "payment of 2000", "paid 500 to Zomato"
          re.compile(r"\b" + _NUM + r"\s*(?:ka|ki|ke|wala|vala)\b", re.I),
          re.compile(r"\b(?:payment|paid|pay|sent|send|transferred|debited|deducted|charged|cut)\s+(?:of\s+|for\s+)?"
                     + _NUM + r"\b(?!\s*(?:days?|din|hours?|ghante|am|pm|digits?|baar|times?))", re.I),
          # "my 1500 IRCTC payment", "my 500 recharge"
          re.compile(r"\b" + _NUM + r"\s+(?:[A-Za-z][\w&'.-]*\s+){0,2}(?:payment|transaction|txn|recharge|order|bill|"
                     r"transfer|booking|refund|charge)s?\b", re.I),
          # last: a lone amount anywhere ("charged me twice 750"), never a phone number, UTR, ID, time or count
          re.compile(r"(?<![\w.,:/-])(?<!\d )(?<!\bin )(?<!since )" + _NUM
                     + r"(?![\w,:/%-]|\s\d|\s*(?:days?|din|hours?|ghante|mins?|minutes?|am|pm|digits?|baar|times?|st|nd|rd|th)\b)",
                     re.I)]


def extract_entities(text: str) -> dict:
    low = text.lower()
    ent: dict = {}
    for pat in AMOUNT:
        m = pat.search(text)
        if m:
            try:
                ent["amount"] = float(m.group(1).replace(",", ""))
                break
            except ValueError:
                pass
    m = re.search(TXN_REF + r"(\d{12})", text, re.I)
    if m:
        ent["utr"] = m.group(1)
    if re.search(r"\b(?:today|aaj)\b", low):
        ent["days_ago"] = 0
    elif re.search(r"\b(?:yesterday|kal)\b", low):
        ent["days_ago"] = 1
    else:
        m = re.search(r"\b(\d{1,2})\s*(?:days?|din)\s*(?:ago|pehle|back)\b", low)
        if m:
            ent["days_ago"] = int(m.group(1))
    m = MERCHANT.search(text)
    if m and m.group(1).lower() not in {"my", "the", "upi", "i", "me"}:
        ent["merchant"] = m.group(1)
    if re.search(r"\bcard\b", low):
        ent["instrument"] = "card"
    elif "upi" in low or "@" in text:
        ent["instrument"] = "upi"
    ent["language"] = "hinglish" if sum(w in re.findall(r"[a-z]+", low) for w in HINGLISH) >= 2 else "en"
    return ent


def classify(text: str) -> dict:
    low = text.lower()
    scores: dict[str, float] = {k: 0.0 for k in INTENTS}
    for intent, words in INTENTS.items():
        scores[intent] = sum(w for kw, w in words if kw in low)
    debit = any(k in low for k in DEBIT)
    fail = any(k in low for k in FAIL)
    scores["failed_debit"] = (2.0 if debit else 0) + (1.5 if fail else 0) + (0.5 if debit and fail else 0)
    if scores["refund_status"] and scores["failed_debit"] and "refund" in low and not debit:
        scores["failed_debit"] *= 0.5
    if scores["duplicate_charge"] and debit:
        scores["duplicate_charge"] += 1.0
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    (top, s1), (second, s2) = ranked[0], ranked[1]
    if s1 <= 0:
        return {"intent": "other", "confidence": 0.2, "scores": scores, "runner_up": None}
    margin = s1 / (s1 + s2 + 0.75)
    return {"intent": top, "confidence": round(min(0.97, margin), 3), "scores": scores,
            "runner_up": second if s2 > 0 else None}


def understand(text: str) -> dict:
    intent = classify(text)
    ent = extract_entities(text)
    conf = intent["confidence"]
    if intent["intent"] != "other":
        conf = min(0.98, conf + (0.08 if "amount" in ent else 0) + (0.05 if "utr" in ent or "days_ago" in ent else 0))
    return {**intent, "confidence": round(conf, 3), "entities": ent, "source": "rules"}
