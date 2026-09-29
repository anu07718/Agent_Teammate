"""Ledger Trail: an append-only, hash-chained audit log. Editing any row breaks every hash after it."""
from __future__ import annotations

import hashlib
import json
import time

from .store import Store

GENESIS = "0" * 64


def _entry_hash(prev_hash: str, ts: float, case_id: str, kind: str, actor: str, payload: str) -> str:
    return hashlib.sha256(f"{prev_hash}|{ts:.6f}|{case_id}|{kind}|{actor}|{payload}".encode()).hexdigest()


class Trail:
    def __init__(self, store: Store):
        self.store = store

    def append(self, case_id: str, kind: str, actor: str, payload: dict) -> dict:
        with self.store.lock:
            last = self.store.query("SELECT hash FROM trail ORDER BY seq DESC LIMIT 1")
            prev = last[0]["hash"] if last else GENESIS
            ts = time.time()
            body = json.dumps(payload, sort_keys=True, default=str)
            h = _entry_hash(prev, ts, case_id, kind, actor, body)
            cur = self.store.execute(
                "INSERT INTO trail(ts, case_id, kind, actor, payload, prev_hash, hash) VALUES(?,?,?,?,?,?,?)",
                (ts, case_id, kind, actor, body, prev, h))
            return {"seq": cur.lastrowid, "ts": ts, "case_id": case_id, "kind": kind, "actor": actor,
                    "payload": payload, "prev_hash": prev, "hash": h}

    def entries(self, case_id: str | None = None, limit: int = 500) -> list[dict]:
        if case_id:
            rows = self.store.query("SELECT * FROM trail WHERE case_id=? ORDER BY seq", (case_id,))
        else:
            rows = self.store.query("SELECT * FROM (SELECT * FROM trail ORDER BY seq DESC LIMIT ?) ORDER BY seq",
                                    (limit,))
        return [{**dict(r), "payload": json.loads(r["payload"])} for r in rows]

    def verify(self, tamper_seq: int | None = None) -> dict:
        """Recompute the whole chain. `tamper_seq` checks a copy with that row's payload altered (a demo)."""
        rows = self.store.query("SELECT * FROM trail ORDER BY seq")
        prev, broken_at = GENESIS, None
        for r in rows:
            payload = r["payload"]
            if tamper_seq is not None and r["seq"] == tamper_seq:
                payload = payload.replace("}", ', "tampered": true}', 1) if payload.endswith("}") else payload + "x"
            expected = _entry_hash(prev, r["ts"], r["case_id"], r["kind"], r["actor"], payload)
            if r["prev_hash"] != prev or expected != r["hash"]:
                broken_at = r["seq"]
                break
            prev = r["hash"]
        return {"ok": broken_at is None, "entries": len(rows), "broken_at": broken_at,
                "head": rows[-1]["hash"] if rows else GENESIS, "simulated_tamper": tamper_seq}
