"""Case memory: every resolved case, searchable, with what held.

Each memory records the outcome and its state: `accepted` (a human approved it, or it stood), `rejected`
(a human rejected or undid it) or `auto` (acted autonomously, not yet audited). A hit also says when the
ground moved: the transaction it was about has changed since. No embeddings; BM25 over tokenised text.
"""
from __future__ import annotations

import json
import math
import re
import time
from collections import Counter

from .rails import Rails
from .store import Store

STOP = {"the", "a", "an", "my", "i", "is", "was", "to", "of", "and", "for", "in", "on", "it", "but", "not", "me",
        "have", "has", "hai", "ka", "ki", "ke", "se", "par", "please", "pls", "sir", "mam"}
HISTORY = [
    ("failed upi payment money debited not credited merchant", "failed_debit", "reverse_failed_debit", "accepted"),
    ("upi payment failed amount deducted auto reversal not received", "failed_debit", "reverse_failed_debit", "accepted"),
    ("payment failed money cut from account yesterday", "failed_debit", "share_status", "accepted"),
    ("paisa kat gaya payment fail hua wapas nahi aaya", "failed_debit", "reverse_failed_debit", "accepted"),
    ("refund not received from merchant after return", "refund_status", "share_status", "accepted"),
    ("refund status order cancelled money not back", "refund_status", "raise_dispute", "accepted"),
    ("charged twice same merchant double debit", "duplicate_charge", "refund_duplicate", "accepted"),
    ("duplicate charge coffee shop two times", "duplicate_charge", "refund_duplicate", "rejected"),
    ("transaction not done by me unauthorized card", "unauthorized", "chargeback_credit", "accepted"),
    ("sent money to wrong upi id by mistake", "wrong_beneficiary", "raise_dispute", "accepted"),
    ("block my card lost wallet", "block_request", "block_instrument", "accepted"),
    ("kyc update limit reached account", "kyc", "share_status", "accepted"),
]


def tokens(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in STOP and len(w) > 1]


class Memory:
    def __init__(self, store: Store, rails: Rails):
        self.store, self.rails = store, rails
        if not self.store.query("SELECT 1 FROM memory LIMIT 1"):
            for i, (text, intent, action, state) in enumerate(HISTORY):
                self.add(f"H-{i + 1:03d}", text, intent, action, "resolved", state, {}, {})

    def add(self, case_id: str, text: str, intent: str, action: str, outcome: str, state: str, entities: dict,
            versions: dict) -> None:
        self.store.execute(
            "INSERT INTO memory VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(case_id) DO UPDATE SET outcome=excluded.outcome, "
            "state=excluded.state, action=excluded.action, versions=excluded.versions",
            (case_id, text, intent, action, outcome, state, json.dumps(entities), json.dumps(versions), time.time()))

    def set_state(self, case_id: str, state: str) -> None:
        self.store.execute("UPDATE memory SET state=? WHERE case_id=?", (state, case_id))

    def search(self, query: str, intent: str | None = None, k: int = 5, exclude: str | None = None) -> list[dict]:
        rows = [dict(r) for r in self.store.query("SELECT * FROM memory")]
        rows = [r for r in rows if r["case_id"] != exclude]
        docs = [tokens(r["text"]) for r in rows]
        if not docs:
            return []
        N = len(docs)
        avgdl = sum(len(d) for d in docs) / N
        df = Counter(w for d in docs for w in set(d))
        q = tokens(query)
        out = []
        for r, d in zip(rows, docs):
            tf = Counter(d)
            s = sum(math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5)) * tf[w] * 2.2 /
                    (tf[w] + 1.2 * (0.25 + 0.75 * len(d) / avgdl)) for w in q if w in tf)
            if intent and r["intent"] == intent:
                s += 1.5
            if s > 0:
                versions = json.loads(r["versions"] or "{}")
                moved = [tid for tid, v in versions.items() if self.rails.version_of(tid) != v]
                out.append({"case_id": r["case_id"], "score": round(s, 3), "text": r["text"], "intent": r["intent"],
                            "action": r["action"], "state": r["state"], "outcome": r["outcome"],
                            "ground_moved": bool(moved), "moved": moved})
        return sorted(out, key=lambda h: -h["score"])[:k]

    def support(self, hits: list[dict], action: str) -> float:
        """How strongly past outcomes back this action: score-weighted share of same-action cases that held."""
        rel = [h for h in hits if h["action"] == action]
        if not rel:
            return 0.0
        tot = sum(h["score"] for h in rel)
        good = sum(h["score"] for h in rel if h["state"] in ("accepted", "auto"))
        return round(min(1.0, (good / tot) * min(1.0, len(rel) / 3)), 3) if tot else 0.0

    def stats(self) -> dict:
        rows = self.store.query("SELECT state, COUNT(*) AS n FROM memory GROUP BY state")
        return {r["state"]: r["n"] for r in rows}
