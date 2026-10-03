"""Flows: workflows the team draws on a canvas and the office's own agents run.

A flow is nodes and wires. It begins at Start (run by hand, or on a schedule in plain words) and goes
through customer messages (a case the agents resolve end to end: Sentry, triage, the specialist, the
calibrator, the Seal…), department tasks (the same ops the office bar hands out), checks on the last
result, a person's OK, a note in the team chat, or a pause. A run walks the wires from Start; each node's
state and result goes out live (the canvas, the office and every teammate see it), and the run is kept.

Nothing here moves money by itself: a customer message goes through the whole pipeline, Seal included,
and a department task is an ordinary op.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Callable

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import ops as ops_mod
from . import schedule
from .agents import DEPARTMENTS, STEP_AGENTS, Roster
from .policy import SUPERSTEPS
from .team import clean_name

log = logging.getLogger("nirnaya.flows")
KEY, RUNS_KEY, SEQ, RUN_SEQ = "flows", "flow_runs", "flows_seq", "flow_runs_seq"
TASK_DEPTS = ["verification", "decision", "commit", "oversight"]
DEPT_NAME = {d["id"]: d["name"] for d in DEPARTMENTS}
FINISHED = {"done", "failed", "skipped"}

NODE_TYPES: dict[str, dict] = {
    "start": {"label": "Start", "group": "Trigger", "icon": "▶", "ports": ["next"],
              "help": "Where a run begins: by hand, on a schedule in plain words, or when a customer's message "
                      "(email, WhatsApp, a call…) has been handled.",
              "config": {"when": "", "on": "", "channel": "any", "contains": ""}},
    "case": {"label": "Customer message", "group": "Agents", "icon": "💬", "ports": ["next"],
             "help": "Opens a case from a customer. The agents take it end to end; the node waits until it "
                     "is resolved (or approved, if it needs a person).",
             "config": {"customer_id": "C-1002", "message": "I was charged twice for ₹349 at CafeBrew", "channel": "chat"}},
    "task": {"label": "Department task", "group": "Agents", "icon": "📋", "ports": ["next"],
             "help": "Hands a department a task in plain words, like the office bar does.",
             "config": {"dept": "oversight", "text": "Verify the audit trail"}},
    "if": {"label": "Check", "group": "Logic", "icon": "◇", "ports": ["yes", "no"],
           "help": "Branches on what the step before it returned.",
           "config": {"field": "ok", "op": "is", "value": "true"}},
    "approval": {"label": "Ask a person", "group": "People", "icon": "✋", "ports": ["yes", "no"],
                 "help": "Waits until someone on the team says yes or no (here, in Approvals or in the office).",
                 "config": {"question": "Carry on?"}},
    "notify": {"label": "Post to team chat", "group": "People", "icon": "📣", "ports": ["next"],
               "help": "Posts in a department lead's chat for the whole team. {result}, {case}, {route} and "
                       "{by} fill in from the run.",
               "config": {"dept": "oversight", "text": "Done: {result}"}},
    "wait": {"label": "Wait", "group": "Logic", "icon": "⏱", "ports": ["next"],
             "help": "Pauses the run for a few seconds.", "config": {"seconds": 5}},
    "email": {"label": "Send email", "group": "Channels", "icon": "✉", "ports": ["next"],
              "help": "Sends an email through Channels → Email. “{from}” is whoever wrote in, so it replies to them.",
              "config": {"to": "{from}", "subject": "About your case {case}", "text": "Hello {name}, {result}"}},
    "whatsapp": {"label": "Send WhatsApp", "group": "Channels", "icon": "🟢", "ports": ["next"],
                 "help": "Sends a WhatsApp message through Channels → WhatsApp (a number with its country code, "
                         "or “{from}”).", "config": {"to": "{from}", "text": "Update on {case}: {result}"}},
    "call": {"label": "Phone call", "group": "Channels", "icon": "📞", "ports": ["next"],
             "help": "Phones someone through Channels → Calls: the agent says the message, then talks with them.",
             "config": {"to": "{from}", "text": "Hello {name}, this is Nirnaya calling about your case {case}."}},
    "webhook": {"label": "Call a webhook", "group": "Channels", "icon": "🔗", "ports": ["next"],
                "help": "POSTs the run so far as JSON to a URL: an n8n Webhook node, Make, Zapier or your own code.",
                "config": {"url": "", "text": "{result}"}},
}
START_ON = {"": "by hand or on a schedule", "message": "when a message arrives"}
CHANNEL_WORD = {"email": "email", "whatsapp": "WhatsApp", "voice": "phone", "web": "call-page", "hook": "webhook"}
START_CHANNELS = ["any", "email", "whatsapp", "voice", "web", "hook"]
FIELDS = {"ok": "the step succeeded", "route": "the case's route (ACT, HEDGE, ESCALATE, REFUSE)",
          "status": "the case's status (resolved, refused, parked)", "result": "the step's result text",
          "amount": "the case's amount (₹)"}
OPS = ["is", "is not", "contains", ">", "<"]
# what makes sense for each: a route is never "greater than" anything, and only text can "contain"
OPS_FOR = {"ok": ["is", "is not"], "route": ["is", "is not"], "status": ["is", "is not"],
           "result": ["is", "is not", "contains"], "amount": ["is", "is not", ">", "<"]}
FIELDS_SHORT = {"ok": "succeeded", "route": "route", "status": "status", "result": "result", "amount": "amount"}


def _examples() -> list[dict]:
    """Three flows to start from; each shows off one part of the office."""
    def n(i, t, x, y, **cfg):
        return {"id": i, "type": t, "x": x, "y": y, "config": {**NODE_TYPES[t]["config"], **cfg}}
    return [
        {"name": "Morning audit check", "nodes": [
            n("s", "start", 40, 160, when="every weekday at 9am"),
            n("t", "task", 300, 160, dept="oversight", text="Verify the audit trail"),
            n("c", "if", 560, 160, field="ok", op="is", value="true"),
            n("ok", "notify", 820, 60, dept="oversight", text="Morning check: {result}"),
            n("ask", "approval", 820, 270, question="The audit trail did not verify. Stop and look at it now?"),
        ], "edges": [
            {"from": "s", "to": "t", "port": "next"}, {"from": "t", "to": "c", "port": "next"},
            {"from": "c", "to": "ok", "port": "yes"}, {"from": "c", "to": "ask", "port": "no"},
        ]},
        {"name": "Duplicate-charge drill", "nodes": [
            n("s", "start", 40, 170),
            n("m", "case", 300, 170, customer_id="C-1002", message="I was charged twice for ₹349 at CafeBrew"),
            n("c", "if", 560, 170, field="route", op="is not", value="ESCALATE"),
            n("y", "notify", 820, 70, dept="commit", text="{case} went {route} without a person: {result}"),
            n("a", "approval", 820, 280, question="{case} was escalated. Look at it before the next drill?"),
        ], "edges": [
            {"from": "s", "to": "m", "port": "next"}, {"from": "m", "to": "c", "port": "next"},
            {"from": "c", "to": "y", "port": "yes"}, {"from": "c", "to": "a", "port": "no"},
        ]},
        {"name": "Model health", "nodes": [
            n("s", "start", 40, 150),
            n("b", "task", 290, 150, dept="decision", text="Run the benchmark"),
            n("d", "task", 540, 150, dept="oversight", text="Check for drift"),
            n("g", "task", 790, 150, dept="oversight", text="Write today's digest"),
            n("p", "notify", 1040, 150, dept="decision", text="Model health: {result}"),
        ], "edges": [
            {"from": "s", "to": "b", "port": "next"}, {"from": "b", "to": "d", "port": "next"},
            {"from": "d", "to": "g", "port": "next"}, {"from": "g", "to": "p", "port": "next"},
        ]},
    ]


def fill(text: str, out: dict, run: dict) -> str:
    ctx = run.get("ctx") or {}
    vals = {"result": (out.get("result") or "").split("\n")[0], "case": out.get("case_id") or "",
            "route": out.get("route") or "", "status": out.get("status") or "", "by": run.get("by") or "",
            "flow": run.get("name") or "", "from": out.get("from") or ctx.get("from") or "",
            "name": out.get("name") or ctx.get("name") or "", "channel": out.get("channel") or ctx.get("channel") or "",
            "text": out.get("text") or ctx.get("text") or ""}
    for k, v in vals.items():
        text = text.replace("{" + k + "}", str(v))
    return text


def check(cfg: dict, out: dict) -> bool:
    field, op, want = cfg.get("field", "ok"), cfg.get("op", "is"), str(cfg.get("value", "")).strip()
    got = out.get(field)
    if field == "ok":
        got, want = bool(got), want.lower() in ("true", "yes", "1", "ok")
        return got == want if op == "is" else got != want
    if field == "amount" or op in (">", "<"):
        try:
            a, b = float(got or 0), float(want.replace(",", "").replace("₹", "").strip())
        except ValueError:
            return op == "is not"
        return {"is": a == b, "is not": a != b, ">": a > b, "<": a < b}.get(op, False)
    g, w = str(got or "").lower(), want.lower()
    if op == "contains":
        return w in g
    return (g == w) if op == "is" else (g != w)


class FlowIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    nodes: list[dict]
    edges: list[dict] = []
    by: str | None = None
    version: int | None = None


class RunIn(BaseModel):
    by: str | None = None


class DecideIn(BaseModel):
    node: str
    approve: bool
    by: str | None = None
    note: str = ""


class Flows:
    def __init__(self, get_engine: Callable, get_ops: Callable, get_team: Callable, get_channels: Callable = lambda: None):
        self.E, self.O, self.T, self.C = get_engine, get_ops, get_team, get_channels
        self._tasks: dict[str, asyncio.Task] = {}  # run id → the task walking it
        self._gates: dict[tuple[str, str], asyncio.Future] = {}

    # ── storage ──────────────────────────────────────────────────────────────
    def all(self) -> list[dict]:
        saved = self.E().store.kv_get(KEY)
        if saved is None:  # the first time: three examples to start from
            saved = []
            for ex in _examples():
                saved.append(self._stamp({**ex, "id": self._next(SEQ, "FL"), "by": "Nirnaya", "example": True}))
            self.E().store.kv_set(KEY, saved)
        return saved

    def get(self, fid: str) -> dict | None:
        return next((f for f in self.all() if f["id"] == fid), None)

    def _next(self, key: str, prefix: str) -> str:
        n = self.E().store.kv_get(key, 1000) + 1
        self.E().store.kv_set(key, n)
        return f"{prefix}-{n}"

    def _stamp(self, f: dict) -> dict:
        f["version"] = f.get("version", 0) + 1
        f["updated_at"] = time.time()
        f.setdefault("created_at", f["updated_at"])
        start = next((x for x in f["nodes"] if x["type"] == "start"), None)
        scfg = (start or {}).get("config") or {}
        parsed = schedule.parse(scfg.get("when") or "") if start else None
        f["when"] = parsed["when"] if parsed and schedule.valid(parsed["when"]) else None
        f["on"] = scfg.get("on") or ""
        f["when_desc"] = schedule.describe(f["when"]) if f["when"] else "by hand"
        if f["on"] == "message":
            ch = scfg.get("channel") or "any"
            f["when_desc"] = ("on any message" if ch == "any" else f"on a {CHANNEL_WORD.get(ch, ch)} message") + \
                (f" with “{scfg['contains']}”" if scfg.get("contains") else "")
        f["next_at"] = schedule.next_run(f["when"], time.time()) if f["when"] and not f.get("paused") else None
        return f

    def save(self, body: FlowIn, fid: str | None = None) -> dict:
        nodes, edges = self.validate(body.nodes, body.edges)
        by = clean_name(body.by, "you")
        flows = self.all()
        if fid:
            cur = self.get(fid)
            if not cur:
                raise KeyError(fid)
            if body.version is not None and body.version != cur["version"]:
                raise ValueError(f"{cur.get('updated_by') or cur.get('by')} saved a newer version of “{cur['name']}”. "
                                 "Reload it, then make your change again.")
            f = {**cur, "name": body.name.strip(), "nodes": nodes, "edges": edges, "updated_by": by, "example": False}
        else:
            f = {"id": self._next(SEQ, "FL"), "name": body.name.strip(), "nodes": nodes, "edges": edges, "by": by,
                 "updated_by": by, "version": 0}
        f = self._stamp(f)
        flows = [x for x in flows if x["id"] != f["id"]] + [f]
        self.E().store.kv_set(KEY, flows)
        self.E().bus.publish("flow.saved", flow=f, by=by)
        return f

    def delete(self, fid: str, by: str) -> None:
        if not self.get(fid):
            raise KeyError(fid)
        self.E().store.kv_set(KEY, [x for x in self.all() if x["id"] != fid])
        self.E().bus.publish("flow.deleted", flow_id=fid, by=by)

    def runs(self, n: int = 40) -> list[dict]:
        return (self.E().store.kv_get(RUNS_KEY, []) or [])[-n:]

    def run_get(self, rid: str) -> dict | None:
        return next((r for r in self.runs(200) if r["id"] == rid), None)

    def _put_run(self, run: dict) -> dict:
        runs = [r for r in (self.E().store.kv_get(RUNS_KEY, []) or []) if r["id"] != run["id"]] + [run]
        self.E().store.kv_set(RUNS_KEY, runs[-80:])
        self.E().bus.publish("flow.run", run=run)
        return run

    # ── checking a flow before it is saved ───────────────────────────────────
    def validate(self, nodes: list[dict], edges: list[dict]) -> tuple[list[dict], list[dict]]:
        if not nodes:
            raise ValueError("A flow needs at least a Start node.")
        if len(nodes) > 60 or len(edges) > 120:
            raise ValueError("That flow is too big: at most 60 nodes and 120 wires.")
        e = self.E()
        clean, ids = [], set()
        for raw in nodes:
            t = raw.get("type")
            if t not in NODE_TYPES:
                raise ValueError(f"Unknown node type {t!r}.")
            nid = str(raw.get("id") or "")[:24]
            if not nid or nid in ids:
                raise ValueError("Every node needs its own id.")
            ids.add(nid)
            cfg = {**NODE_TYPES[t]["config"], **(raw.get("config") or {})}
            label = NODE_TYPES[t]["label"]
            if t == "start" and str(cfg.get("when") or "").strip():
                p = schedule.parse(str(cfg["when"]))
                if not p or not schedule.valid(p["when"]):
                    raise ValueError(f"Start: I can't read “{cfg['when']}” as a schedule. Try “every weekday at 9am” "
                                     "or “Mondays at 10:30”, or leave it empty to run it by hand.")
            if t == "start":
                if (cfg.get("on") or "") not in START_ON:
                    raise ValueError("Start: pick how the flow starts.")
                if cfg.get("on") == "message" and str(cfg.get("when") or "").strip():
                    raise ValueError("Start: a flow starts either on a schedule or on a message, not both.")
                if (cfg.get("channel") or "any") not in START_CHANNELS:
                    raise ValueError("Start: pick which channel's messages start it.")
            if t in ("email", "whatsapp", "call"):
                to = str(cfg.get("to") or "").strip()
                if not to:
                    raise ValueError(f"{label}: say who to send it to (or “{{from}}” for whoever wrote in).")
                if "{" not in to:
                    if t == "email" and "@" not in to:
                        raise ValueError(f"{label}: “{to}” is not an email address.")
                    if t != "email" and len(re.sub(r"\D", "", to)) < 10:
                        raise ValueError(f"{label}: “{to}” is not a phone number (with its country code).")
                if not str(cfg.get("text") or "").strip():
                    raise ValueError(f"{label}: write the message.")
            if t == "webhook" and not re.match(r"^https?://\S+$", str(cfg.get("url") or "").strip()):
                raise ValueError(f"{label}: give the URL to POST to (https://…).")
            if t == "case":
                if not e.rails.customer(str(cfg.get("customer_id"))):
                    raise ValueError(f"{label}: unknown customer {cfg.get('customer_id')}.")
                if not str(cfg.get("message") or "").strip():
                    raise ValueError(f"{label}: write what the customer says.")
            if t in ("task", "notify"):
                if cfg.get("dept") not in (TASK_DEPTS if t == "task" else DEPT_NAME):
                    raise ValueError(f"{label}: pick a department"
                                     + (" (customer messages go in a Customer message node)." if t == "task" else "."))
                if not str(cfg.get("text") or "").strip():
                    raise ValueError(f"{label}: write the {'task' if t == 'task' else 'message'}.")
            if t == "task":
                it = ops_mod.interpret(cfg["dept"], str(cfg["text"]))
                if it["kind"] == "off_topic":
                    raise ValueError(f"{label}: {it['problem']}")
                if it["kind"] == "routine":
                    raise ValueError(f"{label}: “{cfg['text']}” has a schedule in it. Put the schedule on Start.")
                if it.get("op_kind") == "help":
                    raise ValueError(f"{label}: {DEPT_NAME[cfg['dept']]} doesn't know “{cfg['text']}”. It can "
                                     + "; ".join(ops_mod.can_do(cfg["dept"])) + ".")
            if t == "if":
                if cfg.get("field") not in FIELDS or cfg.get("op") not in OPS_FOR[cfg["field"]]:
                    raise ValueError(f"{label}: pick what to check and how"
                                     + (f" ({FIELDS_SHORT[cfg['field']]} can be: {', '.join(OPS_FOR[cfg['field']])})."
                                        if cfg.get("field") in FIELDS else "."))
                if not str(cfg.get("value") or "").strip():
                    raise ValueError(f"{label}: say what to compare with.")
            if t == "wait":
                try:
                    cfg["seconds"] = max(0.0, min(3600.0, float(cfg.get("seconds") or 0)))
                except (TypeError, ValueError):
                    raise ValueError(f"{label}: seconds must be a number.")
            clean.append({"id": nid, "type": t, "x": float(raw.get("x") or 0), "y": float(raw.get("y") or 0),
                          "config": {k: (v if isinstance(v, (int, float, bool)) else str(v)[:4000]) for k, v in cfg.items()}})
        starts = [n for n in clean if n["type"] == "start"]
        if len(starts) != 1:
            raise ValueError("A flow has exactly one Start node." if starts else "Add a Start node: runs begin there.")
        types = {n["id"]: n["type"] for n in clean}
        wires, seen = [], set()
        for w in edges:
            a, b, port = str(w.get("from")), str(w.get("to")), w.get("port") or "next"
            if a not in types or b not in types:
                raise ValueError("A wire points at a node that isn't there.")
            if a == b:
                raise ValueError("A node can't be wired to itself.")
            if types[b] == "start":
                raise ValueError("Nothing can wire into Start.")
            if port not in NODE_TYPES[types[a]]["ports"]:
                raise ValueError(f"{NODE_TYPES[types[a]]['label']} has no “{port}” output.")
            if (a, b, port) in seen:
                continue
            seen.add((a, b, port))
            wires.append({"from": a, "to": b, "port": port})
        nxt: dict[str, list[str]] = {}
        for w in wires:
            nxt.setdefault(w["from"], []).append(w["to"])
        state: dict[str, int] = {}

        def loops(v: str) -> bool:
            state[v] = 1
            for u in nxt.get(v, []):
                if state.get(u) == 1 or (state.get(u) is None and loops(u)):
                    return True
            state[v] = 2
            return False
        if any(state.get(v) is None and loops(v) for v in types):
            raise ValueError("The wires go round in a loop. A flow has to reach an end.")
        return clean, wires

    # ── running ──────────────────────────────────────────────────────────────
    def start(self, fid: str, by: str, ctx: dict | None = None) -> dict:
        f = self.get(fid)
        if not f:
            raise KeyError(fid)
        run = {"id": self._next(RUN_SEQ, "FR"), "flow_id": f["id"], "name": f["name"], "by": by, "state": "running",
               "started_at": time.time(), "done_at": None, "progress": 0.0, "total": len(f["nodes"]),
               "nodes": {n["id"]: {"state": "pending", "text": "", "started_at": None, "done_at": None, "out": None}
                         for n in f["nodes"]},
               "flow": {"nodes": f["nodes"], "edges": f["edges"], "version": f["version"]}, "result": None,
               "ctx": ctx}
        self._put_run(run)
        self.E().trail.append("-", "flow.started", by, {"flow": f["id"], "run": run["id"], "name": f["name"]})
        rid = run["id"]
        t = asyncio.get_running_loop().create_task(self._walk(rid))
        self._tasks[rid] = t
        t.add_done_callback(lambda _t: self._tasks.pop(rid, None))
        return run

    def _set(self, run: dict, nid: str, **kw) -> None:
        run["nodes"][nid].update(kw)
        finished = sum(1 for x in run["nodes"].values() if x["state"] in FINISHED)
        run["progress"] = round(finished / max(1, run["total"]), 3)
        run["state"] = "waiting" if any(x["state"] == "waiting" for x in run["nodes"].values()) else \
            ("running" if run["state"] in ("running", "waiting") else run["state"])
        self._put_run(run)

    async def _walk(self, rid: str) -> None:
        run = self.run_get(rid)
        spec = run["flow"]
        by_id = {n["id"]: n for n in spec["nodes"]}
        out_edges: dict[str, list[dict]] = {}
        for w in spec["edges"]:
            out_edges.setdefault(w["from"], []).append(w)
        queue = [next(n["id"] for n in spec["nodes"] if n["type"] == "start")]
        last: dict = dict(run.get("ctx") or {"ok": True, "result": ""})
        failed = False
        try:
            while queue:
                nid = queue.pop(0)
                if run["nodes"][nid]["state"] != "pending":
                    continue  # two wires into one node: it runs once
                node = by_id[nid]
                self._set(run, nid, state="running", started_at=time.time(), text="…")
                try:
                    out, port = await self._do(run, node, last)
                except asyncio.CancelledError:
                    raise
                except Exception as ex:
                    log.exception("flow %s node %s failed", rid, nid)
                    out, port = {"ok": False, "result": f"Could not finish: {ex}"}, None
                state = "failed" if out.get("failed") else "done"
                self._set(run, nid, state=state, done_at=time.time(), text=out.get("note") or out.get("result") or "", out=out)
                last = out
                if state == "failed":
                    failed = True
                    break
                for w in out_edges.get(nid, []):
                    if port is None or w["port"] == port:
                        queue.append(w["to"])
        except asyncio.CancelledError:
            run = self.run_get(rid) or run
            for nid, x in run["nodes"].items():
                if x["state"] in ("running", "waiting"):
                    x.update(state="failed", done_at=time.time(), text="stopped")
            run.update(state="stopped", done_at=time.time())
            self._finish(run)
            return
        for x in run["nodes"].values():
            if x["state"] == "pending":
                x.update(state="skipped", text="not on this run's path")
        run.update(state="failed" if failed else "done", done_at=time.time(), result=(last.get("result") or "")[:500])
        self._finish(run)

    def _finish(self, run: dict) -> None:
        run["progress"] = 1.0 if run["state"] == "done" else run["progress"]
        self._put_run(run)
        self.E().trail.append("-", "flow.finished", "flows", {"run": run["id"], "state": run["state"]})

    async def _do(self, run: dict, node: dict, last: dict) -> tuple[dict, str | None]:
        e, t, cfg = self.E(), node["type"], node["config"]
        tick = 0.25 if e.step_delay else 0.02
        if t == "start":
            ctx = run.get("ctx")
            if ctx:
                return {**_carry(ctx), "note": f"{CHANNEL_WORD.get(ctx.get('channel'), ctx.get('channel') or 'A')} "
                        f"message from {ctx.get('name') or ctx.get('from')}: “{(ctx.get('text') or '')[:120]}”"}, "next"
            return {"ok": True, "result": f"Started by {run['by']}"}, "next"
        if t in ("email", "whatsapp", "call", "webhook"):
            return await self._channel_node(run, node, last), "next"
        if t == "wait":
            await asyncio.sleep(float(cfg.get("seconds") or 0))
            return {**_carry(last), "note": f"Waited {float(cfg.get('seconds') or 0):g} s"}, "next"
        if t == "notify":
            dept = cfg["dept"]
            text = fill(str(cfg["text"]), last, run)
            self.T().post(Roster.lead_of(dept), "agent", text, icon="📣", by=f"flow · {run['name']}", ref=run["id"])
            return {**_carry(last), "note": f"Posted to {DEPT_NAME[dept]}: {text}"}, "next"
        if t == "if":
            yes = check(cfg, last)
            return {**_carry(last), "note": f"{FIELDS_SHORT.get(cfg['field'], cfg['field'])} {cfg['op']} {cfg['value']} → "
                    f"{'yes' if yes else 'no'}"}, "yes" if yes else "no"
        if t == "approval":
            q = fill(str(cfg.get("question") or "Carry on?"), last, run)
            gate = asyncio.get_running_loop().create_future()
            self._gates[(run["id"], node["id"])] = gate
            self._set(run, node["id"], state="waiting", text=q, out={"question": q})
            e.roster.waiting("human", run["id"], q)
            e.bus.publish("agent.status", agent="human", status="waiting", case_id=run["id"], doing=q,
                          department="oversight")
            try:
                yes, who, note = await gate
            finally:
                self._gates.pop((run["id"], node["id"]), None)
                e.roster.idle("human")
                e.bus.publish("agent.status", agent="human", status="idle", case_id=None, doing=None, department="oversight")
            e.trail.append("-", "flow.approval", who, {"run": run["id"], "node": node["id"], "yes": yes, "note": note})
            return {**_carry(last), "ok": yes, "by": who,
                    "result": f"{who} said {'yes' if yes else 'no'}" + (f": “{note}”" if note else "")}, "yes" if yes else "no"
        if t == "case":
            c = e.create_case(cfg["customer_id"], str(cfg["message"]), cfg.get("channel") or "chat",
                              by=f"flow · {run['name']}")
            e.start(c["id"])
            self._set(run, node["id"], text=f"{c['id']} opened; the agents have it")
            while True:
                await asyncio.sleep(tick)
                cur = e.store.get_case(c["id"]) or c
                if cur.get("pending"):
                    if run["nodes"][node["id"]]["state"] != "waiting":
                        self._set(run, node["id"], state="waiting", text=f"{c['id']} is waiting for a person's OK (Approvals)")
                    continue
                if cur["status"] in ("resolved", "refused"):
                    break
                step = cur.get("step") or ""
                i = SUPERSTEPS.index(step) + 1 if step in SUPERSTEPS else 0
                text = f"{c['id']} · {step} ({i}/{len(SUPERSTEPS)})"
                if run["nodes"][node["id"]]["text"] != text:
                    self._set(run, node["id"], state="running", text=text)
            s = e.summary(cur)
            reply = next((m["text"] for m in reversed(cur["conversation"]) if m["role"] == "nirnaya"), "")
            return {"ok": s["status"] == "resolved" and s["route"] != "REFUSE", "case_id": s["id"], "route": s["route"],
                    "status": s["status"], "amount": s.get("amount"),
                    "result": f"{s['id']} {s['status']} · {s['route']}" + (f" · “{reply[:140]}”" if reply else "")}, "next"
        if t == "task":
            it = ops_mod.interpret(cfg["dept"], str(cfg["text"]))
            op = self.O().create(it["op_kind"], dept=it["dept"], agent=it["agent"], title=it["title"], text=str(cfg["text"]),
                                 by=f"flow · {run['name']}")
            self._set(run, node["id"], text=f"{op['id']} · {e.roster.agents[op['agent']]['name']} has it")
            while True:
                await asyncio.sleep(tick)
                cur = self.O().get(op["id"]) or op
                if cur["state"] == "waiting" and run["nodes"][node["id"]]["state"] != "waiting":
                    self._set(run, node["id"], state="waiting", text=f"{op['id']}: {cur.get('ask') or 'waiting for an OK'}")
                if cur["state"] == "done":
                    break
            return {"ok": bool(cur["ok"]), "op_id": op["id"], "result": cur.get("result") or "",
                    "case_id": cur.get("case_id")}, "next"
        raise ValueError(f"unknown node {t}")

    def decide(self, rid: str, nid: str, yes: bool, by: str, note: str = "") -> dict:
        gate = self._gates.get((rid, nid))
        if not gate or gate.done():
            raise ValueError("That step isn't waiting for anyone.")
        gate.set_result((yes, by, note))
        return self.run_get(rid)

    def stop(self, rid: str, by: str) -> dict:
        run = self.run_get(rid)
        if not run or run["state"] not in ("running", "waiting"):
            raise ValueError("That run isn't going.")
        run["stopped_by"] = by
        t = self._tasks.get(rid)
        if t:
            t.cancel()  # _walk marks it stopped
        else:  # nothing is walking it (a restart in between): just close it
            run.update(state="stopped", done_at=time.time())
            self._put_run(run)
        self.E().trail.append("-", "flow.stopped", by, {"run": rid})
        return run

    def waiting(self) -> list[dict]:
        out = []
        for r in self.runs(80):
            if r["state"] != "waiting":
                continue
            for nid, x in r["nodes"].items():
                node = next((n for n in r["flow"]["nodes"] if n["id"] == nid), None)
                if x["state"] == "waiting" and node and node["type"] == "approval":
                    out.append({"run_id": r["id"], "node": nid, "flow": r["name"], "flow_id": r["flow_id"], "question": x["text"],
                                "since": x["started_at"], "by": r["by"]})
        return out

    def recover(self) -> None:
        """After a restart no run is still going: say so on each one that was."""
        runs = self.E().store.kv_get(RUNS_KEY, []) or []
        changed = False
        for r in runs:
            if r["state"] in ("running", "waiting"):
                for x in r["nodes"].values():
                    if x["state"] in ("running", "waiting"):
                        x.update(state="failed", text="stopped by a restart")
                r.update(state="stopped", done_at=time.time())
                changed = True
        if changed:
            self.E().store.kv_set(RUNS_KEY, runs)

    def on_message(self, ctx: dict) -> list[str]:
        """A customer's message has been handled (its case resolved, parked or refused): start every flow
        whose Start waits for messages on that channel (and with those words, when it asks for some)."""
        started = []
        for f in self.all():
            start = next((n for n in f["nodes"] if n["type"] == "start"), None)
            cfg = (start or {}).get("config") or {}
            if cfg.get("on") != "message" or f.get("paused"):
                continue
            want = cfg.get("channel") or "any"
            if want != "any" and want != ctx.get("channel"):
                continue
            words = (cfg.get("contains") or "").strip().lower()
            if words and words not in (ctx.get("text") or "").lower():
                continue
            who = ctx.get("name") or ctx.get("from") or "a customer"
            run = self.start(f["id"], f"{CHANNEL_WORD.get(ctx.get('channel'), 'message')} · {who}"[:32], ctx=ctx)
            started.append(run["id"])
        return started

    async def _channel_node(self, run: dict, node: dict, last: dict) -> dict:
        """Send email, Send WhatsApp, Phone call, Call a webhook: the office's channels, from a flow."""
        t, cfg = node["type"], node["config"]
        ch = self.C()
        by = f"flow · {run['name']}"[:32]
        text = fill(str(cfg.get("text") or ""), last, run)
        try:
            if t == "webhook":
                from .channels.http import request as http_request
                url = str(cfg["url"]).strip()
                carry = _carry(last)
                payload = {**carry, "message": carry.get("text"), "flow": run["name"], "run": run["id"], "text": text}
                await asyncio.to_thread(http_request, "POST", url, json_body=payload, timeout=20)
                return {**_carry(last), "note": f"Posted to {url.split('/')[2] if '//' in url else url}"}
            if ch is None:
                raise RuntimeError("channels are not running")
            to = fill(str(cfg.get("to") or ""), last, run).strip()
            if not to:
                raise ValueError("there is nobody to send it to (the run has no {from})")
            if t == "call":
                r = await ch.call(to, text, case_id=last.get("case_id"), by=by)
                return {**_carry(last), "note": f"Calling {to} ({r.get('sid') or 'queued'})"}
            subject = fill(str(cfg.get("subject") or ""), last, run) if t == "email" else ""
            await ch.send(t, to, text, subject=subject, case_id=last.get("case_id"), by=by)
            return {**_carry(last), "note": f"{'Emailed' if t == 'email' else 'WhatsApped'} {to}: {text[:120]}"}
        except Exception as ex:  # a channel that is not set up, or a provider that said no
            return {**_carry(last), "ok": False, "failed": True, "result": f"Could not {NODE_TYPES[t]['label'].lower()}: {ex}"}

    def fire_due(self, now: float | None = None) -> list[str]:
        now = now or time.time()
        fired = []
        flows = self.all()
        for f in flows:
            if f.get("when") and f.get("next_at") and f["next_at"] <= now:
                f["next_at"] = schedule.next_run(f["when"], now)
                self.start(f["id"], "schedule")
                fired.append(f["id"])
        if fired:
            self.E().store.kv_set(KEY, flows)
        return fired

    # ── the live pipeline: how the agents are working right now ─────────────
    def pipeline(self) -> dict:
        e = self.E()
        cases = e.store.list_cases(200)
        steps = []
        for i, s in enumerate(SUPERSTEPS):
            agents = STEP_AGENTS.get(s) or []
            here = [c["id"] for c in cases if c["status"] == "running" and c.get("step") == s]
            passed = [x for c in cases for x in c.get("supersteps", []) if x["name"] == s and x.get("ended")]
            ms = [1000 * (x["ended"] - x["started"]) for x in passed]
            steps.append({"name": s, "i": i, "agents": agents or ["specialist"], "here": here, "done": len(passed),
                          "avg_ms": round(sum(ms) / len(ms), 1) if ms else None})
        live = []
        for c in cases[:30]:
            step = c.get("step")
            i = SUPERSTEPS.index(step) + 1 if step in SUPERSTEPS else (len(SUPERSTEPS) if c["status"] != "running" else 0)
            live.append({**e.summary(c), "progress": 1.0 if c["status"] in ("resolved", "refused") else i / len(SUPERSTEPS),
                         "passed": [x["name"] for x in c.get("supersteps", []) if x.get("ended")]})
        ops = self.O().all()[-60:]
        return {"steps": steps, "cases": live, "ops": {st: sum(1 for o in ops if o["state"] == st)
                                                         for st in ("scheduled", "next", "doing", "waiting", "done")},
                "runs": [r for r in self.runs(20) if r["state"] in ("running", "waiting")]}


def _carry(last: dict) -> dict:
    """What a pass-through step (a check, a wait, a chat post) hands on: the last real result."""
    return {k: last[k] for k in ("ok", "result", "case_id", "route", "status", "amount", "op_id", "from", "name",
                                 "channel", "text", "customer_id") if last.get(k) is not None}


def register(app: FastAPI, E: Callable, F: Callable[[], Flows]) -> None:
    @app.get("/api/flows")
    def flows_list():
        e = E()
        return {"flows": F().all(), "runs": F().runs(40), "waiting": F().waiting(), "types": NODE_TYPES, "fields": FIELDS,
                "ops": OPS, "ops_for": OPS_FOR, "start_on": START_ON, "start_channels": START_CHANNELS, "task_depts": TASK_DEPTS, "depts": [{"id": d["id"], "name": d["name"]} for d in DEPARTMENTS],
                "customers": [{"id": c["id"], "name": c["name"]} for c in e.rails.customers()],
                "can": {d: ops_mod.can_do(d) for d in TASK_DEPTS}}

    @app.get("/api/flows/pipeline")
    def flows_pipeline():
        return F().pipeline()

    @app.post("/api/flows", status_code=201)
    async def flows_create(body: FlowIn):
        try:
            return F().save(body)
        except ValueError as ex:
            raise HTTPException(400, str(ex))

    @app.put("/api/flows/{fid}")
    async def flows_save(fid: str, body: FlowIn):
        try:
            return F().save(body, fid)
        except KeyError:
            raise HTTPException(404, "no such flow")
        except ValueError as ex:
            raise HTTPException(409 if "newer version" in str(ex) else 400, str(ex))

    @app.delete("/api/flows/{fid}")
    async def flows_delete(fid: str, by: str | None = None):
        try:
            F().delete(fid, clean_name(by, "you"))
        except KeyError:
            raise HTTPException(404, "no such flow")
        return {"ok": True}

    @app.post("/api/flows/{fid}/run")
    async def flows_run(fid: str, body: RunIn | None = None):
        try:
            return F().start(fid, clean_name(body.by if body else None, "you"))
        except KeyError:
            raise HTTPException(404, "no such flow")

    @app.post("/api/flows/runs/{rid}/decide")
    async def flows_decide(rid: str, body: DecideIn):
        try:
            return F().decide(rid, body.node, body.approve, clean_name(body.by, "you"), body.note.strip()[:500])
        except ValueError as ex:
            raise HTTPException(409, str(ex))

    @app.post("/api/flows/runs/{rid}/stop")
    async def flows_stop(rid: str, body: RunIn | None = None):
        try:
            return F().stop(rid, clean_name(body.by if body else None, "you"))
        except ValueError as ex:
            raise HTTPException(409, str(ex))
