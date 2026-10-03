"""The office: what the 3D office page needs beyond /api/state, and the endpoints its bar, panel and chat use.

- GET  /api/office                    departments, connectors, per-department numbers, ops, routines
- GET  /api/office/interpret          what the bar will do with a sentence (the hint under the box)
- POST /api/office/tasks              a sentence to a department: a case, an op, a routine, or one booked for later
- POST /api/office/ops/{id}/approve|reject, DELETE /api/office/ops/{id}
- POST /api/office/routines, /routines/{id}/run|pause|resume, DELETE; GET /api/office/occurrences
- GET  /api/office/brain              the context graph and case memory, for the Brain
- POST /api/office/chat               talk to one agent; GET /api/office/chats the shared chat, every agent
"""
from __future__ import annotations

import asyncio
import datetime as dt
import re
import time
from typing import Callable

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import ops as ops_mod
from . import outreach, schedule, scope
from .agents import DEPARTMENTS
from .ops import KINDS, Ops
from .team import Team, clean_name

# The connected systems, as the top bar shows them: which departments each one feeds.
CONNECTORS = [
    {"key": "upi", "name": "UPI switch", "depts": ["verification", "resolution"]},
    {"key": "bank", "name": "Core banking", "depts": ["verification", "commit"]},
    {"key": "refunds", "name": "Refund engine", "depts": ["verification", "resolution"]},
    {"key": "crm", "name": "CRM", "depts": ["intake", "verification"]},
    {"key": "wallet", "name": "Wallet ledger", "depts": ["commit"]},
    {"key": "disputes", "name": "Dispute desk", "depts": ["commit", "resolution"]},
    {"key": "controls", "name": "Card & UPI control", "depts": ["commit", "resolution"]},
    {"key": "messaging", "name": "Messaging", "depts": ["commit"]},
]
GROUPS = {"customer": "Customers", "account": "Accounts", "vpa": "UPI IDs", "txn": "Transactions",
          "merchant": "Merchants", "case": "Cases", "policy": "Policies", "memory": "Past cases"}
POLICY_OF = {"failed_debit": "failed_upi", "refund_status": "refund", "wrong_beneficiary": "dispute",
             "unauthorized": "unauthorized", "duplicate_charge": "refund"}


class OfficeTask(BaseModel):
    dept: str
    text: str = Field(min_length=1, max_length=4000)
    customer_id: str | None = None
    channel: str = "chat"
    at: float | None = None          # when to run it: unix seconds or ms; omit for now
    when: dict | None = None         # the REPEAT picker's schedule, if used
    needs_ok: bool | None = None
    by: str | None = None            # who typed it (the team sees it on the card)


class RoutineIn(BaseModel):
    dept: str
    text: str = Field(min_length=1, max_length=1000)
    when: dict | None = None
    needs_ok: bool | None = None
    by: str | None = None


class NoteIn(BaseModel):
    note: str = ""
    by: str | None = None


class ChatIn(BaseModel):
    agent: str
    text: str = Field(min_length=1, max_length=1000)
    by: str | None = None


def _midnight(now: float | None = None) -> float:
    d = dt.datetime.fromtimestamp(now or time.time())
    return d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def _seconds(at: float) -> float:
    return at / 1000 if at > 1e12 else at


def connectors(e) -> list[dict]:
    tools = e.gateway.describe()
    down = set(e.rails.state.get("down", []))
    out = []
    extra = [{"key": "razorpay", "name": "Razorpay (test)", "depts": ["verification", "commit"]}] if e.pg.ready() else []
    for c in CONNECTORS + extra:
        mine = [t for t in tools if t["system"] == c["name"]]
        breaker = "open" if any(t["breaker"] == "open" for t in mine) else \
            ("warning" if any(t["breaker"] == "warning" for t in mine) else "closed")
        status = "down" if c["name"] in down else ("open" if breaker == "open" else "connected")
        out.append({**c, "status": status, "breaker": breaker, "calls": sum(t["calls"] for t in mine),
                    "tools": [t["name"] for t in mine], "moves_money": any(t["moves_money"] for t in mine)})
    return out


def kpis(e) -> dict[str, list[list]]:
    cases = e.store.list_cases(1000)
    today = _midnight()
    tools = {t["name"]: t for t in e.gateway.describe()}
    reads = sum(t["calls"] for t in tools.values() if t["kind"] == "read")
    money = sum(t["calls"] for n, t in tools.items() if t["moves_money"])
    sent = tools.get("notify.send", {}).get("calls", 0)
    alone = sum(1 for c in cases if c["status"] == "resolved" and c.get("route") in ("ACT", "HEDGE")
                and not any(x.get("by") not in (None, "autonomous") for x in c.get("commits", [])))
    escalated = sum(1 for c in cases if any(d.get("route") in ("ESCALATE", "REJECTED") or d.get("approved_by")
                                            for d in c.get("decisions", [])) or c.get("pending"))
    blocked = sum(1 for c in cases if (c.get("sentry") or {}).get("verdict") == "block" or c.get("route") == "REFUSE")
    certified = sum(1 for a in e.policy.actions if (e.risk.thresholds(a, 500).get("act") or {}).get("lambda") is not None)
    trail_n = e.store.query("SELECT COUNT(*) AS n FROM trail")[0]["n"]
    nodes = e.store.query("SELECT COUNT(*) AS n FROM graph_nodes")[0]["n"] + \
        e.store.query("SELECT COUNT(*) AS n FROM memory WHERE case_id NOT LIKE 'NR-%'")[0]["n"]
    return {
        "intake": [["SCREENED TODAY", sum(1 for c in cases if c["created_at"] >= today)], ["BLOCKED OR REFUSED", blocked]],
        "resolution": [["RESOLVED ALONE", alone], ["SENT FOR APPROVAL", escalated]],
        "verification": [["EVIDENCE READS", reads], ["DRY RUNS", sum(1 for c in cases if c.get("shadow"))]],
        "decision": [["CERTIFIED ACTIONS", f"{certified} / {len(e.policy.actions)}"],
                     ["CALIBRATION ERROR", f"{e.calibrator.metrics['ece_calibrated']:.3f}"]],
        "commit": [["MONEY MOVES", money], ["REPLIES SENT", sent]],
        "oversight": [["WAITING ON YOU", sum(1 for c in cases if c.get("pending"))], ["TRAIL ENTRIES", trail_n]],
        "brain": [["NODES", nodes]],
    }


def brain(e) -> dict:
    nodes = [{"id": n["id"], "label": n["label"], "group": GROUPS.get(n["kind"], n["kind"]), "kind": n["kind"],
              "props": n["props"]} for n in e.graph.nodes()]
    edges = [(x["src"], x["dst"], x["kind"]) for x in e.graph.edges()]
    mem = {r["case_id"]: dict(r) for r in e.store.query("SELECT case_id, intent, action, state FROM memory")}
    have = {n["id"] for n in nodes}
    for cid, m in mem.items():
        if cid.startswith("NR-"):
            for n in nodes:
                if n["id"] == f"case:{cid}":
                    n["props"] = {**n["props"], "memory": m["state"], "action": m["action"]}
            continue
        nid = f"memory:{cid}"
        nodes.append({"id": nid, "label": cid, "group": GROUPS["memory"], "kind": "memory",
                      "props": {"intent": m["intent"], "action": m["action"], "state": m["state"]}})
        have.add(nid)
        pol = POLICY_OF.get(m["intent"])
        if pol and f"policy:{pol}" in have:
            edges.append((nid, f"policy:{pol}", "precedent"))
    idx = {n["id"]: i for i, n in enumerate(nodes)}
    links = [[idx[a], idx[b], k] for a, b, k in edges if a in idx and b in idx]
    return {"nodes": nodes, "links": links, "groups": list(GROUPS.values())}


def _agent_name(e, aid: str) -> str:
    a = e.roster.agents.get(aid)
    return a["name"] if a else aid


async def answer(e, agent_id: str, question: str, *, checked: bool = False) -> dict:
    """An agent answers in its role, grounded in what it actually did (a free language model when one is set up,
    rules otherwise), and only about banking, payments and its own work."""
    a = e.roster.agents[agent_id]
    if not checked:
        sc = await asyncio.to_thread(scope.check, question, scope.STAFF, e.llm if e.llm.enabled else None)
        if not sc["in_scope"]:
            return {"agent": agent_id, "answer": scope.refusal(scope.STAFF, sc["category"]), "grounded_in": 0,
                    "llm": e.llm.enabled, "via": "finance-only guard", "refused": sc["category"]}
    recent = [ev for ev in e.bus.recent(400) if ev.get("agent") == agent_id or agent_id in (ev.get("agents") or [])][-25:]
    lines = [f"{time.strftime('%H:%M:%S', time.localtime(ev['ts']))} {ev['kind']} "
             f"{ev.get('case_id') or ''} {ev.get('doing') or ev.get('step') or ev.get('tool') or ''}" for ev in recent]
    reply, info = None, {}
    if e.llm.enabled:
        reply = await asyncio.to_thread(e.llm.ask_agent, a["persona"], "\n".join(lines) or "(no activity)", question, info)
    via = f"{info['label']} · {info['model']}" if reply and info else None
    if reply == scope.OFF:                     # the model kept to finance and said no, or wrote code: refused
        return {"agent": agent_id, "answer": scope.refusal(scope.STAFF), "grounded_in": len(lines),
                "llm": e.llm.enabled, "via": "finance-only guard", "refused": "model"}
    if not reply:
        q = question.lower()
        last = a["log"][-4:]
        doing = f"Right now: {a['doing']} on {a['case_id']}." if a["status"] == "working" and a["case_id"] else \
            (f"I'm waiting for your OK on {a['case_id']}." if a["status"] == "waiting" else "Nothing on my desk right now.")
        if re.search(r"\b(system|tool|connect|use)\b", q):
            reply = (f"I work with {', '.join(a['systems'])}. I read freely; anything that moves money goes through "
                     "the Tool Gateway, sealed, exactly once.") if a["systems"] else \
                "I don't call the bank's systems myself; I work on what the other desks bring me."
        elif re.search(r"\b(can you|what do you|help|job|role)\b", q):
            reply = a["description"]
            if a.get("lead"):
                reply += " Give my department a task in the bar: I can " + "; ".join(ops_mod.can_do(a["department"])) + "."
        elif re.search(r"\b(waiting|approve|approval|on me)\b", q):
            waiting = [c["id"] for c in e.store.list_cases(500) if c.get("pending")]
            reply = (f"{len(waiting)} waiting on you: {', '.join(waiting[:6])}. Each one is sealed; approve it and "
                     "the gateway checks the seal against the live ledger first.") if waiting else "Nothing is waiting on you."
        else:
            done = "; ".join(f"{x['case_id']} ({x['doing']})" for x in last)
            reply = f"I'm {a['name']}. {doing} " + (f"Recently: {done}. " if done else "") + f"I've handled {a['handled']} step(s) since the office opened."
    return {"agent": agent_id, "answer": reply, "grounded_in": len(lines), "llm": e.llm.enabled, "via": via}


def register(app: FastAPI, E: Callable, R: Callable, O: Callable[[], Ops], T: Callable[[], Team],
             F: Callable | None = None) -> None:
    """E: the engine, R: the routines, O: the ops, T: the team, F: the flows (behind getters: a restart swaps the engine)."""

    def dept_ok(d: str) -> None:
        if d not in {x["id"] for x in DEPARTMENTS}:
            raise HTTPException(400, f"unknown department {d}")

    @app.get("/api/office")
    def office():
        e = E()
        return {"pods": DEPARTMENTS, "connectors": connectors(e), "kpis": kpis(e), "ops": O().all()[-150:],
                "routines": R().public(), "kinds": {k: {"dept": v["dept"], "agent": v["agent"], "title": v["title"],
                                                        "routine": v["routine"], "help": v["help"]} for k, v in KINDS.items()},
                "llm": e.llm.summary(), "now": time.time(), "flow_waits": F().waiting() if F else []}

    @app.get("/api/office/interpret")
    def interpret(dept: str, text: str = ""):
        dept_ok(dept)
        return ops_mod.interpret(dept, text, ctx=O().ctx())

    @app.post("/api/office/tasks")
    async def add_task(body: OfficeTask):
        dept_ok(body.dept)
        e = E()
        by = clean_name(body.by, "you")
        due = _seconds(body.at) if body.at else None
        if due and due < time.time() - 60:
            raise HTTPException(400, "that time has passed; pick one that is still ahead")
        it = ops_mod.interpret(body.dept, body.text, when=body.when, ctx=O().ctx())
        if it.get("problem") and it["kind"] in ("routine", "off_topic", "outreach"):
            raise HTTPException(400, it["problem"])
        if it["kind"] == "outreach":            # pay, ask for money, message or call someone
            try:
                op = await outreach.create(O().ctx(), body.text, by=by, due_at=due)
            except ValueError as ex:
                raise HTTPException(400, str(ex))
            return {"kind": "op", "op": op}
        if it["kind"] == "routine":
            r = R().add(it["op_kind"], it["when"], text=it["text"], title=it["title"], needs_ok=body.needs_ok, by=by)
            return {"kind": "routine", "routine": r, "guessed": it.get("guessed")}
        if it["kind"] == "case":
            cust = body.customer_id or e.rails.customers()[0]["id"]
            if not e.rails.customer(cust):
                raise HTTPException(400, f"unknown customer {cust}")
            if due:
                op = O().create("case", dept=it["dept"], agent=it["agent"], title=body.text[:90], text=body.text,
                                due_at=due, customer_id=cust, channel=body.channel, needs_ok=False, by=by)
                return {"kind": "op", "op": op}
            c = e.create_case(cust, body.text, body.channel, by=None if by == "you" else by)
            e.start(c["id"])
            return {"kind": "case", "case": e.summary(c)}
        op = O().create(it["op_kind"], dept=it["dept"], agent=it["agent"], title=it["title"], text=body.text,
                        due_at=due, needs_ok=body.needs_ok, by=by)
        return {"kind": "op", "op": op}

    @app.post("/api/office/ops/{op_id}/approve")
    async def approve_op(op_id: str, body: NoteIn | None = None):
        by = clean_name(body.by if body else None, "you")
        try:
            op = O().approve(op_id, by=by)
        except ValueError as ex:
            raise HTTPException(409, str(ex))
        T().post(op["agent"], "work", f"{'You' if by == 'you' else by} approved “{op['title']}”. Running it now; "
                 "the result lands here.", icon="✅", ref=op_id, by=by)
        return op

    @app.post("/api/office/ops/{op_id}/reject")
    async def reject_op(op_id: str, body: NoteIn):
        by = clean_name(body.by, "you")
        try:
            op = O().reject(op_id, body.note, by=by)
        except ValueError as ex:
            raise HTTPException(409, str(ex))
        T().post(op["agent"], "work", f"{'You' if by == 'you' else by} said no to “{op['title']}”"
                 + (f": “{body.note}”" if body.note else "") + ". It won't run.", icon="❌", ref=op_id, by=by)
        return op

    @app.delete("/api/office/ops/{op_id}")
    async def cancel_op(op_id: str):
        try:
            O().cancel(op_id)
        except ValueError as ex:
            raise HTTPException(409, str(ex))
        return {"ok": True}

    @app.post("/api/office/routines")
    async def add_routine(body: RoutineIn):
        dept_ok(body.dept)
        it = ops_mod.interpret(body.dept, body.text, when=body.when)
        if it["kind"] != "routine":
            raise HTTPException(400, "No schedule in that sentence. Say when: “every weekday at 8am, …”, “Mondays 9am, …”.")
        if it.get("problem"):
            raise HTTPException(400, it["problem"])
        try:
            return {"routine": R().add(it["op_kind"], it["when"], text=it["text"], title=it["title"],
                                       needs_ok=body.needs_ok, by=clean_name(body.by, "you")),
                    "guessed": it.get("guessed")}
        except ValueError as ex:
            raise HTTPException(400, str(ex))

    @app.post("/api/office/routines/{rid}/{action}")
    async def routine_action(rid: str, action: str):
        r = R()
        if not r.get(rid):
            raise HTTPException(404, "no such routine")
        if action == "run":
            job = await r.run_job(rid, manual=True)
            return {"routine": job, "op": O().get(job["last_op"]) if job.get("last_op") else None}
        if action in ("pause", "resume"):
            return {"routine": r.set_paused(rid, action == "pause")}
        raise HTTPException(404, "run, pause or resume")

    @app.delete("/api/office/routines/{rid}")
    async def delete_routine(rid: str):
        try:
            R().remove(rid)
        except KeyError:
            raise HTTPException(404, "no such routine")
        return {"ok": True}

    @app.get("/api/office/occurrences")
    def occurrences(start: float, end: float):
        start, end = _seconds(start), _seconds(end)
        if end - start > 62 * 86400:
            raise HTTPException(400, "at most two months at a time")
        return {r["id"]: schedule.occurrences(r["when"], max(start, time.time()), end, 400)
                for r in R().jobs if not r["paused"] and r["when"]["kind"] != "minutes"}

    @app.get("/api/office/brain")
    def office_brain():
        return brain(E())

    @app.get("/api/office/chats")
    def chats():
        return T().chats()

    @app.post("/api/office/chat")
    async def chat(body: ChatIn):
        e = E()
        if body.agent not in e.roster.agents:
            raise HTTPException(404, "unknown agent")
        by = clean_name(body.by, "you")
        asked = T().post(body.agent, "user", body.text.strip(), by=by)
        out = await _chat(body, by)
        answered = T().post(body.agent, "agent", out["reply"], via=out.get("via"))
        return {**out, "asked": asked, "answered": answered}

    async def _chat(body: ChatIn, by: str) -> dict:
        e = E()
        a = e.roster.agents[body.agent]
        text, low = body.text.strip(), body.text.strip().lower()
        # pay / ask / message / call someone — and the answer to a question such a task is waiting on
        # (before the topic check: "anushka@gmail.com" on its own is an answer, not a question about money)
        got = await outreach.chat(O().ctx(), body.agent, text, by)
        if got:
            return got
        sc = await asyncio.to_thread(scope.check, text, scope.STAFF, e.llm if e.llm.enabled else None)
        if not sc["in_scope"]:                 # finance only, before any rule or model sees it
            return {"reply": scope.refusal(scope.STAFF, sc["category"]), "via": "finance-only guard",
                    "refused": sc["category"]}
        ref = re.search(r"\bNR-\d+\b", text, re.I)
        if re.search(r"\bmove the ground\b", low):
            waiting = [c for c in e.store.list_cases(500) if c.get("pending") and (c.get("plan") or {}).get("txn_id")]
            pick = next((c for c in waiting if ref and c["id"] == ref.group(0).upper()), None) or \
                next((c for c in waiting if (c.get("plan") or {}).get("specialist") == body.agent), None) or \
                (waiting[0] if waiting else None)
            if not pick:
                return {"reply": "Nothing sealed is waiting for approval, so there is no ground to move.", "moved": None}
            tid = pick["plan"]["txn_id"]
            event = e.rails.natural_event(tid)
            if not event:
                return {"reply": f"{tid} has already been reversed or refunded, so nothing more can land on it from "
                                 "outside.", "moved": None}
            snap = e.rails.outside_event(tid, event)
            e.trail.append("-", "rail.event", "outside", {"txn_id": tid, "event": event})
            e.bus.publish("rail.event", txn_id=tid, event=event, version=snap["version"])
            return {"reply": (f"Done: {event.replace('_', ' ')} landed on {tid} from outside, so its ledger moved to "
                              f"version {snap['version']}. The seal on {pick['id']} was made against the old version: "
                              "approve it now and the gateway refuses it, then the case is checked again."),
                    "moved": {"case_id": pick["id"], "txn_id": tid, "version": snap["version"]}}
        if ref and re.search(r"\b(status|where|how|what about|update)\b", low):
            c = e.store.get_case(ref.group(0).upper())
            if not c:
                return {"reply": f"I can't find {ref.group(0).upper()}."}
            last = next((m["text"] for m in reversed(c["conversation"]) if m["role"] == "nirnaya"), None)
            s = e.summary(c)
            return {"reply": f"{s['id']} · {s['status']} · route {s['route'] or '—'} · step {s['step']}."
                             + (f" Last reply to the customer: “{last}”" if last else "")}
        if re.fullmatch(r"(routines?|schedule|timetable|what(?:'s| is) scheduled)\??", low):
            mine = [r for r in R().public() if r["dept"] == a["department"]] or R().public()
            return {"reply": "On the timetable:\n" + "\n".join(
                f"• {r['title']} · {r['desc']} · {_agent_name(e, r['agent'])}{' · paused' if r['paused'] else ''}"
                for r in mine)}
        if schedule.parse(text) and (a.get("lead") or a["department"] not in ops_mod.CASE_PODS):
            it = ops_mod.interpret(a["department"], text)
            if it["kind"] == "routine":
                if it.get("problem"):
                    return {"reply": it["problem"]}
                r = R().add(it["op_kind"], it["when"], text=it["text"], title=it["title"], by=by)
                nxt = time.strftime("%a %H:%M", time.localtime(r["next_at"])) if r.get("next_at") else "—"
                return {"reply": f"Done: {r['title']}, {r['desc']}. {_agent_name(e, r['agent'])} has it"
                                 f"{', and it waits for your OK before it runs' if r['needs_ok'] else ''}. Next run {nxt}.",
                        "routine": r}
        out = await answer(e, body.agent, text, checked=True)
        return {"reply": out["answer"], "llm": out["llm"], "via": out["via"], "refused": out.get("refused")}
