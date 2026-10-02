"""Tool Gateway: the only door to the live systems.

Read tools run freely. Anything that changes the world runs only through `execute_sealed`, which
refuses unless all of these hold: the Seal matches the live ledger, the account belongs to this
customer, the amount is within the action's policy cap, and the idempotency key has not been used
(so a retry can never pay twice). Three consecutive failures of a tool open its circuit breaker.
"""
from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from . import seal as seal_mod
from .events import EventBus
from .policy import Policy
from .rails import Rails
from .store import Store

BREAKER_THRESHOLD, BREAKER_COOLDOWN_S = 3, 30.0


@dataclass
class Tool:
    name: str
    system: str               # the connector it belongs to (shown in the connectors bar)
    description: str
    kind: str                 # "read" | "write"
    schema: dict
    handler: Callable[..., Any]
    moves_money: bool = False
    fails: int = 0
    open_until: float = 0.0
    calls: int = 0
    last_ms: float = 0.0


class GatewayError(Exception):
    pass


def _obj(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required, "additionalProperties": False}


TXN = {"txn_id": {"type": "string", "description": "Transaction id, e.g. T-5001"}}


@dataclass
class Gateway:
    rails: Rails
    store: Store
    bus: EventBus
    policy: Policy
    tools: dict[str, Tool] = field(default_factory=dict)
    pg: Any = None            # the payment gateway in test mode (pg.py), for payments that came from it

    def __post_init__(self):
        r = self.rails

        def need(tid):
            t = r.txn(tid)
            if not t:
                raise GatewayError(f"no transaction {tid}")
            return t

        def upi_status(txn_id):
            t = need(txn_id)
            return {"txn_id": txn_id, "utr": t["utr"], "npci_status": t["npci_status"],
                    "beneficiary_credited": t["beneficiary_credited"], "reversal": t["reversal"]["status"]}

        def debit_status(txn_id):
            t = need(txn_id)
            return {"txn_id": txn_id, "debit_status": t["debit_status"], "amount": t["amount"],
                    "created_at": t["created_at"], "reversal": t["reversal"]}

        def refund_status(txn_id):
            t = need(txn_id)
            return {"txn_id": txn_id, "refund": t["refund"], "merchant": t["merchant"]}

        def profile(customer_id):
            c = r.customer(customer_id)
            if not c:
                raise GatewayError(f"no customer {customer_id}")
            return {"customer_id": customer_id, "prior_disputes": c["prior_disputes"], "segment": c["segment"],
                    "txn_count": len(r.txns_for(customer_id))}

        def pg_payment(txn_id):
            t = need(txn_id)
            if t.get("source") != "razorpay_test" or not self.pg:
                raise GatewayError(f"{txn_id} is not a gateway payment")
            self.pg.refresh(txn_id)            # the live payment, not our copy of it
            t = need(txn_id)
            return {"txn_id": txn_id, **{k: (t.get("pg") or {}).get(k) for k in
                    ("id", "status", "method", "rrn", "amount_refunded", "refund_status", "error_code", "error_description")},
                    "amount": t["amount"]}

        reads = [
            Tool("upi.status", "UPI switch", "Final status of a UPI payment at the switch", "read", _obj(TXN, ["txn_id"]),
                 upi_status),
            Tool("bank.debit_status", "Core banking", "Whether the account was debited, and any reversal", "read",
                 _obj(TXN, ["txn_id"]), debit_status),
            Tool("refund.status", "Refund engine", "Merchant refund status and ARN", "read", _obj(TXN, ["txn_id"]),
                 refund_status),
            Tool("crm.profile", "CRM", "Customer history relevant to risk", "read",
                 _obj({"customer_id": {"type": "string"}}, ["customer_id"]), profile),
            Tool("pg.payment", "Razorpay (test)", "The live payment on Razorpay, in test mode", "read",
                 _obj(TXN, ["txn_id"]), pg_payment),
        ]
        writes = [
            Tool("bank.reverse", "Core banking", "Reverse a failed debit back to the account", "write",
                 _obj({**TXN, "amount": {"type": "number"}}, ["txn_id", "amount"]), None, moves_money=True),
            Tool("bank.refund", "Core banking", "Refund a duplicate charge", "write",
                 _obj({**TXN, "amount": {"type": "number"}}, ["txn_id", "amount"]), None, moves_money=True),
            Tool("wallet.credit", "Wallet ledger", "Credit compensation or a provisional chargeback", "write",
                 _obj({**TXN, "amount": {"type": "number"}}, ["txn_id", "amount"]), None, moves_money=True),
            Tool("dispute.raise", "Dispute desk", "Raise a dispute with the other bank or merchant", "write",
                 _obj(TXN, ["txn_id"]), None),
            Tool("instrument.block", "Card & UPI control", "Block a card or UPI ID", "write",
                 _obj({"customer_id": {"type": "string"}}, ["customer_id"]), None),
            Tool("pg.refund", "Razorpay (test)", "Refund a Razorpay payment (test mode; cannot be undone)", "write",
                 _obj({**TXN, "amount": {"type": "number"}}, ["txn_id", "amount"]), None, moves_money=True),
            Tool("notify.send", "Messaging", "Send the reply on the customer's channel", "write",
                 _obj({"customer_id": {"type": "string"}, "text": {"type": "string"}}, ["customer_id", "text"]),
                 None),
        ]
        self.tools = {t.name: t for t in reads + writes}

    # ── plumbing ─────────────────────────────────────────────────────────────
    def _guarded(self, name: str, fn: Callable[[], Any], *, agent: str, case_id: str | None) -> Any:
        tool = self.tools[name]
        now = time.time()
        if tool.open_until > now:
            self.bus.publish("tool.called", tool=name, system=tool.system, agent=agent, case_id=case_id, ok=False,
                             error="circuit open")
            raise GatewayError(f"{name} is paused after {BREAKER_THRESHOLD} consecutive failures")
        t0 = time.perf_counter()
        try:
            if self.rails.is_down(tool.system):
                raise GatewayError(f"{tool.system} is not responding")
            out = fn()
        except Exception as e:
            tool.fails += 1
            if tool.fails >= BREAKER_THRESHOLD:
                tool.open_until = now + BREAKER_COOLDOWN_S
            self.bus.publish("tool.called", tool=name, system=tool.system, agent=agent, case_id=case_id, ok=False,
                             error=str(e))
            raise GatewayError(str(e)) from e
        tool.fails, tool.calls = 0, tool.calls + 1
        tool.last_ms = round((time.perf_counter() - t0) * 1000, 2)
        self.bus.publish("tool.called", tool=name, system=tool.system, agent=agent, case_id=case_id, ok=True,
                         ms=tool.last_ms)
        return out

    def read(self, name: str, *, agent: str, case_id: str | None = None, **args) -> dict:
        tool = self.tools.get(name)
        if not tool or tool.kind != "read":
            raise GatewayError(f"{name} is not a read tool")
        return self._guarded(name, lambda: tool.handler(**args), agent=agent, case_id=case_id)

    def describe(self) -> list[dict]:
        now = time.time()
        return [{"name": t.name, "system": t.system, "description": t.description, "kind": t.kind,
                 "moves_money": t.moves_money, "calls": t.calls, "last_ms": t.last_ms,
                 "breaker": "open" if t.open_until > now else ("warning" if t.fails else "closed"),
                 "fails": t.fails} for t in self.tools.values()]

    def reset_breakers(self) -> None:
        for t in self.tools.values():
            t.fails, t.open_until = 0, 0.0

    # ── the sealed commit path ───────────────────────────────────────────────
    def seal_for(self, payload: list[dict], recheck: dict, txn_id: str) -> str:
        return seal_mod.compute({"actions": payload}, recheck, self.rails.version_of(txn_id), self.policy.policy_hash())

    def execute_sealed(self, *, case_id: str, customer_id: str, txn_id: str, actions: list[dict], seal: str,
                       recheck: dict, agent: str = "commit") -> dict:
        t0 = self.rails.txn(txn_id)
        if t0 and t0.get("source") == "razorpay_test" and self.pg:
            try:   # the payment as Razorpay has it now: if it moved since the seal, the seal no longer matches
                self.pg.refresh(txn_id)
            except Exception as e:
                self.bus.publish("tool.called", tool="pg.payment", system="Razorpay (test)", agent=agent,
                                 case_id=case_id, ok=False, error=str(e))
                return {"ok": False, "reason": f"Razorpay could not be checked: {e}", "receipts": []}
        check = seal_mod.verify(seal, {"actions": actions}, recheck, self.rails.version_of(txn_id),
                                self.policy.policy_hash())
        if not check["ok"]:
            self.bus.publish("seal.broken", case_id=case_id, expected=check["expected"][:12],
                             actual=check["actual"][:12])
            return {"ok": False, "reason": "seal_mismatch", "seal": check, "receipts": []}
        t = self.rails.txn(txn_id)
        if not t or t["customer_id"] != customer_id:
            return {"ok": False, "reason": "ownership", "receipts": []}
        receipts = []
        for i, a in enumerate(actions):
            receipts.append(self._run_action(case_id, customer_id, txn_id, a, f"{case_id}:{a['type']}:{i}", agent))
        return {"ok": all(r["ok"] for r in receipts), "reason": None, "seal": check, "receipts": receipts}

    def _run_action(self, case_id: str, cid: str, tid: str, a: dict, idem: str, agent: str) -> dict:
        prior = self.store.idem_get(idem)
        if prior:
            return {**prior, "replayed": True}
        at = self.policy.actions[a["type"]]
        amount = float(a.get("amount") or 0)
        if at.moves_money and amount > at.policy_cap:
            return {"ok": False, "action": a["type"], "error": f"₹{amount:,.0f} is above the policy cap"}
        r = self.rails
        external = bool(tid) and (r.txn(tid) or {}).get("source") == "razorpay_test"

        def run():
            kind = a["type"]
            if external and kind in ("refund_duplicate", "reverse_failed_debit"):
                if not self.pg:
                    raise GatewayError("the payment gateway is not set up")
                return self.pg.refund_for(tid, amount, idem, case_id), None   # a gateway refund has no undo
            if kind == "reverse_failed_debit":
                res = r.reverse(tid, amount)
                return res, {"tool": "bank.reverse.undo", "txn_id": tid}
            if kind == "refund_duplicate":
                res = r.refund(tid, amount)
                return res, {"tool": "bank.refund.undo", "txn_id": tid}
            if kind in ("tat_compensation", "chargeback_credit"):
                res = r.wallet_credit(cid, amount, kind, tid)
                return res, {"tool": "wallet.credit.undo", "credit_id": res["id"]}
            if kind == "raise_dispute":
                res = r.raise_dispute(tid, a.get("dispute_kind", "general"))
                return res, {"tool": "dispute.withdraw", "txn_id": tid}
            if kind == "block_instrument":
                res = r.block_instrument(cid, a.get("instrument", "upi"))
                return res, {"tool": "instrument.unblock", "block_id": res["id"]}
            raise GatewayError(f"{kind} has no tool")

        tool = {"reverse_failed_debit": "bank.reverse", "refund_duplicate": "bank.refund",
                "tat_compensation": "wallet.credit", "chargeback_credit": "wallet.credit",
                "raise_dispute": "dispute.raise", "block_instrument": "instrument.block"}[a["type"]]
        if external and a["type"] in ("refund_duplicate", "reverse_failed_debit"):
            tool = "pg.refund"
        try:
            res, undo = self._guarded(tool, run, agent=agent, case_id=case_id)
        except GatewayError as e:
            return {"ok": False, "action": a["type"], "error": str(e)}
        receipt = {"ok": True, "action": a["type"], "tool": tool, "amount": amount, "result": res,
                   "undo": undo if at.reversible and undo else None, "idempotency_key": idem}
        self.store.idem_put(idem, tool, receipt)
        return receipt

    def undo(self, undo: dict, *, case_id: str) -> None:
        r = self.rails
        kind = undo["tool"]
        if kind == "bank.reverse.undo":
            r.undo_reverse(undo["txn_id"])
        elif kind == "bank.refund.undo":
            r.undo_refund(undo["txn_id"])
        elif kind == "wallet.credit.undo":
            r.undo_wallet_credit(undo["credit_id"])
        elif kind == "dispute.withdraw":
            r.withdraw_dispute(undo["txn_id"])
        elif kind == "instrument.unblock":
            r.unblock(undo["block_id"])
        self.bus.publish("tool.called", tool=kind, system="undo", agent="commit", case_id=case_id, ok=True)

    def send(self, case_id: str, customer_id: str, text: str, agent: str = "responder") -> dict:
        idem = f"{case_id}:notify:{hashlib.sha1(text.encode()).hexdigest()[:10]}"
        prior = self.store.idem_get(idem)
        if prior:
            return {**prior, "replayed": True}
        out = self._guarded("notify.send", lambda: {"delivered": True, "chars": len(text)}, agent=agent,
                            case_id=case_id)
        self.store.idem_put(idem, "notify.send", out)
        # the channels deliver it by email, WhatsApp or on the call the case came from (once: replays stop above)
        self.bus.publish("reply.sent", case_id=case_id, customer_id=customer_id, text=text)
        return out
