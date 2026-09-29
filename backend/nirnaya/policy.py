"""Action types, risk budgets and the policy hash every seal and checkpoint is stamped with."""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field


@dataclass
class ActionType:
    id: str
    label: str
    moves_money: bool
    reversible: bool        # an undo token can be issued, so HEDGE is allowed
    alpha: float            # target ceiling on wrong autonomous actions (share of acted cases)
    hedge_cap: float        # HEDGE only up to this amount (₹); 0 = never hedge
    policy_cap: float       # the Tool Gateway refuses anything above this amount
    rung: int = 2           # earned autonomy: 0 suggest only · 1 up to HEDGE · 2 may ACT
    tool: str = ""          # the gateway tool that carries it out


# Amount bands for rupee-weighted thresholds: a bigger band gets a stricter ceiling.
BANDS = [("small", 0, 2_000, 1.0), ("medium", 2_000, 20_000, 0.5), ("large", 20_000, float("inf"), 0.25)]
CONFIDENCE = 0.95           # the ceiling holds with this probability (Learn-then-Test, δ = 0.05)


def band_of(amount: float) -> tuple[str, float]:
    for name, lo, hi, factor in BANDS:
        if lo <= amount < hi:
            return name, factor
    return BANDS[-1][0], BANDS[-1][3]


def default_actions() -> dict[str, ActionType]:
    acts = [
        ActionType("share_status", "Share verified status", False, True, 0.05, 0, 0, tool="notify.send"),
        ActionType("request_info", "Ask for missing details", False, True, 0.10, 0, 0, tool="notify.send"),
        ActionType("reverse_failed_debit", "Reverse a failed debit", True, False, 0.005, 0, 100_000,
                   tool="bank.reverse"),
        ActionType("refund_duplicate", "Refund a duplicate charge", True, True, 0.005, 1_000, 50_000,
                   tool="bank.refund"),
        ActionType("tat_compensation", "Pay TAT compensation", True, True, 0.01, 500, 5_000,
                   tool="wallet.credit"),
        ActionType("raise_dispute", "Raise a dispute with the other bank", False, True, 0.02, 0, 0,
                   tool="dispute.raise"),
        ActionType("block_instrument", "Block the card or UPI ID", False, True, 0.01, 0, 0,
                   tool="instrument.block"),
        ActionType("chargeback_credit", "Provisional chargeback credit", True, False, 0.002, 0, 200_000,
                   tool="wallet.credit"),
    ]
    return {a.id: a for a in acts}


@dataclass
class Policy:
    actions: dict[str, ActionType] = field(default_factory=default_actions)
    tat_days: dict[str, int] = field(default_factory=lambda: {"failed_upi": 1, "refund": 5, "dispute": 30})
    compensation_per_day: int = 100      # ₹ per day beyond the reversal TAT
    shadow_retries: int = 3

    def to_dict(self) -> dict:
        return {"actions": {k: asdict(v) for k, v in self.actions.items()}, "tat_days": self.tat_days,
                "compensation_per_day": self.compensation_per_day, "shadow_retries": self.shadow_retries,
                "bands": [{"name": n, "from": lo, "to": (None if hi == float("inf") else hi), "factor": f}
                          for n, lo, hi, f in BANDS], "confidence": CONFIDENCE}

    def policy_hash(self) -> str:
        blob = json.dumps(self.to_dict(), sort_keys=True, default=str).encode()
        return hashlib.sha256(blob).hexdigest()[:16]


# The workflow topology: a resume against a different graph is refused.
SUPERSTEPS = ["intake", "understand", "evidence", "plan", "calibrate", "shadow", "route", "commit", "respond", "learn"]
GRAPH_HASH = hashlib.sha256("|".join(SUPERSTEPS).encode()).hexdigest()[:16]
