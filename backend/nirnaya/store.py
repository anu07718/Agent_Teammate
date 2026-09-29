"""SQLite persistence: cases, checkpoints, the audit trail, labels, memory and the context graph."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY, customer_id TEXT, channel TEXT, created_at REAL, updated_at REAL,
  status TEXT, route TEXT, intent TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY, case_id TEXT, prev_id TEXT, superstep TEXT, status TEXT,
  graph_hash TEXT, policy_hash TEXT, state TEXT, created_at REAL);
CREATE INDEX IF NOT EXISTS checkpoints_case ON checkpoints(case_id, created_at);
CREATE TABLE IF NOT EXISTS trail (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, case_id TEXT, kind TEXT, actor TEXT,
  payload TEXT, prev_hash TEXT, hash TEXT);
CREATE TABLE IF NOT EXISTS pii_vault (token TEXT PRIMARY KEY, kind TEXT, value TEXT);
CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT, action TEXT, amount REAL, features TEXT,
  correct INTEGER, source TEXT, ts REAL);
CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, tool TEXT, result TEXT, ts REAL);
CREATE TABLE IF NOT EXISTS memory (
  case_id TEXT PRIMARY KEY, text TEXT, intent TEXT, action TEXT, outcome TEXT, state TEXT,
  entities TEXT, versions TEXT, ts REAL);
CREATE TABLE IF NOT EXISTS graph_nodes (id TEXT PRIMARY KEY, kind TEXT, label TEXT, props TEXT);
CREATE TABLE IF NOT EXISTS graph_edges (src TEXT, dst TEXT, kind TEXT, PRIMARY KEY (src, dst, kind));
CREATE TABLE IF NOT EXISTS benchmark_runs (id TEXT PRIMARY KEY, ts REAL, params TEXT, results TEXT);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
"""


def _dumps(v: Any) -> str:
    return json.dumps(v, sort_keys=True, default=str)


class Store:
    def __init__(self, path: str | os.PathLike | None = None):
        path = path or os.environ.get("NIRNAYA_DB") or Path(__file__).resolve().parent.parent / "data" / "nirnaya.db"
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL" if self.path != ":memory:" else "PRAGMA journal_mode=MEMORY")
        self.db.executescript(SCHEMA)

    # ── generic helpers ──────────────────────────────────────────────────────
    def execute(self, sql: str, args: tuple = ()) -> sqlite3.Cursor:
        with self.lock:
            return self.db.execute(sql, args)

    def query(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def kv_get(self, key: str, default: Any = None) -> Any:
        rows = self.query("SELECT value FROM kv WHERE key=?", (key,))
        return json.loads(rows[0]["value"]) if rows else default

    def kv_set(self, key: str, value: Any) -> None:
        self.execute("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     (key, _dumps(value)))

    # ── cases ────────────────────────────────────────────────────────────────
    def save_case(self, case: dict) -> None:
        case["updated_at"] = time.time()
        self.execute(
            "INSERT INTO cases(id, customer_id, channel, created_at, updated_at, status, route, intent, data) "
            "VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, "
            "status=excluded.status, route=excluded.route, intent=excluded.intent, data=excluded.data",
            (case["id"], case["customer_id"], case["channel"], case["created_at"], case["updated_at"],
             case["status"], case.get("route"), case.get("intent"), _dumps(case)))

    def get_case(self, case_id: str) -> dict | None:
        rows = self.query("SELECT data FROM cases WHERE id=?", (case_id,))
        return json.loads(rows[0]["data"]) if rows else None

    def list_cases(self, limit: int = 200) -> list[dict]:
        return [json.loads(r["data"]) for r in
                self.query("SELECT data FROM cases ORDER BY created_at DESC LIMIT ?", (limit,))]

    def count_cases(self) -> int:
        return self.query("SELECT COUNT(*) AS n FROM cases")[0]["n"]

    # ── checkpoints ──────────────────────────────────────────────────────────
    def add_checkpoint(self, cp: dict) -> None:
        self.execute("INSERT INTO checkpoints VALUES(?,?,?,?,?,?,?,?,?)",
                     (cp["id"], cp["case_id"], cp.get("prev_id"), cp["superstep"], cp["status"],
                      cp["graph_hash"], cp["policy_hash"], _dumps(cp["state"]), cp["created_at"]))

    def checkpoints(self, case_id: str) -> list[dict]:
        out = []
        for r in self.query("SELECT * FROM checkpoints WHERE case_id=? ORDER BY created_at, rowid", (case_id,)):
            d = dict(r)
            d["state"] = json.loads(d["state"])
            out.append(d)
        return out

    def latest_checkpoint(self, case_id: str) -> dict | None:
        cps = self.checkpoints(case_id)
        return cps[-1] if cps else None

    # ── idempotency ──────────────────────────────────────────────────────────
    def idem_get(self, key: str) -> dict | None:
        rows = self.query("SELECT result FROM idempotency WHERE key=?", (key,))
        return json.loads(rows[0]["result"]) if rows else None

    def idem_put(self, key: str, tool: str, result: dict) -> bool:
        try:
            self.execute("INSERT INTO idempotency VALUES(?,?,?,?)", (key, tool, _dumps(result), time.time()))
            return True
        except sqlite3.IntegrityError:
            return False

    # ── labels ───────────────────────────────────────────────────────────────
    def add_label(self, case_id: str, action: str, amount: float, features: dict, correct: bool, source: str):
        self.execute("INSERT INTO labels(case_id, action, amount, features, correct, source, ts) VALUES(?,?,?,?,?,?,?)",
                     (case_id, action, amount, _dumps(features), int(correct), source, time.time()))

    def labels(self) -> list[dict]:
        out = []
        for r in self.query("SELECT * FROM labels ORDER BY id"):
            d = dict(r)
            d["features"] = json.loads(d["features"])
            out.append(d)
        return out
