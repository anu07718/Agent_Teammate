"""Routines: jobs on the office's own clock, persisted across restarts.

- TAT watch: a parked case whose approval is overdue against its TAT is flagged to the human desk.
- Drift check: recompute the drift monitor on schedule, not only when cases arrive.
- Nightly benchmark: re-run pass^k against the current thresholds (manual trigger in the demo).
"""
from __future__ import annotations

import asyncio
import logging
import time

log = logging.getLogger("nirnaya.routines")


class Routines:
    def __init__(self, engine):
        self.engine = engine
        self.jobs = [
            {"id": "tat-watch", "name": "TAT watch", "every_s": 60, "last": None, "result": None},
            {"id": "drift-check", "name": "Drift check", "every_s": 30, "last": None, "result": None},
            {"id": "benchmark", "name": "Nightly benchmark", "every_s": 86_400, "last": None, "result": None},
        ]
        saved = engine.store.kv_get("routines") or {}
        for j in self.jobs:
            j["last"] = saved.get(j["id"])
        self._task: asyncio.Task | None = None

    def _persist(self) -> None:
        self.engine.store.kv_set("routines", {j["id"]: j["last"] for j in self.jobs})

    async def run_job(self, job_id: str) -> dict:
        e = self.engine
        job = next(j for j in self.jobs if j["id"] == job_id)
        if job_id == "tat-watch":
            overdue = []
            for c in e.store.list_cases(500):
                p = c.get("pending")
                if p and time.time() - p["requested_at"] > 4 * 3600:
                    overdue.append(c["id"])
            if overdue:
                e.bus.publish("routine.alert", routine="tat-watch", cases=overdue)
            job["result"] = {"overdue": overdue}
        elif job_id == "drift-check":
            prev = e.drift_status["alarm"]
            e.drift_status = e.drift.check()
            if e.drift_status["alarm"] != prev:
                e.refit_thresholds()
                e.bus.publish("drift.alarm", status=e.drift_status)
            job["result"] = {"psi": e.drift_status["psi"], "alarm": e.drift_status["alarm"]}
        elif job_id == "benchmark":
            from . import benchmark
            r = await benchmark.run(e, k=3, label="routine")
            job["result"] = {k: r[k] for k in ("id", "pass_k", "autonomy", "wrong_autonomous")}
        job["last"] = time.time()
        self._persist()
        e.bus.publish("routine.ran", routine=job_id, result=job["result"])
        return job

    async def loop(self) -> None:
        while True:
            now = time.time()
            for j in self.jobs:
                if j["id"] == "benchmark":
                    continue
                if j["last"] is None or now - j["last"] >= j["every_s"]:
                    try:
                        await self.run_job(j["id"])
                    except Exception:
                        log.exception("routine %s failed", j["id"])
            await asyncio.sleep(5)

    def start(self) -> None:
        self._task = asyncio.get_running_loop().create_task(self.loop())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
