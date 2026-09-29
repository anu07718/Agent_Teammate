"""The Seal: seal = H(payload ‖ recheck ‖ ledger_version ‖ policy_hash).

A human approves a sealed action, not a description of one. At commit the seal is recomputed from
the live world; if the ledger moved, the plan was edited or the policy changed, it no longer matches
and the approval does not apply.
"""
from __future__ import annotations

import hashlib
import json


def _canon(v) -> str:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), default=str)


def compute(payload: dict, recheck: dict, ledger_version: str, policy_hash: str) -> str:
    parts = [_canon(payload), _canon({k: recheck.get(k) for k in ("ok", "baseline", "result")}), ledger_version,
             policy_hash]
    return hashlib.sha256("‖".join(parts).encode()).hexdigest()


def verify(seal: str, payload: dict, recheck: dict, ledger_version: str, policy_hash: str) -> dict:
    now = compute(payload, recheck, ledger_version, policy_hash)
    return {"ok": now == seal, "expected": seal, "actual": now}
