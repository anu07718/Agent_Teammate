"""The office roster: every agent, its department, its persona, and what it is doing right now."""
from __future__ import annotations

import time
from pathlib import Path

PERSONAS = Path(__file__).parent / "personas"
DEPARTMENTS = [
    {"id": "front_desk", "name": "Front Desk", "blurb": "Sentry and the PII tokeniser"},
    {"id": "triage", "name": "Triage", "blurb": "Intent, details, the right desk"},
    {"id": "specialists", "name": "Specialists", "blurb": "UPI, refunds, risk, accounts"},
    {"id": "verification", "name": "Verification Lab", "blurb": "Evidence, shadow run, recheck"},
    {"id": "decision", "name": "Decision Room", "blurb": "Calibration and routing"},
    {"id": "vault", "name": "Seal Vault", "blurb": "Seals and exactly-once commits"},
    {"id": "comms", "name": "Comms", "blurb": "Promise Guard and replies"},
    {"id": "compliance", "name": "Compliance", "blurb": "Audit trail and drift"},
    {"id": "humans", "name": "Human Desk", "blurb": "Approve, edit or reject"},
]
STEP_AGENTS = {"intake": ["pii", "sentry"], "understand": ["triage"], "evidence": ["evidence"], "plan": [],
               "calibrate": ["calibrator"], "shadow": ["shadow", "recheck"], "route": ["router"],
               "commit": ["commit"], "respond": ["guard", "responder"], "learn": ["trail", "drift"]}


def _parse(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    meta, body = {}, text
    if text.startswith("---"):
        head, body = text[3:].split("---", 1)
        for line in head.strip().splitlines():
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip()
    meta["persona"] = body.strip()
    return meta


class Roster:
    def __init__(self):
        self.agents: dict[str, dict] = {}
        for p in sorted(PERSONAS.glob("*.md")):
            m = _parse(p)
            self.agents[m["id"]] = {**m, "status": "idle", "case_id": None, "doing": None, "since": time.time(),
                                    "handled": 0, "log": []}

    def work(self, agent_id: str, case_id: str, doing: str) -> dict:
        a = self.agents[agent_id]
        a.update(status="working", case_id=case_id, doing=doing, since=time.time())
        a["log"] = (a["log"] + [{"ts": time.time(), "case_id": case_id, "doing": doing}])[-30:]
        return a

    def idle(self, agent_id: str) -> dict:
        a = self.agents[agent_id]
        if a["status"] == "working":
            a["handled"] += 1
        a.update(status="idle", case_id=None, doing=None, since=time.time())
        return a

    def waiting(self, agent_id: str, case_id: str, doing: str) -> dict:
        a = self.agents[agent_id]
        a.update(status="waiting", case_id=case_id, doing=doing, since=time.time())
        a["log"] = (a["log"] + [{"ts": time.time(), "case_id": case_id, "doing": doing}])[-30:]
        return a

    def public(self) -> list[dict]:
        return [{k: v for k, v in a.items() if k != "persona"} for a in self.agents.values()]
