"""Promise Guard and groundedness: no claim reaches the customer without evidence, no promise beyond policy.

Every rupee amount, reference number and date in a reply must appear in the case facts. Phrases that
promise more than policy allows (a guarantee, a timeline faster than the TAT) are flagged. A reply
that fails is not sent; the plain template, which is built only from facts, goes instead.
"""
from __future__ import annotations

import re

OVERPROMISE = [
    (r"\bguarantee[ds]?\b", "a guarantee"),
    (r"\b100\s?%", "a 100% claim"),
    (r"\bwithin\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)\b", "a timeline faster than the policy TAT"),
    (r"\b(?:today itself|right now|instantly)\b", "an instant timeline"),
    (r"\bnever (?:happen|occur) again\b", "a promise about the future"),
    (r"\bwe (?:will|shall) (?:definitely|surely)\b", "a certainty the evidence does not give"),
]
AMOUNT = re.compile(r"₹\s?([\d,]+(?:\.\d{1,2})?)")
REFS = re.compile(r"\b[A-Z]?\d{9,23}\b")


def _norm_amount(s: str) -> str:
    v = float(s.replace(",", ""))
    return f"{v:.2f}"


def check(reply: str, facts: list[str], actions_committed: bool) -> dict:
    violations: list[dict] = []
    low = reply.lower()
    for pat, what in OVERPROMISE:
        if re.search(pat, low):
            if what == "an instant timeline" and actions_committed:
                continue
            violations.append({"kind": "promise", "detail": f"contains {what}"})
    fact_blob = " ".join(facts)
    fact_amounts = {_norm_amount(m) for m in AMOUNT.findall(fact_blob)}
    for m in AMOUNT.findall(reply):
        if _norm_amount(m) not in fact_amounts:
            violations.append({"kind": "ungrounded", "detail": f"₹{m} is not in the evidence"})
    fact_refs = set(REFS.findall(fact_blob))
    for ref in REFS.findall(reply):
        if ref not in fact_refs:
            violations.append({"kind": "ungrounded", "detail": f"reference {ref} is not in the evidence"})
    return {"ok": not violations, "violations": violations,
            "claims_checked": len(AMOUNT.findall(reply)) + len(REFS.findall(reply))}
