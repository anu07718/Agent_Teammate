"""The live systems Nirnaya works against, simulated: core banking, the UPI switch, refunds and the wallet.

Every account and transaction carries a version. Any change bumps it, which is what lets a Seal tell
that "the ground moved" between the moment a human was shown an action and the moment it runs.
The state persists in the store so a restart sees the same world.
"""
from __future__ import annotations

import copy
import time
from typing import Any

from .store import Store

DAY = 86_400.0


def _seed(now: float) -> dict:
    customers = {
        "C-1001": {"id": "C-1001", "name": "Aarav Sharma", "phone": "9876543210", "vpa": "aarav.sharma@okbank",
                   "account": "000123456789", "card": "4111 1111 1111 1111", "prior_disputes": 0, "segment": "retail"},
        "C-1002": {"id": "C-1002", "name": "Meera Iyer", "phone": "9123456780", "vpa": "meera.iyer@paybank",
                   "account": "000223456781", "card": "5500 0000 0000 0004", "prior_disputes": 1, "segment": "retail"},
        "C-1003": {"id": "C-1003", "name": "Rohan Verma", "phone": "9988776655", "vpa": "rohanv@okbank",
                   "account": "000323456782", "card": "4012 8888 8888 1881", "prior_disputes": 3, "segment": "retail"},
        "C-1004": {"id": "C-1004", "name": "Priya Nair", "phone": "9090909090", "vpa": "priya.n@ybl",
                   "account": "000423456783", "card": "4222 2222 2222 2", "prior_disputes": 0, "segment": "premium"},
    }
    accounts = {c["account"]: {"id": c["account"], "customer_id": cid, "balance": b, "version": 1}
                for (cid, c), b in zip(customers.items(), [18_400.0, 42_250.0, 7_900.0, 1_25_000.0])}

    def txn(tid, cid, amount, merchant, days, npci, credited, utr, **kw):
        acct = customers[cid]["account"]
        base = {"id": tid, "utr": utr, "customer_id": cid, "account_id": acct, "amount": amount, "merchant": merchant,
                "created_at": now - days * DAY, "debit_status": "DEBITED", "npci_status": npci,
                "beneficiary_credited": credited, "reversal": {"status": "NONE"}, "refund": {"status": "NONE"},
                "dispute": None, "duplicate_of": None, "version": 1}
        base.update(kw)
        return base

    txns = [
        txn("T-5001", "C-1001", 2_450.0, "FreshMart", 3, "FAILED", False, "412345678901"),
        txn("T-5002", "C-1001", 799.0, "CityCabs", 0.2, "FAILED", False, "412345678902"),
        txn("T-5003", "C-1002", 1_299.0, "StyleKart", 6, "SUCCESS", True, "412345678903",
            refund={"status": "PROCESSED", "arn": "74332716045000123456789", "at": now - 1 * DAY}),
        txn("T-5004", "C-1002", 349.0, "CafeBrew", 1, "SUCCESS", True, "412345678904"),
        txn("T-5005", "C-1002", 349.0, "CafeBrew", 1, "SUCCESS", True, "412345678905", duplicate_of="T-5004"),
        txn("T-5006", "C-1003", 18_500.0, "QuickPay Store", 0.5, "SUCCESS", True, "412345678906", unrecognised=True),
        txn("T-5007", "C-1003", 5_000.0, "vikram.k@paybank", 2, "SUCCESS", True, "412345678907", wrong_beneficiary=True),
        txn("T-5008", "C-1004", 1_200.0, "BookNest", 1, "SUCCESS", True, "412345678908"),
        txn("T-5009", "C-1004", 3_999.0, "GadgetHub", 8, "SUCCESS", True, "412345678909",
            refund={"status": "PENDING", "initiated_at": now - 7 * DAY}),
    ]
    return {"customers": customers, "accounts": accounts, "txns": {t["id"]: t for t in txns},
            "wallet_credits": [], "blocks": [], "disputes": [], "down": [], "seeded_at": now}


class Rails:
    def __init__(self, store: Store):
        self.store = store
        self.state: dict[str, Any] = store.kv_get("rails") or _seed(time.time())
        self._save()

    def _save(self) -> None:
        self.store.kv_set("rails", self.state)

    def reset(self) -> None:
        self.state = _seed(time.time())
        self._save()

    # ── reads ────────────────────────────────────────────────────────────────
    def customer(self, cid: str) -> dict | None:
        return self.state["customers"].get(cid)

    def customers(self) -> list[dict]:
        return list(self.state["customers"].values())

    def account(self, acct_id: str) -> dict | None:
        return self.state["accounts"].get(acct_id)

    def txn(self, tid: str) -> dict | None:
        return self.state["txns"].get(tid)

    def txns_for(self, cid: str) -> list[dict]:
        return sorted((t for t in self.state["txns"].values() if t["customer_id"] == cid),
                      key=lambda t: -t["created_at"])

    def is_down(self, system: str) -> bool:
        return system in self.state.get("down", [])

    def version_of(self, tid: str) -> str:
        t = self.txn(tid)
        if not t:
            return "none"
        a = self.account(t["account_id"])
        return f"{t['id']}@{t['version']}|{a['id'][-4:]}@{a['version']}"

    def snapshot(self, tid: str) -> dict:
        t = self.txn(tid)
        return {"txn": copy.deepcopy(t), "account": copy.deepcopy(self.account(t["account_id"])) if t else None,
                "version": self.version_of(tid)}

    # ── writes (the Tool Gateway is the only caller) ─────────────────────────
    def _touch(self, t: dict) -> None:
        t["version"] += 1
        self.state["accounts"][t["account_id"]]["version"] += 1

    def credit_account(self, acct_id: str, amount: float) -> None:
        a = self.state["accounts"][acct_id]
        a["balance"] = round(a["balance"] + amount, 2)
        a["version"] += 1

    def reverse(self, tid: str, amount: float, by: str = "nirnaya") -> dict:
        t = self.state["txns"][tid]
        t["reversal"] = {"status": "REVERSED", "rrn": f"R{t['utr'][-9:]}", "amount": amount, "by": by, "at": time.time()}
        self.state["accounts"][t["account_id"]]["balance"] += amount
        self._touch(t)
        self._save()
        return t["reversal"]

    def undo_reverse(self, tid: str) -> None:
        t = self.state["txns"][tid]
        amt = t["reversal"].get("amount", 0)
        t["reversal"] = {"status": "NONE"}
        self.state["accounts"][t["account_id"]]["balance"] -= amt
        self._touch(t)
        self._save()

    def refund(self, tid: str, amount: float) -> dict:
        t = self.state["txns"][tid]
        t["refund"] = {"status": "PROCESSED", "arn": f"7433{t['utr']}{int(time.time()) % 10000:04d}", "amount": amount,
                       "at": time.time()}
        self.state["accounts"][t["account_id"]]["balance"] += amount
        self._touch(t)
        self._save()
        return t["refund"]

    def undo_refund(self, tid: str) -> None:
        t = self.state["txns"][tid]
        amt = t["refund"].get("amount", 0)
        t["refund"] = {"status": "NONE"}
        self.state["accounts"][t["account_id"]]["balance"] -= amt
        self._touch(t)
        self._save()

    def wallet_credit(self, cid: str, amount: float, reason: str, tid: str | None = None) -> dict:
        acct = self.state["customers"][cid]["account"]
        credit = {"id": f"W-{len(self.state['wallet_credits']) + 1:04d}", "customer_id": cid, "amount": amount,
                  "reason": reason, "txn_id": tid, "at": time.time(), "status": "POSTED"}
        self.state["wallet_credits"].append(credit)
        self.credit_account(acct, amount)
        if tid:
            self._touch(self.state["txns"][tid])
        self._save()
        return credit

    def undo_wallet_credit(self, credit_id: str) -> None:
        for c in self.state["wallet_credits"]:
            if c["id"] == credit_id and c["status"] == "POSTED":
                c["status"] = "REVERSED"
                self.credit_account(self.state["customers"][c["customer_id"]]["account"], -c["amount"])
        self._save()

    def raise_dispute(self, tid: str, kind: str) -> dict:
        t = self.state["txns"][tid]
        d = {"id": f"D-{len(self.state['disputes']) + 1:04d}", "txn_id": tid, "kind": kind, "status": "RAISED",
             "at": time.time()}
        t["dispute"] = d
        self.state["disputes"].append(d)
        self._touch(t)
        self._save()
        return d

    def withdraw_dispute(self, tid: str) -> None:
        t = self.state["txns"][tid]
        if t.get("dispute"):
            t["dispute"]["status"] = "WITHDRAWN"
            self._touch(t)
        self._save()

    def block_instrument(self, cid: str, instrument: str) -> dict:
        b = {"id": f"B-{len(self.state['blocks']) + 1:04d}", "customer_id": cid, "instrument": instrument,
             "status": "BLOCKED", "at": time.time()}
        self.state["blocks"].append(b)
        acct = self.state["customers"][cid]["account"]
        self.state["accounts"][acct]["version"] += 1
        self._save()
        return b

    def unblock(self, block_id: str) -> None:
        for b in self.state["blocks"]:
            if b["id"] == block_id:
                b["status"] = "UNBLOCKED"
        self._save()

    # ── simulated outside events (the ground moving under a parked case) ─────
    def outside_event(self, tid: str, event: str) -> dict:
        t = self.state["txns"][tid]
        if event == "reversal_lands":
            self.reverse(tid, t["amount"], by="bank-auto-reversal")
        elif event == "merchant_refund":
            self.refund(tid, t["amount"])
        elif event == "npci_success":
            t["npci_status"], t["beneficiary_credited"] = "SUCCESS", True
            self._touch(t)
            self._save()
        else:
            raise ValueError(f"unknown event {event}")
        return self.snapshot(tid)

    def set_down(self, system: str, down: bool) -> None:
        s = set(self.state.get("down", []))
        s.add(system) if down else s.discard(system)
        self.state["down"] = sorted(s)
        self._save()
