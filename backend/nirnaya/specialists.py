"""Specialists: match the message to a transaction, then turn verified evidence into a typed action plan.

A plan is advisory. It names actions and the evidence for each; it cannot move money. Moving money is
the Tool Gateway's job, and only after calibration, shadow execution, the recheck and the Seal.
"""
from __future__ import annotations

import math
import re
import time

from .policy import Policy
from .rails import DAY, Rails
from .replies import rs

SPECIALIST = {"failed_debit": "upi", "duplicate_charge": "refund", "refund_status": "refund",
              "unauthorized": "fraud", "wrong_beneficiary": "fraud", "block_request": "fraud", "kyc": "kyc",
              "balance": "kyc", "other": "triage"}
INTENT_FIT = {"failed_debit": lambda t: t["npci_status"] in ("FAILED", "PENDING"),
              "duplicate_charge": lambda t: bool(t.get("duplicate_of")),
              "refund_status": lambda t: t["refund"]["status"] != "NONE",
              "unauthorized": lambda t: bool(t.get("unrecognised")),
              "wrong_beneficiary": lambda t: bool(t.get("wrong_beneficiary"))}


def match_txn(rails: Rails, customer_id: str, intent: str, ent: dict, text: str = "") -> dict:
    txns = rails.txns_for(customer_id)
    low = (text or "").lower()
    now = time.time()
    scored = []
    for t in txns:
        s, why = 0.0, []
        if "utr" in ent and ent["utr"] == t["utr"]:
            s += 6
            why.append("UTR matches")
        if "amount" in ent and abs(ent["amount"] - t["amount"]) < 0.5:
            s += 3
            why.append("amount matches")
        if "days_ago" in ent and abs((now - t["created_at"]) / DAY - ent["days_ago"]) <= 1.0:
            s += 1
            why.append("date matches")
        name = t["merchant"].lower().split("@")[0].split()[0] if t["merchant"] else ""
        if "merchant" in ent and ent["merchant"].lower() in t["merchant"].lower():
            s += 2
            why.append("merchant matches")
        elif len(name) >= 3 and re.search(rf"\b{re.escape(name)}\b", low):   # "my IRCTC payment", no "to" or "at"
            s += 2
            why.append("merchant named")
        fit = INTENT_FIT.get(intent)
        if fit and fit(t):
            s += 1.5
            why.append("status fits the complaint")
        scored.append((s, t, why))
    scored.sort(key=lambda x: -x[0])
    if not scored or scored[0][0] < 2.5:
        return {"txn_id": None, "confidence": 0.0, "why": ["no transaction matches the details given"],
                "candidates": [t["id"] for _, t, _ in scored[:3]], "asked": ent.get("amount")}
    best, second = scored[0], (scored[1] if len(scored) > 1 else (0, None, []))
    conf = best[0] / (best[0] + second[0] + 1.0)
    return {"txn_id": best[1]["id"], "confidence": round(min(0.99, 0.35 + conf), 3), "why": best[2],
            "candidates": [t["id"] for _, t, _ in scored[:3]]}


def _date(ts: float) -> str:
    return time.strftime("%d %b", time.localtime(ts))


def plan(policy: Policy, rails: Rails, intent: str, customer_id: str, match: dict, evidence: dict) -> dict:
    tid = match.get("txn_id")
    now = time.time()
    specialist = SPECIALIST.get(intent, "triage")
    facts: list[str] = []
    acts: list[dict] = []

    def act(kind, amount=0.0, reason="", agree=1.0, **kw):
        acts.append({"type": kind, "amount": round(float(amount), 2), "txn_id": tid, "reason": reason,
                     "evidence_agree": agree, **kw})

    if intent in ("kyc", "balance"):
        acct = rails.account(rails.customer(customer_id)["account"])
        if intent == "balance":
            facts.append(f"Available balance is {rs(acct['balance'])}")
            act("share_status", reason="balance enquiry", key="balance", vars={"balance": acct["balance"]})
        else:
            facts.append("Re-KYC can be completed in the app under Profile → KYC in about 5 minutes")
            act("share_status", reason="KYC guidance", key="kyc")
        return {"specialist": "kyc", "txn_id": None, "actions": acts, "facts": facts}

    if intent == "block_request":
        act("block_instrument", reason="customer asked for a block", instrument=evidence.get("instrument", "upi"))
        facts.append("A block request was received from the registered customer")
        return {"specialist": "fraud", "txn_id": tid, "actions": acts, "facts": facts}

    if not tid:
        # name the customer's own nearest payments, so the answer is about them and not a form to fill
        fit = INTENT_FIT.get(intent)
        recent = sorted(rails.txns_for(customer_id), key=lambda x: -x["created_at"])
        pool = ([x for x in recent if fit and fit(x)] or recent)[:3]
        facts.append("No matching transaction was found on the account for the details shared")
        asked = match.get("asked")
        if asked:
            facts.append(f"The customer mentioned {rs(asked)}")
        if pool:
            for x in pool:
                facts.append(f"Recent payment {x['id']}: {rs(x['amount'])} to {x['merchant']} on {_date(x['created_at'])}")
            listed = "; ".join(f"{rs(x['amount'])} to {x['merchant']} on {_date(x['created_at'])}" for x in pool)
            act("request_info", reason="cannot match a transaction", agree=0.5, key="need_pick" if asked else "need_pick_any",
                vars={"list": listed, "asked": rs(asked) if asked else ""})
        else:
            act("request_info", reason="cannot match a transaction", agree=0.5, key="need_utr")
        return {"specialist": specialist, "txn_id": None, "actions": acts, "facts": facts}

    t = rails.txn(tid)
    # the payment itself says what kind of problem it is: "my 2,000 payment failed, I want a refund" is a failed
    # debit, and "my 1,000 payment" alone is answered by the state that payment is in
    guessed = False
    if intent == "refund_status" and t["npci_status"] in ("FAILED", "PENDING") and t["refund"]["status"] == "NONE":
        intent = "failed_debit"
    elif intent in ("other", "kyc") and tid:
        guessed = True
        intent = ("refund_status" if t["refund"]["status"] != "NONE" else
                  "duplicate_charge" if t.get("duplicate_of") else "failed_debit")
    upi, debit, refund = evidence.get("upi", {}), evidence.get("debit", {}), evidence.get("refund", {})
    amount = t["amount"]
    facts += [f"Transaction {tid} of {rs(amount)} to {t['merchant']} on {_date(t['created_at'])}",
              f"UTR {t['utr']}" if t["utr"] else "No UTR from the bank yet"]
    agree = 1.0 if upi and debit else 0.5
    if guessed:                     # the customer did not say what is wrong: nothing moves without a person
        agree = 0.5
    pg = evidence.get("pg")
    if t.get("source") == "razorpay_test":
        if pg:
            facts.append(f"Razorpay (test mode) has {tid} as {pg.get('status')}"
                         + (f" by {pg['method'].upper()}" if pg.get("method") else "")
                         + (f", RRN {pg['rrn']}" if pg.get("rrn") else "")
                         + (f"; {rs(pg['amount_refunded'])} already refunded" if pg.get("amount_refunded") else ""))
        else:
            facts.append("Razorpay could not be checked just now, so nothing moves without a person")
            agree = 0.5

    if intent == "failed_debit":
        facts.append(f"UPI switch status: {upi.get('npci_status', 'unknown')}; account debit: {debit.get('debit_status', 'unknown')}")
        if debit.get("debit_status") == "NOT_DEBITED":
            why = (pg or {}).get("error_description")
            facts.append("The payment failed before any money was taken" + (f" ({why})" if why else ""))
            act("share_status", reason="failed without a debit", agree=agree, key="not_debited")
        elif upi.get("npci_status") == "SUCCESS":
            facts.append(f"The payment succeeded and {t['merchant']} was credited")
            act("share_status", reason="payment actually succeeded", agree=agree, key="succeeded")
        elif t["reversal"]["status"] == "REVERSED":
            rrn = t["reversal"].get("rrn", "")
            facts.append(f"{rs(t['reversal'].get('amount', amount))} was already reversed (ref {rrn})")
            act("share_status", reason="already reversed", agree=agree, key="already_reversed", vars={"rrn": rrn})
        elif upi.get("npci_status") == "PENDING":
            facts.append("The UPI switch has not given a final status yet")
            act("share_status", reason="awaiting final status", agree=0.5, key="pending")
        else:
            tat = policy.tat_days["failed_upi"]
            age = (now - t["created_at"]) / DAY
            due = t["created_at"] + tat * DAY
            facts.append(f"Auto-reversal is due by {_date(due)} (T+{tat})")
            if age <= tat:
                act("share_status", reason="within TAT; auto-reversal will land", agree=agree, key="within_tat",
                    vars={"due": _date(due)})
            else:
                late = math.ceil(age - tat)
                comp = late * policy.compensation_per_day
                facts.append(f"{rs(amount)} to be reversed; {late} day(s) past TAT, so compensation of {rs(comp)}")
                act("reverse_failed_debit", amount, reason="debited, failed at the switch, not reversed", agree=agree)
                act("tat_compensation", comp, reason=f"{late} day(s) beyond T+{tat}", agree=agree)
    elif intent == "duplicate_charge":
        if t.get("duplicate_of"):
            orig = rails.txn(t["duplicate_of"])
            facts.append(f"Two charges of {rs(amount)} to {t['merchant']}: {orig['id']} and {tid}")
            facts.append(f"{rs(amount)} to be refunded for the duplicate {tid}")
            act("refund_duplicate", amount, reason="second identical charge within minutes", agree=agree)
        else:
            act("request_info", reason="only one charge found", agree=0.5, key="one_charge")
    elif intent == "refund_status":
        r = refund.get("refund", t["refund"])
        if r["status"] == "PROCESSED":
            facts.append(f"The merchant refund was processed on {_date(r['at'])} with ARN {r.get('arn', '')}")
            facts.append("Card and UPI refunds take up to 5 working days to show after processing")
            act("share_status", reason="refund processed", agree=agree, key="refund_processed",
                vars={"arn": r.get("arn", "")})
        elif r["status"] == "PENDING":
            age = (now - r.get("initiated_at", t["created_at"])) / DAY
            facts.append(f"The merchant started the refund {age:.0f} days ago and it has not been processed")
            if age > policy.tat_days["refund"]:
                act("raise_dispute", reason="refund past the T+5 window", agree=agree, dispute_kind="refund_delay")
            else:
                act("share_status", reason="refund within window", agree=agree, key="refund_pending")
        else:
            act("request_info", reason="no refund initiated", agree=0.5, key="no_refund")
    elif intent == "unauthorized":
        facts.append(f"The customer does not recognise {tid} of {rs(amount)}")
        act("block_instrument", reason="stop further misuse first", instrument=evidence.get("instrument", "card"))
        act("raise_dispute", reason="unauthorised transaction", dispute_kind="unauthorized", agree=agree)
        act("chargeback_credit", amount, reason="provisional credit while the dispute runs", agree=0.5)
        facts.append(f"Provisional credit of {rs(amount)} pending review")
    elif intent == "wrong_beneficiary":
        facts.append(f"{rs(amount)} went to {t['merchant']}, which the customer says is the wrong recipient")
        facts.append("A recovery request goes to the beneficiary's bank; it needs the beneficiary's consent")
        act("raise_dispute", reason="request return from the beneficiary bank", dispute_kind="wrong_beneficiary",
            agree=agree if t.get("wrong_beneficiary") else 0.5)
    else:
        act("request_info", reason="unclear request", agree=0.5, key="unclear")
    return {"specialist": specialist, "txn_id": tid, "actions": acts, "facts": facts}
