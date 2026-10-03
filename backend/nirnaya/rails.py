"""The live systems Nirnaya works against, simulated: core banking, the UPI switch, refunds and the wallet.

Every account and transaction carries a version. Any change bumps it, which is what lets a Seal tell
that "the ground moved" between the moment a human was shown an action and the moment it runs.
The state persists in the store so a restart sees the same world.
"""
from __future__ import annotations

import copy
import re
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
    txns += synthetic(now, txn)
    for c in customers.values():
        c["source"] = "demo"
    for t in txns:
        t["source"] = "demo"
    return {"customers": customers, "accounts": accounts, "txns": {t["id"]: t for t in txns},
            "wallet_credits": [], "blocks": [], "disputes": [], "down": [], "seeded_at": now, "demo": True,
            "seed_version": SEED_VERSION}


SEED_VERSION = 2


def synthetic(now: float, txn) -> list[dict]:
    """More made-up UPI payments for the demo customers, one for every kind of answer, at the amounts people
    usually say (₹500, ₹1,000, ₹2,000…). Kept clear of the sample messages' own payments so those still match
    the same one. All demo data: labelled so, and gone with the demo switch."""
    rev = lambda days, amount, rrn: {"status": "REVERSED", "amount": amount, "rrn": rrn, "at": now - days * DAY}  # noqa: E731
    done = lambda days, arn: {"status": "PROCESSED", "arn": arn, "at": now - days * DAY}                          # noqa: E731
    pend = lambda days: {"status": "PENDING", "initiated_at": now - days * DAY}                                   # noqa: E731
    return [
        # Aarav: failed debits at every stage, a pending payment, a refund on its way, a double charge
        txn("T-5101", "C-1001", 1_000.0, "Zomato", 0.6, "FAILED", False, "412345679101"),
        txn("T-5102", "C-1001", 2_000.0, "Swiggy Instamart", 6, "FAILED", False, "412345679102"),
        txn("T-5103", "C-1001", 500.0, "Jio Recharge", 0.05, "PENDING", False, "412345679103"),
        txn("T-5104", "C-1001", 1_500.0, "IRCTC", 4, "FAILED", False, "412345679104",
            reversal=rev(3, 1_500.0, "RRN410099887766")),
        txn("T-5105", "C-1001", 3_000.0, "Amazon Pay", 5, "SUCCESS", True, "412345679105", refund=pend(2)),
        txn("T-5106", "C-1001", 750.0, "BigBasket", 2, "FAILED", False, "412345679106", debit_status="NOT_DEBITED"),
        txn("T-5107", "C-1001", 5_000.0, "landlord.rent@okaxis", 10, "SUCCESS", True, "412345679107"),
        txn("T-5108", "C-1001", 999.0, "Netflix", 2, "SUCCESS", True, "412345679108"),
        txn("T-5109", "C-1001", 999.0, "Netflix", 2, "SUCCESS", True, "412345679109", duplicate_of="T-5108"),
        # Meera
        txn("T-5201", "C-1002", 2_000.0, "Myntra", 5, "FAILED", False, "412345679201"),
        txn("T-5202", "C-1002", 1_000.0, "Uber", 0.4, "FAILED", False, "412345679202"),
        txn("T-5203", "C-1002", 4_500.0, "Croma", 6, "SUCCESS", True, "412345679203",
            refund=done(2, "74332716045000987654321")),
        txn("T-5204", "C-1002", 2_500.0, "Flipkart", 12, "SUCCESS", True, "412345679204", refund=pend(9)),
        txn("T-5205", "C-1002", 10_000.0, "anil.mehta@ybl", 1, "SUCCESS", True, "412345679205", wrong_beneficiary=True),
        txn("T-5206", "C-1002", 600.0, "Dominos", 3, "SUCCESS", True, "412345679206"),
        txn("T-5207", "C-1002", 600.0, "Dominos", 3, "SUCCESS", True, "412345679207", duplicate_of="T-5206"),
        txn("T-5208", "C-1002", 1_500.0, "Ola", 0.1, "PENDING", False, "412345679208"),
        txn("T-5209", "C-1002", 1_200.0, "Rapido", 3, "FAILED", False, "412345679209",
            reversal=rev(2, 1_200.0, "RRN410055443322")),
        # Rohan
        txn("T-5301", "C-1003", 7_999.0, "LuckyWin Games", 1, "SUCCESS", True, "412345679301", unrecognised=True),
        txn("T-5302", "C-1003", 1_000.0, "PhonePe Wallet", 2, "FAILED", False, "412345679302"),
        txn("T-5303", "C-1003", 2_000.0, "Reliance Digital", 6, "SUCCESS", True, "412345679303", refund=pend(4)),
        txn("T-5304", "C-1003", 3_500.0, "Airtel Postpaid", 1, "SUCCESS", True, "412345679304"),
        txn("T-5305", "C-1003", 3_500.0, "Airtel Postpaid", 1, "SUCCESS", True, "412345679305", duplicate_of="T-5304"),
        txn("T-5306", "C-1003", 500.0, "Paytm Recharge", 0.3, "FAILED", False, "412345679306", debit_status="NOT_DEBITED"),
        # Priya
        txn("T-5401", "C-1004", 2_000.0, "Nykaa", 4, "FAILED", False, "412345679401"),
        txn("T-5402", "C-1004", 1_000.0, "BookMyShow", 0.3, "FAILED", False, "412345679402"),
        txn("T-5403", "C-1004", 15_000.0, "MakeMyTrip", 9, "SUCCESS", True, "412345679403",
            refund=done(3, "74332716045000555444333")),
        txn("T-5404", "C-1004", 750.0, "Starbucks", 2, "SUCCESS", True, "412345679404"),
        txn("T-5405", "C-1004", 750.0, "Starbucks", 2, "SUCCESS", True, "412345679405", duplicate_of="T-5404"),
        txn("T-5406", "C-1004", 25_000.0, "CryptoX Exchange", 0.4, "SUCCESS", True, "412345679406", unrecognised=True),
        txn("T-5407", "C-1004", 3_000.0, "suresh.p@okicici", 3, "SUCCESS", True, "412345679407", wrong_beneficiary=True),
    ]


class Rails:
    def __init__(self, store: Store):
        self.store = store
        self.state: dict[str, Any] = store.kv_get("rails") or _seed(time.time())
        self._top_up()
        self._save()

    def _top_up(self) -> None:
        """A demo bank saved by an older version gets the newer demo payments too (never touching what is there)."""
        if self.state.get("seed_version", 1) >= SEED_VERSION:
            return
        fresh = _seed(time.time())
        if self.state.get("demo", True):
            for cid, c in fresh["customers"].items():
                if cid in self.state["customers"]:
                    for tid, t in fresh["txns"].items():
                        if t["customer_id"] == cid and tid not in self.state["txns"] and tid >= "T-5100":
                            self.state["txns"][tid] = t
        self.state["seed_version"] = SEED_VERSION

    def _save(self) -> None:
        self.store.kv_set("rails", self.state)

    def reset(self) -> None:
        """The demo bank back to its seeded state. What you fed in (imports, gateway payments) stays, and so
        does the demo switch: remove fed data with remove_fed."""
        fed = lambda x: x.get("source") not in (None, "demo")   # noqa: E731
        txns = {k: t for k, t in self.state["txns"].items() if fed(t)}
        people = {k: c for k, c in self.state["customers"].items() if fed(c)}
        accounts = {c["account"]: self.state["accounts"][c["account"]] for c in people.values()
                    if c.get("account") in self.state["accounts"]}
        demo = self.demo_on()
        self.state = _seed(time.time())
        self.state["customers"].update(people)
        self.state["accounts"].update(accounts)
        self.state["txns"].update(txns)
        if not demo:
            self.set_demo(False)
        self._save()

    # ── fed data: imports and gateway payments, each marked with where it came from ──
    def add_customer(self, *, name: str, phone: str = "", vpa: str = "", email: str = "", segment: str = "retail",
                     source: str = "import", cid: str | None = None) -> dict:
        nums = [int(k[2:]) for k in self.state["customers"] if re.fullmatch(r"C-\d+", k)]
        cid = cid or f"C-{max([2000] + nums) + 1}"
        if cid in self.state["customers"]:
            raise ValueError(f"customer {cid} already exists")
        digits = re.sub(r"\D", "", cid) or "0"
        acct = f"{900000000000 + int(digits):012d}"
        self.state["accounts"][acct] = {"id": acct, "customer_id": cid, "balance": 0.0, "version": 1, "external": True}
        c = {"id": cid, "name": name, "phone": phone, "vpa": vpa, "email": email, "account": acct, "card": "",
             "prior_disputes": 0, "segment": segment, "source": source}
        self.state["customers"][cid] = c
        self._save()
        return c

    def upsert_external(self, tid: str, fields: dict) -> bool:
        """Create or update a fed transaction. Bumps its version (so a Seal notices) only when something changed."""
        t = self.state["txns"].get(tid)
        if t is None:
            cid = fields["customer_id"]
            t = {"id": tid, "utr": "", "customer_id": cid, "account_id": self.state["customers"][cid]["account"],
                 "amount": 0.0, "merchant": "", "created_at": time.time(), "debit_status": "DEBITED",
                 "npci_status": "PENDING", "beneficiary_credited": False, "reversal": {"status": "NONE"},
                 "refund": {"status": "NONE"}, "dispute": None, "duplicate_of": None, "version": 0}
            self.state["txns"][tid] = t
        changed = any(t.get(k) != v for k, v in fields.items())
        if changed:
            t.update(copy.deepcopy(fields))
            t["account_id"] = self.state["customers"][t["customer_id"]]["account"]
            t["version"] += 1
            self.state["accounts"][t["account_id"]]["version"] += 1
            self._save()
        return changed

    def remove_fed(self, *, batch: str | None = None, source: str | None = None) -> int:
        """Remove imported or gateway transactions (and customers left with nothing)."""
        gone = [tid for tid, t in self.state["txns"].items()
                if t.get("source") not in (None, "demo") and (batch is None or t.get("batch") == batch)
                and (source is None or t.get("source") == source)]
        for tid in gone:
            del self.state["txns"][tid]
        used = {t["customer_id"] for t in self.state["txns"].values()}
        for cid, c in list(self.state["customers"].items()):
            if c.get("source") not in (None, "demo") and cid not in used and (batch is None or c.get("batch") == batch):
                self.state["accounts"].pop(c["account"], None)
                del self.state["customers"][cid]
        self._save()
        return len(gone)

    def demo_on(self) -> bool:
        return self.state.get("demo", True) is not False

    def set_demo(self, on: bool) -> None:
        """Hide the demo bank's payments (and its customers, unless a payment you fed in belongs to one: a
        Razorpay payment from Meera's phone keeps Meera), so only what you fed in is there; or bring them back."""
        if on and not self.demo_on():
            seed = _seed(time.time())
            for part in ("customers", "accounts", "txns"):
                for k, v in seed[part].items():
                    self.state[part].setdefault(k, v)
        elif not on:
            for tid in [k for k, t in self.state["txns"].items() if t.get("source", "demo") == "demo"]:
                del self.state["txns"][tid]
            used = {t["customer_id"] for t in self.state["txns"].values()}
            for cid in [k for k, c in self.state["customers"].items() if c.get("source", "demo") == "demo" and k not in used]:
                self.state["accounts"].pop(self.state["customers"][cid]["account"], None)
                del self.state["customers"][cid]
        self.state["demo"] = on
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

    # ── payouts to people outside the bank (outreach), from the business float ──
    FLOAT_START = 5_00_000.0

    def _float(self) -> dict:
        f = self.state.setdefault("float", {"id": "FLOAT-0001", "balance": self.FLOAT_START, "version": 1})
        self.state.setdefault("payouts", [])
        return f

    def float_balance(self) -> float:
        return float(self._float()["balance"])

    def float_version(self) -> str:
        f = self._float()
        return f"{f['id']}@{f['version']}"

    def payouts(self) -> list[dict]:
        self._float()
        return list(self.state["payouts"])

    def payout(self, *, to: dict, amount: float, reason: str | None, op_id: str) -> dict:
        """Pay someone outside the bank from the float. Simulated: it records the payout, no money leaves."""
        f = self._float()
        amount = round(float(amount), 2)
        if amount <= 0:
            raise ValueError("a payout must be more than ₹0")
        if amount > f["balance"]:
            raise ValueError(f"the float has only ₹{f['balance']:,.2f}")
        f["balance"] = round(f["balance"] - amount, 2)
        f["version"] += 1
        p = {"id": f"PO-{len(self.state['payouts']) + 1:04d}", "to": {k: to.get(k) for k in ("name", "email", "phone")},
             "amount": amount, "reason": reason, "op_id": op_id, "at": time.time(), "status": "SENT", "simulated": True}
        self.state["payouts"].append(p)
        self._save()
        return p

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
    def natural_event(self, tid: str) -> str | None:
        """What can still happen to this payment from outside: a failed debit gets the bank's auto-reversal,
        a payment that went through can be refunded by the merchant. Each happens once."""
        t = self.state["txns"][tid]
        if t.get("source", "demo") != "demo":  # a real or imported payment: only its own source changes it
            return None
        if t["npci_status"] == "FAILED" and t["debit_status"] == "DEBITED" and t["reversal"]["status"] != "REVERSED":
            return "reversal_lands"
        if t["npci_status"] == "SUCCESS" and t["refund"]["status"] != "PROCESSED":
            return "merchant_refund"
        return None

    def outside_event(self, tid: str, event: str) -> dict:
        t = self.state["txns"][tid]
        if t.get("source", "demo") != "demo":
            raise ValueError(f"{tid} is a {'Razorpay' if t.get('source') == 'razorpay_test' else 'fed'} payment: "
                             "simulated events only land on the demo bank's payments")
        if event == "reversal_lands":
            if t["reversal"]["status"] == "REVERSED":
                raise ValueError(f"{tid} is already reversed")
            if t["npci_status"] != "FAILED":
                raise ValueError(f"{tid} went through, so the bank has nothing to reverse; a merchant refund can land instead")
            self.reverse(tid, t["amount"], by="bank-auto-reversal")
        elif event == "merchant_refund":
            if t["refund"]["status"] == "PROCESSED":
                raise ValueError(f"{tid} is already refunded")
            if t["npci_status"] != "SUCCESS":
                raise ValueError(f"{tid} failed, so the merchant never got the money; the bank's reversal can land instead")
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
