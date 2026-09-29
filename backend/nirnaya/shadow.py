"""Shadow Ledger and Recheck: every action is dry-run on a copy of the live state, never on the live one.

`shadow_execute` applies the plan to a snapshot and returns the before/after diff a human would see.
`recheck` compares the snapshot the plan was made against with the live systems now, up to three
times; if they disagree the plan is stale and goes back to planning.
"""
from __future__ import annotations

import copy

from .rails import Rails


def _apply(snap: dict, action: dict) -> dict:
    after = copy.deepcopy(snap)
    t, a = after["txn"], after["account"]
    kind, amt = action["type"], float(action.get("amount") or 0)
    if kind == "reverse_failed_debit":
        t["reversal"] = {"status": "REVERSED", "amount": amt}
        a["balance"] = round(a["balance"] + amt, 2)
    elif kind == "refund_duplicate":
        t["refund"] = {"status": "PROCESSED", "amount": amt}
        a["balance"] = round(a["balance"] + amt, 2)
    elif kind in ("tat_compensation", "chargeback_credit"):
        a["balance"] = round(a["balance"] + amt, 2)
    elif kind == "raise_dispute":
        t["dispute"] = {"status": "RAISED", "kind": action.get("dispute_kind", "general")}
    elif kind == "block_instrument":
        after["blocked"] = action.get("instrument", "upi")
    return after


def _diff(before: dict, after: dict) -> list[dict]:
    out = []
    bt, at = before["txn"], after["txn"]
    for key in ("reversal", "refund", "dispute"):
        if bt.get(key) != at.get(key):
            out.append({"field": f"txn.{key}", "before": bt.get(key), "after": at.get(key)})
    if before["account"]["balance"] != after["account"]["balance"]:
        out.append({"field": "account.balance", "before": before["account"]["balance"],
                    "after": after["account"]["balance"]})
    if after.get("blocked"):
        out.append({"field": "instrument", "before": "active", "after": f"{after['blocked']} blocked"})
    return out


def shadow_execute(rails: Rails, txn_id: str, actions: list[dict]) -> dict:
    snap = rails.snapshot(txn_id)
    after = snap
    for act in actions:
        if act["type"] in ("share_status", "request_info"):
            continue
        after = _apply(after, act)
    return {"baseline": snap["version"], "before": snap, "after": after, "diff": _diff(snap, after),
            "live_touched": False}


def recheck(rails: Rails, txn_id: str, shadow: dict, retries: int = 3) -> dict:
    tries = []
    for i in range(retries):
        live = rails.version_of(txn_id)
        ok = live == shadow["baseline"]
        tries.append({"try": i + 1, "live": live, "ok": ok})
        if ok:
            break
    ok = tries[-1]["ok"]
    return {"ok": ok, "baseline": shadow["baseline"], "result": tries[-1]["live"], "tries": tries,
            "reason": None if ok else "the live systems changed after the plan was made"}
