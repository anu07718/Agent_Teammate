"""Office operations: the work that is not a customer case.

Any department can be given a task in plain words: "verify the audit trail", "pull the evidence for
T-5001", "run the benchmark", "recalibrate". A routine runs the same tasks on a schedule, and a task can
be booked for a date. Each one is an op, a card on the office board that moves
scheduled → doing → (waiting for your OK) → done. Customer messages typed to Intake or Resolution are
cases, not ops; a case booked for later is an op until its minute comes, then it opens the case.
"""
from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from typing import Callable

from . import benchmark, schedule, scope, specialists
from . import guard as promise_guard
from .agents import DEPARTMENTS, Roster
from .gateway import GatewayError
from .presets import PRESETS
from .replies import rs
from .understand import understand

log = logging.getLogger("nirnaya.ops")
CASE_PODS = {"intake", "resolution"}
KEY = "office_ops"
LATE_AFTER_S = 90

# kind → where it runs and how it reads. `routine`: may run on a schedule. Matched in this order.
KINDS: dict[str, dict] = {
    "tamper-test": {"dept": "oversight", "agent": "trail", "title": "Tamper test on the audit trail", "routine": True,
                    "match": r"\btamper\w*", "help": "run a tamper test on the audit trail (nothing is changed)"},
    "trail-verify": {"dept": "oversight", "agent": "trail", "title": "Verify the audit trail", "routine": True,
                     "match": r"\b(trail|audit\s*log|hash\s*chain|chain|verify)\b", "help": "verify the hash-chained audit trail"},
    "recalibrate": {"dept": "decision", "agent": "calibrator", "title": "Recalibrate on the real labels", "routine": True,
                    "needs_ok": True, "match": r"\b(re-?calibrat\w*|re-?fit\w*|retrain\w*)",
                    "help": "recalibrate on the real labels (waits for your OK)"},
    "benchmark": {"dept": "decision", "agent": "calibrator", "title": "Run the benchmark", "routine": True,
                  "match": r"\b(benchmark\w*|pass\s*\^?\s*k|simulat\w*|test\s+(the\s+)?(office|agents|thresholds))",
                  "help": "run the benchmark: 12 scenarios × 3 phrasings"},
    "thresholds": {"dept": "decision", "agent": "router", "title": "List the certified thresholds", "routine": True,
                   "match": r"\b(thresholds?|certif\w*|alphas?|α)", "help": "list the certified thresholds per action"},
    "score": {"dept": "decision", "agent": "router", "title": "Score an action", "routine": False,
              "match": r"\bscore\b", "help": "score an action, e.g. “score refund_duplicate 349”"},
    "undo": {"dept": "commit", "agent": "commit", "title": "Undo a hedged action", "routine": False,
             "match": r"\bundo\b", "help": "undo a hedged action, e.g. “undo NR-1004”"},
    "evidence-pull": {"dept": "verification", "agent": "evidence", "title": "Pull the evidence", "routine": True,
                      "match": r"\bT-\d{4}\b", "help": "pull the evidence for a transaction, e.g. “check T-5001”"},
    "drift-check": {"dept": "oversight", "agent": "drift", "title": "Check for drift", "routine": True,
                    "match": r"\b(drift|psi|distribution)\b", "help": "check live scores for drift"},
    "tat-watch": {"dept": "oversight", "agent": "human", "title": "Find approvals past their TAT", "routine": True,
                  "match": r"\b(tat|overdue|turnaround|late|waiting|pending)\b", "help": "find approvals past their TAT"},
    "digest": {"dept": "oversight", "agent": "human", "title": "Write today's digest", "routine": True,
               "match": r"\b(digest|summary|summari[sz]e|report|numbers|today|how did we do)\b",
               "help": "write today's digest"},
    "sample": {"dept": "intake", "agent": "triage", "title": "Open a sample case", "routine": True,
               "match": r"\b(sample|demo|test\s+(case|message|customer)s?|simulated?\s+customers?)\b",
               "help": "open a sample customer case"},
    "guard-check": {"dept": "commit", "agent": "guard", "title": "Check a reply with Promise Guard", "routine": False,
                    "match": r"\b(check|guard|promise|reply|draft)\b", "help": "check a reply draft, e.g. “check: …”"},
}
DEPT_NAME = {d["id"]: d["name"] for d in DEPARTMENTS}
PCT = lambda x: f"{round(100 * x)}%"


def kind_for(text: str, dept: str | None = None, *, routine: bool = False) -> str | None:
    low = text.lower()
    order = list(KINDS)
    if dept:  # the chosen department's own kinds first
        order = [k for k in order if KINDS[k]["dept"] == dept] + [k for k in order if KINDS[k]["dept"] != dept]
    for k in order:
        spec = KINDS[k]
        if routine and not spec["routine"]:
            continue
        if k == "undo" and not re.search(r"\bNR-\d+", text, re.I):
            continue
        if k == "guard-check" and dept != "commit":
            continue
        if re.search(spec["match"], low, re.I):
            return k
    if dept == "commit" and not routine and text.strip():
        return "guard-check"
    return None


def can_do(dept: str) -> list[str]:
    return [KINDS[k]["help"] for k in KINDS if KINDS[k]["dept"] == dept]


def interpret(dept: str, text: str, when: dict | None = None) -> dict:
    """What the office will do with this sentence, before it does it (the bar's hint)."""
    text = (text or "").strip()
    if dept not in DEPT_NAME:
        return {"kind": "error", "problem": f"unknown department {dept}"}
    sc = scope.check(text, scope.CUSTOMER if dept in CASE_PODS else scope.STAFF)   # words only: this is the live hint
    if not sc["in_scope"]:
        return {"kind": "off_topic", "dept": dept, "category": sc["category"],
                "problem": "Finance only: " + scope.refusal(scope.STAFF, sc["category"])}
    parsed = {"when": when, "text": text, "needs_time": False, "needs_day": False, "guessed": None} if when \
        else schedule.parse(text)
    if parsed and dept in CASE_PODS and not when and kind_for(parsed["text"], dept, routine=True) != "sample":
        parsed = None  # "my daily limit…" is a customer talking, not a timetable
    if parsed:
        rest = parsed["text"] or text
        k = kind_for(rest, dept, routine=True)
        out = {"kind": "routine", "when": parsed["when"], "when_desc": schedule.describe(parsed["when"]),
               "text": rest, "guessed": parsed.get("guessed")}
        if parsed.get("needs_day"):
            return {**out, "problem": "Which day? Say “every Monday …” or “Mon and Thu …”."}
        if parsed.get("needs_time"):
            return {**out, "problem": "What time? Add “at 8am” or “at 17:30”."}
        if not k:
            return {**out, "problem": "Routines can " + "; ".join(KINDS[x]["help"] for x in KINDS if KINDS[x]["routine"]) + "."}
        spec = KINDS[k]
        return {**out, "op_kind": k, "dept": spec["dept"], "agent": spec["agent"], "title": title_for(k, rest),
                "needs_ok": bool(spec.get("needs_ok")), "next_at": schedule.next_run(parsed["when"], time.time())}
    if dept in CASE_PODS:
        u = understand(text)
        owner = specialists.SPECIALIST.get(u["intent"], "triage")
        return {"kind": "case", "dept": _dept_of(owner), "agent": owner, "intent": u["intent"],
                "confidence": u["confidence"], "title": text[:90]}
    k = kind_for(text, dept) or "help"
    if k == "help":
        return {"kind": "op", "op_kind": "help", "dept": dept, "agent": Roster.lead_of(dept), "title": text[:90] or "Help",
                "problem": None, "can": can_do(dept)}
    spec = KINDS[k]
    return {"kind": "op", "op_kind": k, "dept": spec["dept"], "agent": spec["agent"], "title": title_for(k, text),
            "needs_ok": bool(spec.get("needs_ok"))}


_AGENT_DEPT: dict[str, str] = {}


def _dept_of(agent: str) -> str:
    if not _AGENT_DEPT:
        from .agents import PERSONAS, _parse
        _AGENT_DEPT.update({p.stem: _parse(p)["department"] for p in PERSONAS.glob("*.md")})
    return _AGENT_DEPT.get(agent, "intake")


def title_for(kind: str, text: str) -> str:
    t = KINDS[kind]["title"]
    if kind == "evidence-pull":
        m = re.search(r"\bT-\d{4}\b", text, re.I)
        return f"Pull the evidence for {m.group(0).upper()}" if m else t
    if kind == "undo":
        m = re.search(r"\bNR-\d+", text, re.I)
        return f"Undo the hedged action on {m.group(0).upper()}" if m else t
    if kind == "score":
        return f"Score: {text[:70]}"
    return t


class Ops:
    """The op list lives in the store, so it survives a restart like everything else."""

    def __init__(self, get_engine: Callable):
        self.E = get_engine
        self._running: set[asyncio.Task] = set()

    # ── storage ──────────────────────────────────────────────────────────────
    def all(self) -> list[dict]:
        return self.E().store.kv_get(KEY, []) or []

    def get(self, op_id: str) -> dict | None:
        return next((o for o in self.all() if o["id"] == op_id), None)

    def _put(self, op: dict) -> dict:
        ops = self.all()
        i = next((n for n, o in enumerate(ops) if o["id"] == op["id"]), None)
        if i is None:
            ops.append(op)
        else:
            ops[i] = op
        self.E().store.kv_set(KEY, ops[-300:])
        self.E().bus.publish("op.updated", op=op)
        return op

    def _remove(self, op_id: str) -> None:
        self.E().store.kv_set(KEY, [o for o in self.all() if o["id"] != op_id])
        self.E().bus.publish("op.removed", op_id=op_id)

    def _next_id(self) -> str:
        n = self.E().store.kv_get("office_ops_seq", 1000) + 1
        self.E().store.kv_set("office_ops_seq", n)
        return f"OP-{n}"

    # ── lifecycle ────────────────────────────────────────────────────────────
    def create(self, kind: str, *, dept: str, agent: str, title: str, text: str = "", by: str = "you",
               routine: str | None = None, due_at: float | None = None, needs_ok: bool | None = None,
               customer_id: str | None = None, channel: str | None = None, late: bool = False,
               done: tuple[bool, str] | None = None) -> dict:
        """A new op. `done` records one that already ran (a quiet routine that found something)."""
        now = time.time()
        op = {"id": self._next_id(), "kind": kind, "dept": dept, "agent": agent, "title": title, "text": text,
              "by": by, "routine": routine, "state": "scheduled" if due_at else "next", "created_at": now,
              "started_at": None, "done_at": None, "due_at": due_at, "waiting_at": None, "result": None, "ok": None,
              "needs_ok": bool(KINDS.get(kind, {}).get("needs_ok")) if needs_ok is None else needs_ok, "ask": None,
              "approved": False, "rejected": False, "note": None, "late": late, "case_id": None, "tools": [],
              "customer_id": customer_id, "channel": channel}
        if done:
            op.update(state="done", started_at=now, done_at=now, ok=done[0], result=done[1])
        self._put(op)
        if not due_at and not done:
            self.start(op["id"])
        return op

    def start(self, op_id: str, approved: bool = False) -> None:
        t = asyncio.get_running_loop().create_task(self._run(op_id, approved))
        self._running.add(t)
        t.add_done_callback(self._running.discard)

    async def _run(self, op_id: str, approved: bool) -> dict | None:
        op = self.get(op_id)
        if not op:
            return None
        e = self.E()
        if op["needs_ok"] and not approved:
            op.update(state="waiting", waiting_at=time.time(), ask=ask_for(e, op))
            e.roster.waiting(op["agent"], op["id"], "waiting for your OK")
            e.bus.publish("agent.status", agent=op["agent"], status="waiting", case_id=op["id"],
                          doing="waiting for your OK", department=op["dept"])
            return self._put(op)
        op.update(state="doing", started_at=time.time())
        self._put(op)
        e.roster.work(op["agent"], op["id"], op["title"])
        e.bus.publish("agent.status", agent=op["agent"], status="working", case_id=op["id"], doing=op["title"],
                      department=op["dept"])
        await asyncio.sleep(0.3 if e.step_delay else 0)
        try:
            ok, result, extra = await run_kind(e, op)
        except Exception as ex:  # an op that fails says so on its card; it never takes the office down
            log.exception("op %s failed", op_id)
            ok, result, extra = False, f"Could not finish: {ex}", {}
        op = self.get(op_id) or op
        op.update(state="done", done_at=time.time(), ok=ok, result=result, approved=approved or op["approved"], **extra)
        e.roster.idle(op["agent"])
        e.bus.publish("agent.status", agent=op["agent"], status="idle", case_id=None, doing=None, department=op["dept"])
        e.trail.append(op.get("case_id") or "-", "office.op", op["agent"],
                       {"op": op["id"], "kind": op["kind"], "ok": ok, "by": op["by"]})
        return self._put(op)

    def approve(self, op_id: str, by: str = "you") -> dict:
        op = self.get(op_id)
        if not op or op["state"] != "waiting":
            raise ValueError("this is not waiting for your OK")
        op.update(approved=True, approved_by=by, state="doing")
        self.E().trail.append(op.get("case_id") or "-", "office.op.approved", by, {"op": op_id})
        self._put(op)
        self.start(op_id, approved=True)
        return op

    def reject(self, op_id: str, note: str = "", by: str = "you") -> dict:
        op = self.get(op_id)
        if not op or op["state"] != "waiting":
            raise ValueError("this is not waiting for your OK")
        e = self.E()
        who = "you" if by == "you" else by
        op.update(state="done", done_at=time.time(), ok=False, rejected=True, note=note or None, rejected_by=by,
                  result=f"Not run: {who} said no" + (f" — “{note}”" if note else "") + ".")
        e.roster.idle(op["agent"])
        e.bus.publish("agent.status", agent=op["agent"], status="idle", case_id=None, doing=None, department=op["dept"])
        e.trail.append("-", "office.op.rejected", by, {"op": op_id, "note": note})
        return self._put(op)

    def cancel(self, op_id: str) -> None:
        op = self.get(op_id)
        if not op or op["state"] != "scheduled":
            raise ValueError("only a scheduled task can be cancelled")
        self._remove(op_id)

    def fire_due(self, now: float | None = None) -> list[str]:
        now = now or time.time()
        fired = []
        for op in self.all():
            if op["state"] == "scheduled" and op.get("due_at") and op["due_at"] <= now:
                op.update(state="next", late=now - op["due_at"] > LATE_AFTER_S)
                self._put(op)
                self.start(op["id"])
                fired.append(op["id"])
        return fired


def ask_for(e, op: dict) -> str:
    if op["kind"] == "recalibrate":
        n = len(e.store.labels())
        return (f"Recalibrate on {n} real label{'s' if n != 1 else ''} and re-certify every threshold? "
                f"Calibration error today: {e.calibrator.metrics['ece_calibrated']:.3f}.")
    return f"“{op['title']}” is ready. Run it?"


async def run_kind(e, op: dict) -> tuple[bool, str, dict]:
    k, text = op["kind"], op.get("text") or ""
    if k == "case":
        c = e.create_case(op.get("customer_id") or "C-1001", text, op.get("channel") or "chat",
                          by=None if op["by"] in ("you", "routine") else op["by"])
        e.start(c["id"])
        return True, f"Opened {c['id']} for {c['customer_name']}. It is on the board as its own card.", {"case_id": c["id"]}
    if k == "sample":
        p = random.choice(PRESETS)
        c = e.create_case(p["customer"], p["text"], "chat")
        e.start(c["id"])
        return True, f"Opened {c['id']}: “{p['label']}” from {c['customer_name']}.", {"case_id": c["id"]}
    if k == "evidence-pull":
        m = re.search(r"\bT-\d{4}\b", text, re.I)
        tid = m.group(0).upper() if m else ""
        t = e.rails.txn(tid) if tid else None
        if not t:
            return False, (f"There is no transaction {tid}." if tid else "Which transaction?") + " Try T-5001 to T-5009.", {}
        reads, tools = {}, []
        for name in ("upi.status", "bank.debit_status", "refund.status"):
            try:
                reads[name] = e.gateway.read(name, agent="evidence", case_id=op["id"], txn_id=tid)
                tools.append(e.gateway.tools[name].system)
            except GatewayError as ex:
                reads[name] = {"error": str(ex)}
        merchant = e.tok.tokenise(t["merchant"])[0] if "@" in t["merchant"] else t["merchant"]
        u, d, r = reads["upi.status"], reads["bank.debit_status"], reads["refund.status"]
        lines = [f"{tid} · {rs(t['amount'])} to {merchant} · UTR {t['utr']}",
                 "UPI switch: " + (u.get("error") or f"{u['npci_status']}, beneficiary {'credited' if u['beneficiary_credited'] else 'not credited'}, reversal {u['reversal']}"),
                 "Core banking: " + (d.get("error") or f"{d['debit_status']}, reversal {d['reversal']['status']}"),
                 "Refund engine: " + (r.get("error") or f"{r['refund']['status']}")]
        ok = not any("error" in x for x in reads.values())
        return ok, "\n".join(lines), {"tools": tools}
    if k == "benchmark":
        r = await benchmark.run(e, k=3, label="routine" if op["by"] == "routine" else "office")
        return True, (f"pass^{r['k']} {PCT(r['pass_k'])} over {r['scenarios']} scenarios × {r['k']} phrasings · "
                      f"{PCT(r['autonomy'])} handled alone · {r['wrong_autonomous']} wrong autonomous action(s) · "
                      f"run {r['id']} in {r['seconds']} s"), {}
    if k == "recalibrate":
        before = e.calibrator.metrics["ece_calibrated"]
        m = e.recalibrate()
        return True, (f"Recalibrated on {m.get('real_labels', len(e.store.labels()))} real label(s). "
                      f"Calibration error {before:.3f} → {m['ece_calibrated']:.3f}; every threshold re-certified."), {}
    if k == "thresholds":
        lines = []
        for aid, a in e.policy.actions.items():
            th = e.risk.thresholds(aid, 500)
            lam = (th.get("act") or {}).get("lambda")
            lines.append(f"{a.label}: α {a.alpha:.1%} · acts alone above {lam:.2f}" if lam is not None
                         else f"{a.label}: α {a.alpha:.1%} · never alone (nothing certified)")
        return True, "\n".join(lines), {}
    if k == "score":
        low = text.lower()
        aid = next((a for a, v in e.policy.actions.items() if a in low or v.label.lower() in low), None)
        amt = re.search(r"(\d[\d,]*(?:\.\d+)?)", text)
        if not aid or not amt:
            return False, "Say the action and the amount, e.g. “score refund_duplicate 349”. Actions: " + \
                ", ".join(e.policy.actions), {}
        from .calibration import log_amount
        amount = float(amt.group(1).replace(",", ""))
        feats = {"intent_conf": 0.85, "evidence_agree": 1.0, "log_amount": log_amount(amount), "prior_disputes": 0.0,
                 "memory_support": 0.5, "sentry_risk": 0.05, "novelty": 0.0, "voice": 0.0}
        s = e.calibrator.score(feats, aid)
        th = e.risk.thresholds(aid, amount)
        route, why = e._route_one({"sentry": {"verdict": "pass"}}, {"type": aid, "amount": amount}, s["calibrated"], th)
        return True, (f"{e.policy.actions[aid].label} at {rs(amount)} ({th['band']} band): calibrated "
                      f"{s['calibrated']:.3f} (stated {s['stated']:.3f}) → {route}. {why}"), {}
    if k == "undo":
        m = re.search(r"\bNR-\d+", text, re.I)
        case_id = m.group(0).upper()
        try:
            await e.undo(case_id, by="support lead" if op["by"] in ("you", "routine") else op["by"])
        except (KeyError, ValueError) as ex:
            return False, f"{case_id}: {ex}", {"case_id": case_id}
        return True, f"Undid the hedged action on {case_id} and told the customer.", {"case_id": case_id}
    if k == "guard-check":
        draft = re.sub(r"^\s*(check|guard)\s*[:\-–]?\s*", "", text, flags=re.I)
        g = promise_guard.check(draft, [], False)
        if g["ok"]:
            return True, f"Clean: {g['claims_checked']} claim(s) checked, nothing promised beyond policy.", {}
        return False, "Would be blocked:\n" + "\n".join("• " + v["detail"] for v in g["violations"]), {}
    if k == "trail-verify":
        v = e.trail.verify()
        return v["ok"], (f"Chain intact · {v['entries']} entries · head {v['head'][:12]}…" if v["ok"]
                         else f"Chain BROKEN at entry #{v['broken_at']} of {v['entries']}"), {}
    if k == "tamper-test":
        rows = e.trail.entries(limit=50)
        seq = rows[len(rows) // 2]["seq"] if rows else None
        if seq is None:
            return False, "The trail is empty; nothing to test yet.", {}
        v = e.trail.verify(tamper_seq=seq)
        return True, (f"Changed entry #{seq} on a copy: the chain breaks at #{v['broken_at']}, so the edit is caught. "
                      "Nothing on the real trail was touched."), {}
    if k == "drift-check":
        prev = e.drift_status["alarm"]
        e.drift_status = e.drift.check()
        if e.drift_status["alarm"] != prev:
            e.refit_thresholds()
            e.bus.publish("drift.alarm", status=e.drift_status)
        d = e.drift_status
        return not d["alarm"], (f"PSI {d['psi']:.2f} · audit error {d['audit_error']:.0%} · "
                                + (f"ALARM: {d['reason']}; every α halved, autonomy capped" if d["alarm"] else "no drift")), {}
    if k == "tat-watch":
        overdue = [c["id"] for c in e.store.list_cases(500)
                   if c.get("pending") and time.time() - c["pending"]["requested_at"] > 4 * 3600]
        waiting = sum(1 for c in e.store.list_cases(500) if c.get("pending"))
        if overdue:
            e.bus.publish("routine.alert", routine="tat-watch", cases=overdue)
        return not overdue, (f"{len(overdue)} approval(s) past 4 h: {', '.join(overdue)}" if overdue
                             else f"Nothing past its TAT · {waiting} waiting on you"), {}
    if k == "digest":
        s = e.stats()
        facts = (f"{s['cases']} case(s), {s['done']} finished · {PCT(s['autonomy'])} handled alone · "
                 f"{s['pending_approvals']} waiting on you · "
                 + (f"first reply {s['avg_first_reply_s']} s on average · " if s["avg_first_reply_s"] else "")
                 + (f"{rs(s['cost_per_case'])} per case vs {rs(s['human_only_cost_per_case'])} for a human" if s["cost_per_case"] else "no cost yet"))
        if e.llm.enabled:                       # Oversight words it with the free model; the numbers are checked
            info: dict = {}
            worded = await asyncio.to_thread(e.llm.word_digest, facts, info)
            if worded and info:
                return True, f"{worded} (via {info['label']} · {info['model']})", {"facts": facts}
        return True, facts, {}
    if k == "help":
        dept = op["dept"]
        return True, f"{DEPT_NAME[dept]} can: " + "; ".join(can_do(dept)) + ".", {}
    return False, f"unknown kind {k}", {}
