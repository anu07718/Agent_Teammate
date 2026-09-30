"""Routines: office tasks on the office's own clock, persisted across restarts.

Three ship with the office:
- TAT watch (every minute): a parked case whose approval is past its TAT is flagged to the human desk.
- Drift check (every minute): recompute the drift monitor on schedule, not only when cases arrive.
- Nightly benchmark (02:00): re-run pass^k against the current thresholds.

More can be set in plain words from the office bar or a department lead's chat ("every weekday at 9am,
verify the audit trail"). A routine fires an op (see ops.py), so each run is a card on the board; the two
minute-level checks stay quiet unless they find something or you press RUN NOW.
"""
from __future__ import annotations

import asyncio
import logging
import time

from . import schedule
from .ops import KINDS, Ops, run_kind

log = logging.getLogger("nirnaya.routines")
KEY = "routines_v2"
BUILTIN = [
    {"id": "tat-watch", "kind": "tat-watch", "title": "TAT watch", "when": {"kind": "minutes", "every": 1}, "quiet": True},
    {"id": "drift-check", "kind": "drift-check", "title": "Drift check", "when": {"kind": "minutes", "every": 1}, "quiet": True},
    {"id": "benchmark", "kind": "benchmark", "title": "Nightly benchmark", "when": {"kind": "daily", "at": "02:00"}},
]


def _fresh(spec: dict, by: str = "system") -> dict:
    k = KINDS[spec["kind"]]
    return {"id": spec["id"], "kind": spec["kind"], "title": spec["title"], "name": spec["title"],
            "text": spec.get("text") or spec["title"], "dept": k["dept"], "agent": k["agent"], "when": spec["when"],
            "needs_ok": bool(spec.get("needs_ok", k.get("needs_ok", False))), "paused": False,
            "quiet": bool(spec.get("quiet")), "by": by, "created_at": time.time(), "last": None, "next_at": None,
            "result": None, "runs": 0, "last_op": None}


class Routines:
    def __init__(self, engine, ops: Ops | None = None):
        self.engine = engine
        self.ops = ops or Ops(lambda: self.engine)
        saved = engine.store.kv_get(KEY)
        if saved is None:
            old = engine.store.kv_get("routines") or {}  # the first release kept only last-run times
            saved = []
            for spec in BUILTIN:
                r = _fresh(spec)
                r["last"] = old.get(spec["id"])
                saved.append(r)
        self.jobs: list[dict] = saved
        now = time.time()
        for r in self.jobs:
            r["desc"] = schedule.describe(r["when"])
            if not r["paused"] and (not r.get("next_at") or r["next_at"] < now - 3600):
                r["next_at"] = schedule.next_run(r["when"], now)
        self._persist()
        self._task: asyncio.Task | None = None
        self.flows = None  # set by the app: flows with a schedule fire on this clock too

    # ── the list ─────────────────────────────────────────────────────────────
    def _persist(self) -> None:
        self.engine.store.kv_set(KEY, self.jobs)

    def get(self, rid: str) -> dict | None:
        return next((r for r in self.jobs if r["id"] == rid), None)

    def public(self) -> list[dict]:
        return [{**r, "desc": schedule.describe(r["when"])} for r in self.jobs]

    def add(self, kind: str, when: dict, *, text: str = "", title: str | None = None,
            needs_ok: bool | None = None, by: str = "you") -> dict:
        if kind not in KINDS or not KINDS[kind]["routine"]:
            raise ValueError(f"{kind} cannot run as a routine")
        if not schedule.valid(when):
            raise ValueError("that schedule is not complete")
        base = "-".join((title or KINDS[kind]["title"]).lower().split())[:32].strip("-") or kind
        rid, n = base, 2
        while self.get(rid):
            rid, n = f"{base}-{n}", n + 1
        r = _fresh({"id": rid, "kind": kind, "title": title or KINDS[kind]["title"], "when": when, "text": text,
                    **({"needs_ok": needs_ok} if needs_ok is not None else {})}, by=by)
        r["desc"] = schedule.describe(when)
        r["next_at"] = schedule.next_run(when, time.time())
        self.jobs.append(r)
        self._persist()
        self.engine.bus.publish("routine.changed", routine=r)
        return r

    def remove(self, rid: str) -> None:
        if not self.get(rid):
            raise KeyError(rid)
        self.jobs = [r for r in self.jobs if r["id"] != rid]
        self._persist()
        self.engine.bus.publish("routine.changed", removed=rid)

    def set_paused(self, rid: str, paused: bool) -> dict:
        r = self.get(rid)
        if not r:
            raise KeyError(rid)
        r["paused"] = paused
        r["next_at"] = None if paused else schedule.next_run(r["when"], time.time())
        self._persist()
        self.engine.bus.publish("routine.changed", routine=r)
        return r

    # ── running ──────────────────────────────────────────────────────────────
    async def run_job(self, job_id: str, manual: bool = True, late: bool = False) -> dict:
        e = self.engine
        r = self.get(job_id)
        if not r:
            raise KeyError(job_id)
        op = None
        if r["quiet"] and not manual:
            ok, result, _extra = await run_kind(e, {"id": "-", "kind": r["kind"], "text": r["text"], "by": "routine"})
            r["result"] = result
            if not ok:  # a quiet check that finds something becomes a card on the board
                op = self.ops.create(r["kind"], dept=r["dept"], agent=r["agent"], title=r["title"], text=r["text"],
                                     by="routine", routine=r["id"], needs_ok=False, done=(ok, result))
        else:
            op = self.ops.create(r["kind"], dept=r["dept"], agent=r["agent"], title=r["title"], text=r["text"],
                                 by="routine", routine=r["id"], needs_ok=r["needs_ok"], late=late)
            r["result"] = f"{op['id']} on the board"
        if op:
            r["last_op"] = op["id"]
        r["last"] = time.time()
        r["runs"] = r.get("runs", 0) + 1
        if not r["paused"]:
            r["next_at"] = schedule.next_run(r["when"], r["last"])
        self._persist()
        e.bus.publish("routine.ran", routine=r["id"], result=r["result"], op=op["id"] if op else None)
        return r

    async def tick(self, now: float | None = None) -> None:
        now = now or time.time()
        for r in list(self.jobs):
            if r["paused"] or not r.get("next_at") or r["next_at"] > now:
                continue
            try:
                await self.run_job(r["id"], manual=False, late=now - r["next_at"] > 90)
            except Exception:
                log.exception("routine %s failed", r["id"])
                r["next_at"] = schedule.next_run(r["when"], now)
        self.ops.fire_due(now)
        if getattr(self, "flows", None):
            self.flows.fire_due(now)

    async def loop(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:
                log.exception("routine tick failed")
            await asyncio.sleep(5)

    def start(self) -> None:
        self._task = asyncio.get_running_loop().create_task(self.loop())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
