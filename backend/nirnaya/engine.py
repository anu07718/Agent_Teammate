"""The engine: ten supersteps per case, a checkpoint after each, and a sealed pause wherever a human decides.

intake → understand → evidence → plan → calibrate → shadow → route → commit → respond → learn

A checkpoint is written at every superstep boundary, chained to the previous one and stamped with the
workflow graph hash and the policy hash. A parked case waits in its checkpoint, not in memory: the
process can restart and the approval still lands on exactly the state that was sealed.
"""
from __future__ import annotations

import asyncio
import copy
import logging
import os
import threading
import time
import uuid

from . import replies, specialists
from . import guard as promise_guard
from .agents import STEP_AGENTS, Roster
from .calibration import Calibrator, log_amount
from .conformal import RiskControl
from .drift import DriftMonitor
from .events import EventBus
from .gateway import Gateway, GatewayError
from .graph import Graph
from .llm import LLM
from .memory import Memory
from .pii import Tokeniser
from .policy import GRAPH_HASH, SUPERSTEPS, Policy
from .rails import Rails
from .sentry_gate import Sentry
from .shadow import recheck as do_recheck
from .shadow import shadow_execute
from .store import Store
from .trail import Trail
from .understand import understand

log = logging.getLogger("nirnaya.engine")
INFO = {"share_status", "request_info"}
ORDER = {"ACT": 0, "HEDGE": 1, "ESCALATE": 2, "REFUSE": 3}
COST = {"auto": 4.5, "human": 50.0}          # ₹ per case: autonomous vs human-handled (deck estimate)


class Engine:
    def __init__(self, store: Store | None = None, *, step_delay: float | None = None, llm: LLM | None = None,
                 calibration_n: int = 200_000, calibrator: Calibrator | None = None):
        self.store = store or Store()
        self.bus = EventBus()
        self.policy = Policy()
        self._apply_overrides()
        self.trail = Trail(self.store)
        self.rails = Rails(self.store)
        self.tok = Tokeniser(self.store)
        self.sentry = Sentry()
        self.gateway = Gateway(self.rails, self.store, self.bus, self.policy)
        self.memory = Memory(self.store, self.rails)
        self.graph = Graph(self.store)
        self.graph.build_from(self.rails, lambda v: self.tok.tokenise(v)[0])
        self.roster = Roster()
        self.llm = llm if llm is not None else LLM(self.store)
        self.llm.bind(self.store)
        if calibrator is not None:
            self.calibrator = calibrator
        else:
            self.calibrator = Calibrator(n=calibration_n)
            labels = self.store.labels()
            if labels:
                self.calibrator.fit(extra_labels=labels)
        self.drift = DriftMonitor(self.calibrator.cal_scores, by_action=self.calibrator.cal_by_action)
        self.drift_status = self.drift.check()
        self.risk = RiskControl()
        self._fit_lock = threading.Lock()  # refits come from request threads; one at a time, newest policy last
        self.refit_thresholds()
        self.step_delay = float(os.environ.get("NIRNAYA_STEP_DELAY", "0.45")) if step_delay is None else step_delay
        self.tasks: dict[str, asyncio.Task] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self.started_at = time.time()

    # ── configuration ────────────────────────────────────────────────────────
    def _apply_overrides(self) -> None:
        for aid, ov in (self.store.kv_get("policy_overrides") or {}).items():
            a = self.policy.actions.get(aid)
            if a:
                a.alpha = float(ov.get("alpha", a.alpha))
                a.rung = int(ov.get("rung", a.rung))

    def refit_thresholds(self) -> None:
        with self._fit_lock:
            c = self.calibrator
            self.risk.fit(c.cal_rows, c.cal_scores, c.cal_y, self.policy.actions,
                          alpha_scale=self.drift_status["alpha_scale"])

    def set_policy(self, action: str, alpha: float | None = None, rung: int | None = None, by: str = "supervisor"):
        a = self.policy.actions[action]
        ov = self.store.kv_get("policy_overrides") or {}
        entry = ov.get(action, {})
        if alpha is not None:
            a.alpha = max(0.0005, min(0.25, float(alpha)))
            entry["alpha"] = a.alpha
        if rung is not None:
            a.rung = max(0, min(2, int(rung)))
            entry["rung"] = a.rung
        ov[action] = entry
        self.store.kv_set("policy_overrides", ov)
        self.refit_thresholds()
        self.trail.append("-", "policy.changed", by, {"action": action, "alpha": a.alpha, "rung": a.rung,
                                                      "policy_hash": self.policy.policy_hash()})
        self.bus.publish("policy.changed", action=action, alpha=a.alpha, rung=a.rung,
                         policy_hash=self.policy.policy_hash())

    def recalibrate(self) -> dict:
        labels = self.store.labels()
        self.calibrator.fit(extra_labels=labels or None)
        self.drift.reference = self.calibrator.cal_scores
        self.drift.by_action = self.calibrator.cal_by_action
        self.refit_thresholds()
        self.trail.append("-", "model.recalibrated", "calibrator", {"real_labels": len(labels),
                                                                     "ece": self.calibrator.metrics["ece_calibrated"]})
        self.bus.publish("model.recalibrated", real_labels=len(labels), ece=self.calibrator.metrics["ece_calibrated"])
        return self.calibrator.metrics

    # ── helpers ──────────────────────────────────────────────────────────────
    def _lock(self, case_id: str) -> asyncio.Lock:
        """One writer per case: a human decision waits for the case's own steps to finish, and vice versa."""
        return self._locks.setdefault(case_id, asyncio.Lock())

    def _agent(self, aid: str, case: dict, doing: str) -> None:
        a = self.roster.work(aid, case["id"], doing)
        self.bus.publish("agent.status", agent=aid, status=a["status"], case_id=case["id"], doing=doing,
                         department=a.get("department"))

    def _idle(self, *aids: str) -> None:
        for aid in aids:
            a = self.roster.idle(aid)
            self.bus.publish("agent.status", agent=aid, status="idle", case_id=None, doing=None,
                             department=a.get("department"))

    def _checkpoint(self, case: dict, step: str, status: str) -> dict:
        prev = self.store.latest_checkpoint(case["id"])
        cp = {"id": f"cp-{uuid.uuid4().hex[:10]}", "case_id": case["id"], "prev_id": prev["id"] if prev else None,
              "superstep": step, "status": status, "graph_hash": GRAPH_HASH,
              "policy_hash": self.policy.policy_hash(), "state": copy.deepcopy(case), "created_at": time.time()}
        self.store.add_checkpoint(cp)
        case["checkpoint_id"] = cp["id"]
        return cp

    def _save(self, case: dict) -> None:
        self.store.save_case(case)
        self.bus.publish("case.updated", case=self.summary(case))

    async def _pause(self, factor: float = 1.0) -> None:
        if self.step_delay:
            await asyncio.sleep(self.step_delay * factor)

    @staticmethod
    def summary(case: dict) -> dict:
        txn = case.get("txn") or {}
        return {"id": case["id"], "customer_id": case["customer_id"], "customer_name": case.get("customer_name"),
                "channel": case["channel"], "status": case["status"], "route": case.get("route"),
                "intent": case.get("intent"), "step": case.get("step"), "created_at": case["created_at"],
                "updated_at": case.get("updated_at"), "amount": txn.get("amount"), "txn_id": txn.get("id"),
                "preview": (case.get("text") or "")[:120], "specialist": (case.get("plan") or {}).get("specialist"),
                "owner": (case.get("plan") or {}).get("specialist")
                or specialists.SPECIALIST.get(case.get("intent") or "", "triage"),
                "pending": bool(case.get("pending")), "seal_broken": bool(case.get("seal_broken")),
                "first_reply_s": case.get("first_reply_s"), "opened_by": case.get("opened_by"),
                "approved_by": next((c["by"] for c in reversed(case.get("commits") or []) if c.get("by") not in (None, "autonomous")), None)}

    # ── public API ───────────────────────────────────────────────────────────
    def create_case(self, customer_id: str, message: str, channel: str = "chat", by: str | None = None) -> dict:
        cust = self.rails.customer(customer_id)
        if not cust:
            raise ValueError(f"unknown customer {customer_id}")
        n = self.store.count_cases() + 1
        case = {"id": f"NR-{1000 + n}", "customer_id": customer_id, "customer_name": cust["name"].split()[0],
                "channel": channel, "created_at": time.time(), "status": "running", "route": None, "intent": None,
                "step": "intake", "raw": message, "conversation": [], "supersteps": [], "decisions": [],
                "pending": None, "commits": [], "labels": [], "opened_by": by}
        self.store.save_case(case)
        self.trail.append(case["id"], "case.opened", "sentry", {"channel": channel, "customer": customer_id})
        self.bus.publish("case.created", case=self.summary(case))
        return case

    def start(self, case_id: str) -> None:
        loop = asyncio.get_running_loop()
        self.tasks[case_id] = loop.create_task(self.run(case_id))

    async def run(self, case_id: str, from_step: str | None = None) -> dict:
        async with self._lock(case_id):
            return await self._run(case_id, from_step)

    async def _run(self, case_id: str, from_step: str | None = None) -> dict:
        case = self.store.get_case(case_id)
        if case is None:
            raise KeyError(case_id)
        if from_step:
            idx = SUPERSTEPS.index(from_step)
        else:
            cp = self.store.latest_checkpoint(case_id)
            idx = 0 if not cp else SUPERSTEPS.index(cp["superstep"]) + 1
            if cp:
                case = copy.deepcopy(cp["state"])
            if cp and cp["status"] == "parked" and idx >= len(SUPERSTEPS):
                # parked and fully written: it waits for a human, nothing left to run
                case["status"], case["step"] = "parked", "waiting for approval"
                self._save(case)
                return case
            # a case parked mid-run (after commit, before respond/learn) finishes its remaining steps
        case["status"] = "running" if case["status"] not in ("parked",) else case["status"]
        retries = 0
        i = idx
        while i < len(SUPERSTEPS):
            step = SUPERSTEPS[i]
            if case.get("skip_to") and step not in (case["skip_to"], "learn") and \
                    SUPERSTEPS.index(step) < SUPERSTEPS.index(case["skip_to"]):
                i += 1
                continue
            case["step"] = step
            rec = {"name": step, "agents": list(STEP_AGENTS.get(step, [])), "started": time.time(), "note": ""}
            if step == "plan":
                rec["agents"] = [specialists.SPECIALIST.get(case.get("intent") or "other", "triage")]
            case["supersteps"].append(rec)
            self.bus.publish("superstep", case_id=case_id, step=step, phase="start", agents=rec["agents"])
            for aid in rec["agents"]:
                self._agent(aid, case, step)
            try:
                outcome = await getattr(self, f"_s_{step}")(case, rec)
            except Exception as e:  # a failed step escalates the case; it never half-commits
                log.exception("step %s failed for %s", step, case_id)
                rec["note"] = f"error: {e}"
                case["error"] = str(e)
                outcome = None
                if step in ("evidence", "plan", "calibrate", "shadow"):
                    case["route"] = "ESCALATE"
                    case["skip_to"] = "respond"
            rec["ended"] = time.time()
            self._idle(*rec["agents"])
            self.bus.publish("superstep", case_id=case_id, step=step, phase="end", agents=rec["agents"],
                             note=rec["note"])
            status = "parked" if case.get("pending") and step in ("commit", "respond", "learn") else "running"
            if step == "learn":
                status = "parked" if case.get("pending") else "done"
            self._checkpoint(case, step, status)
            self._save(case)
            if outcome == "replan" and retries < self.policy.shadow_retries:
                retries += 1
                i = SUPERSTEPS.index("evidence")
                continue
            await self._pause()
            i += 1
        case["status"] = "parked" if case.get("pending") else ("refused" if case.get("route") == "REFUSE" else "resolved")
        case["step"] = "waiting for approval" if case.get("pending") else "done"
        self._save(case)
        self.bus.publish("case.finished", case=self.summary(case))
        return case

    # ── supersteps ───────────────────────────────────────────────────────────
    async def _s_intake(self, case: dict, rec: dict):
        raw = case.pop("raw", "") or ""
        text, found = self.tok.tokenise(raw)
        case["text"], case["pii"] = text, found
        case["conversation"].append({"role": "customer", "text": text, "ts": time.time()})
        case["sentry"] = self.sentry.check(case["customer_id"], raw)
        s = case["sentry"]
        rec["note"] = f"{len(found)} identifier(s) tokenised · Sentry {s['verdict']} ({s['latency_ms']} ms)"
        self.trail.append(case["id"], "sentry.verdict", "sentry", {"verdict": s["verdict"], "risk": s["risk"],
                                                                   "rules": [r["rule"] for r in s["reasons"]]})
        if s["verdict"] == "block" or any(r["rule"] == "credential" for r in s["reasons"]):
            case["route"] = "REFUSE"
            case["skip_to"] = "respond"
        await self._pause(0.5)

    async def _s_understand(self, case: dict, rec: dict):
        u = understand(case["text"])
        if self.llm.enabled:
            got = await asyncio.to_thread(self.llm.extract, case["text"])
            if got:
                u["llm"] = got
                if got["intent"] == u["intent"]:
                    u["confidence"] = round(min(0.98, u["confidence"] + 0.05), 3)
                elif u["confidence"] < 0.6 and got["intent"] != "other":
                    u["intent"], u["confidence"], u["source"] = got["intent"], 0.6, "llm"
                for k in ("amount", "days_ago", "merchant"):
                    if got.get(k) is not None and k not in u["entities"]:
                        u["entities"][k] = got[k]
                if got.get("language") == "hinglish":
                    u["entities"]["language"] = "hinglish"
        case["understanding"], case["intent"] = u, u["intent"]
        rec["note"] = f"{u['intent']} · confidence {u['confidence']:.2f} · {u['source']}"

    async def _s_evidence(self, case: dict, rec: dict):
        u, cid = case["understanding"], case["customer_id"]
        match = specialists.match_txn(self.rails, cid, u["intent"], u["entities"])
        case["match"] = match
        tid = match["txn_id"]
        ev: dict = {"errors": [], "instrument": u["entities"].get("instrument", "upi")}

        async def read(key, tool, **args):
            try:
                ev[key] = await asyncio.to_thread(self.gateway.read, tool, agent="evidence", case_id=case["id"], **args)
            except GatewayError as e:
                ev["errors"].append(f"{tool}: {e}")

        jobs = [read("profile", "crm.profile", customer_id=cid)]
        if tid:
            jobs += [read("upi", "upi.status", txn_id=tid), read("debit", "bank.debit_status", txn_id=tid),
                     read("refund", "refund.status", txn_id=tid)]
        await asyncio.gather(*jobs)
        hits = self.memory.search(case["text"], u["intent"], exclude=case["id"])
        ev["memory"] = hits
        if tid:
            t = self.rails.txn(tid)
            case["txn"] = {"id": tid, "amount": t["amount"], "merchant": t["merchant"] if "@" not in t["merchant"]
                           else self.tok.tokenise(t["merchant"])[0], "utr": t["utr"], "created_at": t["created_at"]}
            ev["novelty"] = 0.0 if self.graph.merchant_seen_before(cid, t["merchant"], tid) else 1.0
        else:
            case["txn"] = None
            ev["novelty"] = 0.0
        self.graph.link_case(case["id"], u["intent"], tid, cid)
        case["evidence"] = ev
        read = [n["id"] for n in self.graph.neighbors(f"case:{case['id']}")["nodes"] if n["id"] != f"case:{case['id']}"]
        read += [f"case:{h['case_id']}" if h["case_id"].startswith("NR-") else f"memory:{h['case_id']}" for h in hits[:3]]
        self.bus.publish("brain.read", case_id=case["id"], agent="evidence", nodes=read)
        rec["note"] = (f"matched {tid} ({', '.join(match['why'])})" if tid else "no transaction matched") + \
                      f" · {len(hits)} similar case(s)" + (f" · {len(ev['errors'])} read error(s)" if ev["errors"] else "")

    async def _s_plan(self, case: dict, rec: dict):
        ev = case["evidence"]
        p = specialists.plan(self.policy, self.rails, case["intent"], case["customer_id"], case["match"], ev)
        if ev["errors"]:
            for a in p["actions"]:
                a["evidence_agree"] = min(a["evidence_agree"], 0.5)
        if case["txn"] and "@" in case["txn"]["merchant"]:
            p["facts"] = [f.replace(self.rails.txn(case["txn"]["id"])["merchant"], case["txn"]["merchant"])
                          for f in p["facts"]]
        case["plan"] = p
        rec["note"] = ", ".join(a["type"] + (f" ₹{a['amount']:,.0f}" if a["amount"] else "") for a in p["actions"])
        self.trail.append(case["id"], "plan.proposed", p["specialist"],
                          {"actions": [{"type": a["type"], "amount": a["amount"]} for a in p["actions"]]})

    def _features(self, case: dict, a: dict) -> dict:
        u, ev = case["understanding"], case["evidence"]
        needs_txn = case["intent"] not in ("kyc", "balance", "block_request")
        mconf = case["match"]["confidence"] if needs_txn and case["match"]["txn_id"] else 1.0
        prof = ev.get("profile", {})
        return {"intent_conf": round(u["confidence"] * (0.6 + 0.4 * mconf), 4), "evidence_agree": a["evidence_agree"],
                "log_amount": round(log_amount(a["amount"]), 4),
                "prior_disputes": round(min(1.0, prof.get("prior_disputes", 0) / 5), 3),
                "memory_support": self.memory.support(ev.get("memory", []), a["type"]),
                "sentry_risk": case["sentry"]["risk"], "novelty": ev.get("novelty", 0.0),
                "voice": 1.0 if case["channel"] == "voice" else 0.0}

    def _route_one(self, case: dict, a: dict, score: float, th: dict) -> tuple[str, str]:
        at = self.policy.actions[a["type"]]
        rung = min(at.rung, self.drift_status["rung_cap"])
        inf = float("inf")
        lam_act = th["act"]["lambda"] if th["act"]["lambda"] is not None else inf
        lam_hedge = th["hedge"]["lambda"] if th["hedge"]["lambda"] is not None else inf
        if case["sentry"]["verdict"] == "adjudicate" and a["type"] not in INFO:
            return "ESCALATE", "Sentry asked for a human on this case"
        if rung == 0:
            return "ESCALATE", f"{at.label} is in suggest-only mode (autonomy rung 0)"
        if score >= lam_act and rung >= 2:
            return "ACT", f"score {score:.4f} ≥ certified threshold {lam_act:.4f} (α {th['alpha']:.2%}, {th['band']})"
        hedge_ok = at.reversible and (not at.moves_money or a["amount"] <= at.hedge_cap)
        if hedge_ok and score >= lam_hedge and rung >= 1:
            return "HEDGE", f"score {score:.4f} ≥ hedge threshold {lam_hedge:.4f}; reversible, so it runs with an undo"
        if lam_act == inf:
            n, need = th["act"].get("n", 0), th["act"].get("n_needed", 0)
            why = (f"needs {need}+ labelled cases in this band, has {n}" if n < need
                   else f"the error rate stays above α {th['alpha']:.2%} at every threshold")
            return "ESCALATE", f"{at.label} cannot be certified to run alone in the {th['band']} band ({why})"
        return "ESCALATE", f"score {score:.4f} < certified threshold {lam_act:.4f} (α {th['alpha']:.2%})"

    async def _s_calibrate(self, case: dict, rec: dict):
        scores = []
        for a in case["plan"]["actions"]:
            f = self._features(case, a)
            s = self.calibrator.score(f, a["type"])
            th = self.risk.thresholds(a["type"], a["amount"])
            self.drift.observe(s["calibrated"], a["type"])
            route, why = self._route_one(case, a, s["calibrated"], th)
            scores.append({"action": a["type"], "features": f, **s, "threshold": th, "route": route, "why": why})
        case["scores"] = scores
        rec["note"] = " · ".join(f"{x['action']} {x['calibrated']:.3f} (stated {x['stated']:.2f})" for x in scores)

    async def _s_shadow(self, case: dict, rec: dict):
        tid = case["plan"]["txn_id"]
        writes = [a for a in case["plan"]["actions"] if a["type"] not in INFO]
        if not tid or not writes:
            case["shadow"], case["recheck"] = None, {"ok": True, "baseline": "n/a", "result": "n/a", "tries": []}
            rec["note"] = "nothing to dry-run"
            return None
        case["shadow"] = shadow_execute(self.rails, tid, writes)
        case["recheck"] = do_recheck(self.rails, tid, case["shadow"], self.policy.shadow_retries)
        rec["note"] = f"{len(case['shadow']['diff'])} change(s) on the shadow ledger · recheck " + \
                      ("ok" if case["recheck"]["ok"] else "FAILED")
        if not case["recheck"]["ok"]:
            return "replan"
        return None

    async def _s_route(self, case: dict, rec: dict):
        if case.get("route") == "REFUSE":
            case["decisions"] = []
            rec["note"] = "REFUSE"
            return
        decisions = []
        for a, s in zip(case["plan"]["actions"], case["scores"]):
            route, why = s["route"], s["why"]
            if not case["recheck"]["ok"]:
                route, why = "ESCALATE", "the live systems kept changing during recheck"
            decisions.append({"action": a, "route": route, "why": why, "score": s["calibrated"], "committed": False})
        case["decisions"] = decisions
        case["route"] = max((d["route"] for d in decisions), key=lambda r: ORDER[r]) if decisions else "ACT"
        rec["note"] = " · ".join(f"{d['action']['type']} → {d['route']}" for d in decisions)
        for d in decisions:
            self.trail.append(case["id"], "decision.routed", "router",
                              {"action": d["action"]["type"], "amount": d["action"]["amount"], "route": d["route"],
                               "score": d["score"], "why": d["why"]})
        self.bus.publish("decision.routed", case_id=case["id"], route=case["route"],
                         decisions=[{"action": d["action"]["type"], "route": d["route"]} for d in decisions])

    def _payload(self, case: dict, ds: list[dict]) -> list[dict]:
        keep = ("type", "amount", "txn_id", "dispute_kind", "instrument")
        return [{k: d["action"].get(k) for k in keep if d["action"].get(k) is not None} for d in ds]

    async def _s_commit(self, case: dict, rec: dict):
        tid = case["plan"]["txn_id"]
        auto = [d for d in case["decisions"] if d["route"] in ("ACT", "HEDGE") and d["action"]["type"] not in INFO]
        for d in case["decisions"]:
            if d["route"] in ("ACT", "HEDGE") and d["action"]["type"] in INFO:
                d["committed"] = True
        notes = []
        if auto:
            payload = self._payload(case, auto)
            recheck = case["recheck"]
            if tid:
                s = self.gateway.seal_for(payload, recheck, tid)
                res = self.gateway.execute_sealed(case_id=case["id"], customer_id=case["customer_id"], txn_id=tid,
                                                  actions=payload, seal=s, recheck=recheck)
            else:  # a block with no transaction: an idempotent, reversible, non-money action
                res = {"ok": True, "receipts": [self.gateway._run_action(case["id"], case["customer_id"], None, p,
                                                                          f"{case['id']}:{p['type']}:0", "commit")
                                                for p in payload]}
            for d, r in zip(auto, res.get("receipts", [])):
                d["committed"], d["receipt"] = r.get("ok", False), r
            case["commits"].append({"at": time.time(), "by": "autonomous", "result": res})
            self.trail.append(case["id"], "commit.autonomous", "commit",
                              {"ok": res["ok"], "actions": [p["type"] for p in payload], "reason": res.get("reason")})
            notes.append(f"{sum(d['committed'] for d in auto)}/{len(auto)} autonomous action(s) committed")
            if not res["ok"]:
                for d in auto:
                    if not d["committed"]:
                        d["route"], d["why"] = "ESCALATE", f"commit refused: {res.get('reason') or 'tool error'}"
        escalated = [d for d in case["decisions"] if d["route"] == "ESCALATE" and d["action"]["type"] not in INFO]
        if escalated and tid:
            self._agent("seal", case, "sealing for approval")
            writes = [d["action"] for d in escalated]
            shadow = shadow_execute(self.rails, tid, writes)
            rc = do_recheck(self.rails, tid, shadow, self.policy.shadow_retries)
            payload = self._payload(case, escalated)
            s = self.gateway.seal_for(payload, rc, tid)
            case["pending"] = {"actions": payload, "seal": s, "recheck": rc, "shadow": shadow,
                               "ledger_version": self.rails.version_of(tid), "policy_hash": self.policy.policy_hash(),
                               "requested_at": time.time()}
            self.trail.append(case["id"], "approval.requested", "seal", {"seal": s, "actions": payload})
            self.bus.publish("approval.requested", case_id=case["id"], seal=s[:16],
                             actions=[p["type"] for p in payload])
            self.roster.waiting("human", case["id"], "approval needed")
            self.bus.publish("agent.status", agent="human", status="waiting", case_id=case["id"],
                             doing="approval needed", department="oversight")
            notes.append(f"sealed {len(payload)} action(s) · seal {s[:12]}…")
            await self._pause(0.6)
            self._idle("seal")
        elif escalated:
            case["pending"] = {"actions": self._payload(case, escalated), "seal": None, "recheck": None,
                               "shadow": None, "requested_at": time.time(), "ledger_version": None,
                               "policy_hash": self.policy.policy_hash()}
        rec["note"] = " · ".join(notes) or "nothing to commit"

    async def _s_respond(self, case: dict, rec: dict):
        facts = (case.get("plan") or {}).get("facts", [])
        text = replies.compose(case)
        committed = any(d.get("committed") and d["action"]["type"] not in INFO for d in case.get("decisions", []))
        lang = case.get("understanding", {}).get("entities", {}).get("language", "en")
        draft_check = None
        if self.llm.enabled and case.get("route") != "REFUSE":
            draft = await asyncio.to_thread(self.llm.draft_reply, facts, text, lang)
            if draft:
                draft_check = promise_guard.check(draft, facts, committed)
                if draft_check["ok"]:
                    text = draft
        g = promise_guard.check(text, facts, committed)
        case["guard"] = {**g, "llm_draft": draft_check}
        try:
            self.gateway.send(case["id"], case["customer_id"], text)
        except GatewayError as e:
            rec["note"] = f"send failed: {e}"
        case["conversation"].append({"role": "nirnaya", "text": text, "ts": time.time()})
        if case.get("first_reply_s") is None:
            case["first_reply_s"] = round(time.time() - case["created_at"], 2)
        rec["note"] = rec["note"] or (f"reply checked: {g['claims_checked']} claim(s), "
                                      f"{len(g['violations'])} violation(s)")
        self.trail.append(case["id"], "reply.sent", "responder", {"guard_ok": g["ok"], "chars": len(text)})

    async def _s_learn(self, case: dict, rec: dict):
        prev_alarm = self.drift_status["alarm"]
        self.drift_status = self.drift.check()
        if self.drift_status["alarm"] != prev_alarm:
            self.refit_thresholds()
            self.trail.append("-", "drift.alarm", "drift", self.drift_status)
            self.bus.publish("drift.alarm", status=self.drift_status)
        if not case.get("pending"):
            self._remember(case, "auto" if any(d["route"] in ("ACT", "HEDGE") for d in case.get("decisions", []))
                           else "accepted")
        rec["note"] = f"trail head {self.trail.verify()['head'][:12]}… · drift PSI {self.drift_status['psi']:.2f}"

    def _remember(self, case: dict, state: str) -> None:
        if not case.get("decisions"):
            return
        main = max(case["decisions"], key=lambda d: (d["action"]["type"] not in INFO, d["action"]["amount"]))
        tid = (case.get("txn") or {}).get("id")
        self.memory.add(case["id"], case.get("text", ""), case.get("intent") or "other", main["action"]["type"],
                        case["status"], state, case.get("understanding", {}).get("entities", {}),
                        {tid: self.rails.version_of(tid)} if tid else {})

    # ── human decisions ──────────────────────────────────────────────────────
    def _label(self, case: dict, decisions: list[dict], correct: bool, source: str) -> None:
        by_type = {s["action"]: s for s in case.get("scores", [])}
        for d in decisions:
            s = by_type.get(d["action"]["type"])
            if s:
                self.store.add_label(case["id"], d["action"]["type"], d["action"]["amount"], s["features"], correct,
                                     source)
                case["labels"].append({"action": d["action"]["type"], "correct": correct, "source": source})

    async def approve(self, case_id: str, by: str = "support lead", note: str = "",
                      edits: dict[str, float] | None = None) -> dict:
        async with self._lock(case_id):
            return await self._approve(case_id, by, note, edits)

    async def _approve(self, case_id: str, by: str = "support lead", note: str = "",
                      edits: dict[str, float] | None = None) -> dict:
        case = self.store.get_case(case_id)
        if not case or not case.get("pending"):
            raise ValueError("nothing is waiting for approval on this case")
        cp = self.store.latest_checkpoint(case_id)
        pend = case["pending"]
        tid = case["plan"]["txn_id"]
        if cp["graph_hash"] != GRAPH_HASH or pend["policy_hash"] != self.policy.policy_hash():
            return await self._reseal(case, "the policy changed after this was sealed; re-validated")
        payload = copy.deepcopy(pend["actions"])
        edited = False
        if edits:
            for p in payload:
                if p["type"] in edits and float(edits[p["type"]]) != p.get("amount"):
                    p["amount"], edited = round(float(edits[p["type"]]), 2), True
        seal, recheck = pend["seal"], pend["recheck"]
        if edited:  # an edit is a new decision: re-run the shadow and seal the edited version as approved now
            shadow = shadow_execute(self.rails, tid, payload)
            recheck = do_recheck(self.rails, tid, shadow)
            seal = self.gateway.seal_for(payload, recheck, tid)
        self._agent("human", case, "approving")
        self._agent("seal", case, "verifying seal")
        if tid:
            res = self.gateway.execute_sealed(case_id=case_id, customer_id=case["customer_id"], txn_id=tid,
                                              actions=payload, seal=seal, recheck=recheck, agent="commit")
        else:  # no transaction to seal against: only non-money, idempotent actions reach here
            res = {"ok": True, "reason": None, "seal": None,
                   "receipts": [self.gateway._run_action(case_id, case["customer_id"], None, p,
                                                         f"{case_id}:{p['type']}:{i}", "commit")
                                for i, p in enumerate(payload)]}
        self._idle("seal", "human")
        if not res["ok"] and res["reason"] == "seal_mismatch":
            self.trail.append(case_id, "seal.broken", "seal", {"expected": res["seal"]["expected"],
                                                               "actual": res["seal"]["actual"]})
            return await self._reseal(case, "the ledger moved after the approval was requested; the old approval "
                                            "does not apply")
        esc = [d for d in case["decisions"] if d["route"] == "ESCALATE" and d["action"]["type"] not in INFO]
        for d, r, p in zip(esc, res["receipts"], payload):
            d["committed"], d["receipt"], d["approved_by"] = r.get("ok", False), r, by
            d["action"]["amount"] = p.get("amount", d["action"]["amount"])
        case["commits"].append({"at": time.time(), "by": by, "note": note, "result": res, "edited": edited})
        self._label(case, esc, correct=not edited, source="approval")
        self.trail.append(case_id, "approval.granted", by or "human", {"by": by, "edited": edited, "note": note,
                                                                 "ok": res["ok"], "seal": seal})
        case["pending"] = None
        case["route_final"] = "APPROVED"
        self.roster.idle("human")
        for d in case["decisions"]:
            if d["route"] == "ESCALATE" and d.get("committed"):
                d["route"] = "ACT"
        text = replies.compose(case)
        facts = case["plan"]["facts"] + [f"{replies.rs(p['amount'])} approved" for p in payload if p.get("amount")]
        case["guard"] = promise_guard.check(text, facts, True)
        self.gateway.send(case_id, case["customer_id"], text)
        case["conversation"].append({"role": "nirnaya", "text": text, "ts": time.time()})
        case["status"], case["step"] = "resolved", "done"
        self._checkpoint(case, "learn", "done")
        self._remember(case, "accepted" if not edited else "rejected")
        self._save(case)
        self.bus.publish("approval.granted", case_id=case_id, by=by, edited=edited, note=note)
        return case

    async def _reseal(self, case: dict, why: str) -> dict:
        case["seal_broken"] = {"at": time.time(), "why": why, "old_seal": case["pending"]["seal"]}
        case["pending"] = None
        case["decisions"] = []
        self._save(case)
        self.bus.publish("seal.rejected_approval", case_id=case["id"], why=why)
        self.trail.append(case["id"], "case.revalidated", "recheck", {"why": why})
        broken = case["seal_broken"]
        cp_state = copy.deepcopy(case)
        cp_state["status"] = "running"
        self.store.save_case(cp_state)
        out = await self._run(case["id"], from_step="evidence")
        out["seal_broken"] = broken
        self._save(out)
        return out

    async def reject(self, case_id: str, by: str = "support lead", note: str = "") -> dict:
        async with self._lock(case_id):
            return await self._reject(case_id, by, note)

    async def _reject(self, case_id: str, by: str = "support lead", note: str = "") -> dict:
        case = self.store.get_case(case_id)
        if not case or not case.get("pending"):
            raise ValueError("nothing is waiting for approval on this case")
        esc = [d for d in case["decisions"] if d["route"] == "ESCALATE" and d["action"]["type"] not in INFO]
        self._label(case, esc, correct=False, source="rejection")
        for d in esc:
            d["route"], d["rejected_by"] = "REJECTED", by
        self.trail.append(case_id, "approval.rejected", by or "human", {"by": by, "note": note})
        case["pending"] = None
        text = ("After reviewing your case, we can't complete this step automatically. A specialist from our team "
                "will contact you on this channel with the next steps.")
        case["conversation"].append({"role": "nirnaya", "text": text, "ts": time.time()})
        self.gateway.send(case_id, case["customer_id"], text)
        case["status"], case["step"] = "resolved", "done"
        self.roster.idle("human")
        self._checkpoint(case, "learn", "done")
        self._remember(case, "rejected")
        self._save(case)
        self.bus.publish("approval.rejected", case_id=case_id, by=by, note=note)
        return case

    async def undo(self, case_id: str, by: str = "customer") -> dict:
        async with self._lock(case_id):
            return await self._undo(case_id, by)

    async def _undo(self, case_id: str, by: str = "customer") -> dict:
        case = self.store.get_case(case_id)
        if not case:
            raise KeyError(case_id)
        undone = []
        for d in case.get("decisions", []):
            r = d.get("receipt") or {}
            if d["route"] == "HEDGE" and d.get("committed") and r.get("undo") and not d.get("undone"):
                self.gateway.undo(r["undo"], case_id=case_id)
                d["undone"] = True
                undone.append(d)
        if not undone:
            raise ValueError("nothing on this case can be undone")
        self._label(case, undone, correct=False, source="undo")
        for _ in undone:
            self.drift.audit(False)
        self.trail.append(case_id, "action.undone", by, {"actions": [d["action"]["type"] for d in undone]})
        text = "Done: I've reversed that step as you asked. A specialist will look at your case."
        case["conversation"].append({"role": "nirnaya", "text": text, "ts": time.time()})
        self.gateway.send(case_id, case["customer_id"], text)
        self.memory.set_state(case_id, "rejected")
        self._save(case)
        self.bus.publish("action.undone", case_id=case_id, by=by)
        return case

    def audit(self, case_id: str, correct: bool, by: str = "supervisor") -> dict:
        case = self.store.get_case(case_id)
        auto = [d for d in case.get("decisions", []) if d["route"] in ("ACT", "HEDGE")]
        self._label(case, auto, correct=correct, source="audit")
        for _ in auto:
            self.drift.audit(correct)
        self.memory.set_state(case_id, "accepted" if correct else "rejected")
        self.trail.append(case_id, "audit", by, {"correct": correct})
        self._save(case)
        return case

    # ── durability ───────────────────────────────────────────────────────────
    async def recover(self) -> list[str]:
        """Resume every case that was mid-run when the process stopped. Parked cases stay parked."""
        resumed = []
        for c in self.store.list_cases(1000):
            if c["status"] == "running":
                cp = self.store.latest_checkpoint(c["id"])
                if cp and cp["graph_hash"] != GRAPH_HASH:
                    continue
                resumed.append(c["id"])
                self.start(c["id"])
        if resumed:
            self.trail.append("-", "continuum.resumed", "commit", {"cases": resumed})
        return resumed

    def stats(self) -> dict:
        cases = self.store.list_cases(1000)
        done = [c for c in cases if c["status"] in ("resolved", "refused", "parked")]
        by_route: dict[str, int] = {}
        for c in done:
            by_route[c.get("route") or "—"] = by_route.get(c.get("route") or "—", 0) + 1
        auto = sum(1 for c in done if c.get("route") in ("ACT", "HEDGE") and c["status"] == "resolved"
                   and not any(x.get("by") not in (None, "autonomous") for x in c.get("commits", [])))
        human = len(done) - auto
        replies_s = [c["first_reply_s"] for c in done if c.get("first_reply_s") is not None]
        cost = auto * COST["auto"] + human * COST["human"]
        return {"cases": len(cases), "done": len(done), "by_route": by_route,
                "autonomy": round(auto / len(done), 3) if done else 0.0,
                "pending_approvals": sum(1 for c in cases if c.get("pending")),
                "avg_first_reply_s": round(sum(replies_s) / len(replies_s), 2) if replies_s else None,
                "cost_per_case": round(cost / len(done), 2) if done else None,
                "human_only_cost_per_case": COST["human"], "labels": len(self.store.labels()),
                "memory": self.memory.stats()}
