"""The office roster: every agent, its department, its persona, and what it is doing right now."""
from __future__ import annotations

import time
from pathlib import Path

PERSONAS = Path(__file__).parent / "personas"
# Six departments around the Brain, in the order a case meets them. Each has a lead: the desk that
# takes work typed to the department when no specialist fits.
DEPARTMENTS = [
    {"id": "intake", "name": "Intake", "blurb": "Screens, tokenises and routes every message", "lead": "triage"},
    {"id": "resolution", "name": "Resolution", "blurb": "Specialists who own the case and plan the fix", "lead": "upi"},
    {"id": "verification", "name": "Verification", "blurb": "Evidence, the dry run and the recheck", "lead": "evidence"},
    {"id": "decision", "name": "Decision", "blurb": "Calibrated score, certified route, the seal", "lead": "router"},
    {"id": "commit", "name": "Commit & Reply", "blurb": "Exactly-once commits and checked replies", "lead": "commit"},
    {"id": "oversight", "name": "Oversight", "blurb": "Approvals, the audit trail and drift", "lead": "human"},
]
DEPARTMENT_IDS = [d["id"] for d in DEPARTMENTS]
STEP_AGENTS = {"intake": ["pii", "sentry"], "understand": ["triage"], "evidence": ["evidence"], "plan": [],
               "calibrate": ["calibrator"], "shadow": ["shadow", "recheck"], "route": ["router"],
               "commit": ["commit"], "respond": ["guard", "responder"], "learn": ["trail", "drift"]}
# The connected systems each desk usually reaches for (names match the Tool Gateway's `system`).
AGENT_SYSTEMS = {
    "sentry": ["CRM"], "evidence": ["UPI switch", "Core banking", "Refund engine", "CRM"],
    "shadow": ["Core banking"], "recheck": ["Core banking", "UPI switch"],
    "upi": ["UPI switch", "Core banking"], "refund": ["Refund engine", "Core banking"],
    "fraud": ["Card & UPI control", "Dispute desk"], "kyc": ["CRM", "Core banking"],
    "commit": ["Core banking", "Wallet ledger", "Dispute desk", "Card & UPI control"],
    "responder": ["Messaging"],
}


def _parse(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    meta, body = {}, text
    if text.startswith("---"):
        head, body = text[3:].split("---", 1)
        for line in head.strip().splitlines():
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip()
    meta["persona"] = body.strip()
    meta["lead"] = meta.get("lead", "").lower() == "true"
    return meta


class Roster:
    def __init__(self):
        self.agents: dict[str, dict] = {}
        for p in sorted(PERSONAS.glob("*.md")):
            m = _parse(p)
            m["systems"] = AGENT_SYSTEMS.get(m["id"], [])
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

    @staticmethod
    def lead_of(department: str) -> str:
        return next(d["lead"] for d in DEPARTMENTS if d["id"] == department)

    def public(self) -> list[dict]:
        return [{k: v for k, v in a.items() if k != "persona"} for a in self.agents.values()]
