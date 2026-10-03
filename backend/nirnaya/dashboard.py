"""The dashboard: what the agents accepted, rejected or left waiting for a person, which agents worked on each
case, and the tokens the language model used with what they would cost (`usage.py`).

Outcomes, for a customer case:
  waiting   sealed and parked until a person approves or rejects it
  running   still going through its steps
  rejected  refused by the agents (out of scope, Sentry) or rejected by a person
  accepted  resolved: by the agents alone, or approved by a person
and for an office task (pay / ask / message / call, a routine run, a department task): waiting for an OK,
running, rejected (a person said no) or failed, and accepted (done).
`/api/dashboard`, `/api/dashboard/item/{id}`, `/api/usage` (GET, PUT the model label and prices).
"""
from __future__ import annotations

import time
from typing import Callable

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from . import usage

PEOPLE_NOT_NAMED = (None, "", "autonomous", "you", "routine", "system")


class UsageIn(BaseModel):
    model: str | None = None
    runtime: str | None = None
    price_in: float | None = None
    price_out: float | None = None


def case_outcome(c: dict) -> tuple[str, str]:
    """(outcome, how): accepted/rejected/waiting/running and who settled it."""
    if c.get("pending"):
        return "waiting", "sealed, waiting for a person"
    if c.get("status") == "running":
        return "running", "the agents are on it"
    rejected_by = next((d.get("rejected_by") for d in c.get("decisions", []) if d.get("route") == "REJECTED"), None)
    if rejected_by is not None:
        return "rejected", "rejected by a person"
    if c.get("status") == "refused" or c.get("route") == "REFUSE":
        return "rejected", "refused by the agents"
    if any(x.get("by") not in (None, "autonomous") for x in c.get("commits", [])):
        return "accepted", "approved by a person"
    return "accepted", "resolved by the agents"


def op_outcome(o: dict) -> tuple[str, str]:
    st = o.get("state")
    if st == "waiting":
        return "waiting", "waiting for a person's OK"
    if st in ("next", "doing", "scheduled"):
        return "running", "scheduled" if st == "scheduled" else "the agents are on it"
    if o.get("rejected"):
        return "rejected", "rejected by a person"
    if o.get("ok") is False:
        return "rejected", "could not finish"
    return "accepted", "approved by a person" if o.get("approved") else "done by the agents"


def _agent(e, aid: str) -> dict:
    a = e.roster.agents.get(aid) or {}
    return {"id": aid, "name": a.get("name", aid), "emoji": a.get("emoji", ""), "department": a.get("department")}


def case_work(e, c: dict) -> tuple[list[dict], list[dict]]:
    """The steps with the agents that did each one, and the people who decided on it."""
    steps = []
    for s in c.get("supersteps", []):
        if s.get("agents"):
            steps.append({"step": s["name"], "agents": s["agents"], "started": s.get("started"),
                          "ended": s.get("ended"), "note": s.get("note") or ""})
    people = []
    if c.get("pending") or any(d.get("route") in ("REJECTED",) or d.get("approved_by") for d in c.get("decisions", [])) \
            or any(x.get("by") not in (None, "autonomous") for x in c.get("commits", [])):
        steps.append({"step": "seal", "agents": ["seal"], "started": None, "ended": None, "note": "sealed the actions for a person"})
        steps.append({"step": "approval", "agents": ["human"], "started": None, "ended": None,
                      "note": "waiting for a person" if c.get("pending") else "a person decided"})
    for x in c.get("commits", []):
        if x.get("by") not in PEOPLE_NOT_NAMED:
            people.append({"name": x["by"], "did": "approved" + (" (edited)" if x.get("edited") else "")})
    for d in c.get("decisions", []):
        if d.get("route") == "REJECTED" and d.get("rejected_by") and not any(p["name"] == d["rejected_by"] for p in people):
            people.append({"name": d["rejected_by"], "did": "rejected"})
    if c.get("opened_by") not in PEOPLE_NOT_NAMED:
        people.insert(0, {"name": c["opened_by"], "did": "opened it"})
    return steps, people


def op_work(o: dict) -> tuple[list[dict], list[dict]]:
    if o.get("steps"):
        steps = [{"step": s.get("doing") or "", "agents": [s["agent"]], "started": s.get("at"), "ended": None,
                  "note": s.get("note") or ""} for s in o["steps"]]
    else:
        steps = [{"step": o.get("title") or o.get("kind"), "agents": [o["agent"]], "started": o.get("started_at"),
                  "ended": o.get("done_at"), "note": ""}]
    people = []
    if o.get("by") not in PEOPLE_NOT_NAMED:
        people.append({"name": o["by"], "did": "asked for it"})
    if o.get("approved_by") not in PEOPLE_NOT_NAMED:
        people.append({"name": o["approved_by"], "did": "approved"})
    if o.get("rejected_by") not in PEOPLE_NOT_NAMED:
        people.append({"name": o["rejected_by"], "did": "rejected"})
    return steps, people


def _unique_agents(steps: list[dict]) -> list[str]:
    seen: list[str] = []
    for s in steps:
        for a in s["agents"]:
            if a not in seen:
                seen.append(a)
    return seen


def build(e, ops: list[dict], days: int = 14) -> dict:
    meter = e.llm.meter
    cfg = meter.settings()
    cases = e.store.list_cases(2000)
    tasks = [o for o in ops if o.get("kind") != "case"]   # a booked case shows up as its case once it runs
    now = time.time()
    day_keys = [time.strftime("%Y-%m-%d", time.localtime(now - i * 86400)) for i in range(days - 1, -1, -1)]
    per_day = {d: {"day": d, "accepted": 0, "rejected": 0, "waiting": 0, "running": 0} for d in day_keys}
    counts = {"accepted": 0, "rejected": 0, "waiting": 0, "running": 0}
    how: dict[str, int] = {}
    tcounts = {"accepted": 0, "rejected": 0, "waiting": 0, "running": 0}
    items = []
    for c in cases:
        out, why = case_outcome(c)
        counts[out] += 1
        how[why] = how.get(why, 0) + 1
        d = time.strftime("%Y-%m-%d", time.localtime(c.get("created_at") or now))
        if d in per_day:
            per_day[d][out] += 1
        steps, people = case_work(e, c)
        t = meter.of(c["id"])
        items.append({"id": c["id"], "type": "case", "title": (c.get("text") or "")[:90],
                      "who": c.get("customer_name"), "outcome": out, "how": why, "created_at": c.get("created_at"),
                      "agents": len(_unique_agents(steps)), "people": len(people), "tokens": t["total"], "cost": t["cost"]})
    for o in tasks:
        out, why = op_outcome(o)
        tcounts[out] += 1
        d = time.strftime("%Y-%m-%d", time.localtime(o.get("created_at") or now))
        if d in per_day:
            per_day[d][out] += 1
        steps, people = op_work(o)
        t = meter.of(o["id"])
        items.append({"id": o["id"], "type": "task", "title": (o.get("title") or "")[:90], "who": o.get("by"),
                      "outcome": out, "how": why, "created_at": o.get("created_at"), "agents": len(_unique_agents(steps)),
                      "people": len(people), "tokens": t["total"], "cost": t["cost"]})
    items.sort(key=lambda x: -(x["created_at"] or 0))
    u = meter.summary(days)
    done_cases = counts["accepted"] + counts["rejected"]
    settled = [i for i in items if i["type"] == "case" and i["outcome"] != "running"]
    return {
        "now": now, "days": list(per_day.values()),
        "cases": {**counts, "total": len(cases), "how": how,
                  "acceptance": round(counts["accepted"] / done_cases, 3) if done_cases else None},
        "tasks": {**tcounts, "total": len(tasks)},
        "usage": u,
        "per_case": {"tokens": round(sum(i["tokens"] for i in settled) / len(settled)) if settled else 0,
                     "cost": round(sum(i["cost"] for i in settled) / len(settled), 4) if settled else 0.0},
        "items": items[:150],
        "price_note": f"₹{cfg['price_in']:g} per million tokens in, ₹{cfg['price_out']:g} out",
    }


def item(e, ops: list[dict], item_id: str) -> dict:
    meter = e.llm.meter
    c = e.store.get_case(item_id)
    if c:
        out, why = case_outcome(c)
        steps, people = case_work(e, c)
        title, kind, who = (c.get("text") or "")[:200], "case", c.get("customer_name")
    else:
        o = next((x for x in ops if x["id"] == item_id), None)
        if not o:
            raise KeyError(item_id)
        out, why = op_outcome(o)
        steps, people = op_work(o)
        title, kind, who = o.get("title") or "", "task", o.get("by")
    agents = _unique_agents(steps)
    t = meter.of(item_id)
    return {"id": item_id, "type": kind, "title": title, "who": who, "outcome": out, "how": why,
            "agents": [_agent(e, a) for a in agents],
            "steps": [{**s, "agents": [_agent(e, a) for a in s["agents"]]} for s in steps],
            "people": people,
            "tokens": {**t, "jobs": [{"job": j, "label": usage.JOBS.get(j, j), "tokens": n}
                                     for j, n in sorted(t.get("jobs", {}).items(), key=lambda kv: -kv[1])]}}


def register(app: FastAPI, E: Callable, O: Callable) -> None:
    @app.get("/api/dashboard")
    def dashboard(days: int = 14):
        return build(E(), O().all(), max(1, min(days, 90)))

    @app.get("/api/dashboard/item/{item_id}")
    def dashboard_item(item_id: str):
        try:
            return item(E(), O().all(), item_id)
        except KeyError:
            raise HTTPException(404, "no such case or task")

    @app.get("/api/usage")
    def get_usage(days: int = 14):
        return E().llm.meter.summary(max(1, min(days, 90)))

    @app.put("/api/usage")
    def put_usage(body: UsageIn):
        try:
            E().llm.meter.update(body.model_dump(exclude_none=True))
        except ValueError as ex:
            raise HTTPException(400, str(ex))
        return E().llm.meter.summary()
