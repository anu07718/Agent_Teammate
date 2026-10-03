"""Tokens the language model used, who used them, and what they would cost.

Every answered model call is recorded by `llm.LLM._call`: the provider's own `usage` numbers when it sends them
(Ollama and the free clouds do), otherwise an estimate from the text. Each call is credited to whatever the
agents were working on (`CURRENT`: a case id, an office task id, an agent's chat, "intake"), to the day, and to
the job it did (reading a message, wording a reply, the finance-only check...). `asyncio.to_thread` copies the
context, so a call made in a worker thread still lands on its case.

The dashboard names the model by the label saved here (default: qwen3.6 on Ollama) and prices tokens at the
rates saved here, per million tokens. Ollama itself bills nothing; the price is what the same tokens would cost
from a hosted model, so a growing office can see what it would pay.
Settings: kv "usage_cfg". Counts: kv "usage".
"""
from __future__ import annotations

import contextlib
import contextvars
import math
import re
import threading
import time

KEY, CFG = "usage", "usage_cfg"
CURRENT: contextvars.ContextVar[dict | None] = contextvars.ContextVar("nirnaya_usage", default=None)
DEFAULTS = {"model": "qwen3.6", "runtime": "Ollama", "price_in": 15.0, "price_out": 60.0}   # ₹ per 1M tokens
JOBS = {"read": "Reading messages", "reply": "Wording replies", "scope": "Finance-only check",
        "chat": "Agent chat", "digest": "Digests", "outreach": "Reading pay / ask / message tasks", "test": "Model tests"}
MAX_REFS = 3000

# Qwen-style counting: every digit is its own token, a short English word is one, a long one a few, Devanagari
# about one token per two letters, other symbols one each. Close enough for "≈"; the model's own count wins.
_PIECE = re.compile(r"\d|[A-Za-z]+|[ऀ-ॿ]+| ?[^\sA-Za-z\dऀ-ॿ]|\s+")


def estimate(text: str | None) -> int:
    n = 0
    for m in _PIECE.finditer(text or ""):
        s = m.group()
        if s.isspace():
            n += 0 if len(s) == 1 else 1
        elif s.isdigit():
            n += 1
        elif s.isascii() and s.isalpha():
            n += 1 if len(s) <= 8 else math.ceil(len(s) / 6)
        elif "ऀ" <= s[0] <= "ॿ":
            n += math.ceil(len(s) / 2)
        else:
            n += 1
    return n


@contextlib.contextmanager
def working_on(ref: str):
    """Credit every model call made inside to `ref`; the dict it yields collects this block's own totals."""
    cur = {"ref": ref, "calls": 0, "in": 0, "out": 0}
    tok = CURRENT.set(cur)
    try:
        yield cur
    finally:
        CURRENT.reset(tok)


def _zero() -> dict:
    return {"calls": 0, "in": 0, "out": 0}


def _add(row: dict, calls: int, tin: int, tout: int) -> None:
    row["calls"] = row.get("calls", 0) + calls
    row["in"] = row.get("in", 0) + tin
    row["out"] = row.get("out", 0) + tout


class Meter:
    def __init__(self, store=None):
        self.store = store
        self._mem: dict | None = None
        self._cfg_mem: dict = {}
        self._lock = threading.Lock()

    def bind(self, store) -> None:
        if self.store is None:
            self.store = store
            self._mem = None

    # ── settings ────────────────────────────────────────────────────────────
    def settings(self) -> dict:
        saved = (self.store.kv_get(CFG) if self.store is not None else self._cfg_mem) or {}
        return {**DEFAULTS, **{k: v for k, v in saved.items() if k in DEFAULTS}}

    def update(self, patch: dict) -> dict:
        cur = self.settings()
        for k in ("model", "runtime"):
            if k in patch:
                v = str(patch[k] or "").strip()[:40]
                if not v:
                    raise ValueError(f"{k} cannot be empty")
                cur[k] = v
        for k in ("price_in", "price_out"):
            if k in patch:
                try:
                    v = float(patch[k])
                except (TypeError, ValueError):
                    raise ValueError(f"{k} must be a number")
                if not 0 <= v <= 100000:
                    raise ValueError(f"{k} must be between 0 and 100000 (₹ per million tokens)")
                cur[k] = round(v, 4)
        if self.store is not None:
            self.store.kv_set(CFG, cur)
        else:
            self._cfg_mem = cur
        return cur

    def cost(self, tin: int, tout: int, cfg: dict | None = None) -> float:
        cfg = cfg or self.settings()
        return round((tin * cfg["price_in"] + tout * cfg["price_out"]) / 1_000_000, 4)

    # ── counting ────────────────────────────────────────────────────────────
    def _data(self) -> dict:
        if self._mem is None:
            saved = self.store.kv_get(KEY) if self.store is not None else None
            self._mem = saved or {**_zero(), "days": {}, "refs": {}, "jobs": {}, "since": time.time()}
        return self._mem

    def _save(self) -> None:
        if self.store is not None:
            self.store.kv_set(KEY, self._mem)

    def record(self, tin: int, tout: int, *, job: str, estimated: bool = False, ref: str | None = None) -> dict:
        """One answered model call. Returns the row it was credited to."""
        tin, tout = max(0, int(tin or 0)), max(0, int(tout or 0))
        cur = CURRENT.get()
        ref = ref or (cur or {}).get("ref") or "other"
        with self._lock:
            d = self._data()
            _add(d, 1, tin, tout)
            if estimated:
                d["estimated_calls"] = d.get("estimated_calls", 0) + 1
            _add(d["days"].setdefault(time.strftime("%Y-%m-%d"), _zero()), 1, tin, tout)
            _add(d["jobs"].setdefault(job, _zero()), 1, tin, tout)
            row = d["refs"].pop(ref, None) or {**_zero(), "jobs": {}}
            _add(row, 1, tin, tout)
            row["jobs"][job] = row["jobs"].get(job, 0) + tin + tout
            row["last"] = time.time()
            d["refs"][ref] = row                 # newest last, so the oldest go first when trimmed
            while len(d["refs"]) > MAX_REFS:
                d["refs"].pop(next(iter(d["refs"])))
            self._save()
        if cur is not None:
            _add(cur, 1, tin, tout)
        return row

    def move(self, src: str, dst: str) -> None:
        """What was spent reading a sentence at Intake belongs to the case or task it became."""
        with self._lock:
            d = self._data()
            got = d["refs"].pop(src, None)
            if not got:
                return
            row = d["refs"].pop(dst, None) or {**_zero(), "jobs": {}}
            _add(row, got["calls"], got["in"], got["out"])
            for j, n in got.get("jobs", {}).items():
                row["jobs"][j] = row["jobs"].get(j, 0) + n
            row["last"] = time.time()
            d["refs"][dst] = row
            self._save()

    def of(self, ref: str) -> dict:
        """Tokens one case or task used: {calls, in, out, total, cost, jobs}."""
        with self._lock:
            row = dict(self._data()["refs"].get(ref) or {**_zero(), "jobs": {}})
        return {**row, "total": row["in"] + row["out"], "cost": self.cost(row["in"], row["out"])}

    def summary(self, days: int = 14) -> dict:
        cfg = self.settings()
        with self._lock:
            d = self._data()
            totals = {k: d.get(k, 0) for k in ("calls", "in", "out")}
            day_rows = dict(d["days"])
            jobs = {k: dict(v) for k, v in d["jobs"].items()}
            est = d.get("estimated_calls", 0)
            since = d.get("since")
        now = time.time()
        series = []
        for i in range(days - 1, -1, -1):
            day = time.strftime("%Y-%m-%d", time.localtime(now - i * 86400))
            r = day_rows.get(day) or _zero()
            series.append({"day": day, **r, "total": r["in"] + r["out"], "cost": self.cost(r["in"], r["out"], cfg)})
        return {
            "model": {"name": cfg["model"], "runtime": cfg["runtime"], "price_in": cfg["price_in"], "price_out": cfg["price_out"]},
            **totals, "total": totals["in"] + totals["out"], "cost": self.cost(totals["in"], totals["out"], cfg),
            "estimated_calls": est, "since": since, "days": series,
            "jobs": sorted(({"job": k, "label": JOBS.get(k, k), **v, "total": v["in"] + v["out"],
                             "cost": self.cost(v["in"], v["out"], cfg)} for k, v in jobs.items()),
                           key=lambda r: -r["total"]),
        }
