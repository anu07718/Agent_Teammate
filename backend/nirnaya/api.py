"""HTTP API, live event stream, MCP endpoint, and the built web app, all from one process."""
from __future__ import annotations

import asyncio
import hmac
import json
import os
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import __version__, benchmark, channels, docparse, flows, office, relay, reports
from .agents import DEPARTMENTS
from .engine import Engine
from .policy import GRAPH_HASH, SUPERSTEPS
from .ops import Ops
from .presets import PRESETS
from .routines import Routines
from .team import Team, clean_name

# open even when NIRNAYA_ACCESS_KEY is set: providers sign their own requests, customers use the call page
OPEN_PATHS = ("/api/channels/whatsapp/webhook", "/api/channels/waha/webhook", "/api/channels/voice/twilio/",
              "/api/channels/email/inbound", "/api/channels/hook", "/api/channels/web/")
WEB_DIST = Path(os.environ.get("NIRNAYA_WEB", Path(__file__).resolve().parents[2] / "web" / "dist"))


class NewCase(BaseModel):
    customer_id: str
    message: str = Field(min_length=1, max_length=4000)
    channel: str = "chat"
    by: str | None = None


class By(BaseModel):
    by: str | None = None


class Me(BaseModel):
    client: str = Field(min_length=1, max_length=64)
    name: str | None = None
    view: str | None = None
    focus: str | None = None


class Decision(BaseModel):
    by: str = "support lead"
    note: str = ""
    edits: dict[str, float] | None = None


class PolicyChange(BaseModel):
    action: str
    alpha: float | None = None
    rung: int | None = None
    by: str | None = None


class RailEvent(BaseModel):
    txn_id: str
    event: str


class WorkspaceIn(BaseModel):
    url: str | None = None
    name: str | None = Field(default=None, max_length=80)
    by: str | None = None


class Ask(BaseModel):
    question: str = Field(min_length=1, max_length=1000)


def _init_monitoring() -> bool:
    dsn = os.environ.get("SENTRY_DSN")
    if not dsn:
        return False
    try:
        import sentry_sdk
        sentry_sdk.init(dsn=dsn, traces_sample_rate=float(os.environ.get("SENTRY_TRACES", "0.1")),
                        send_default_pii=False, release=f"nirnaya@{__version__}")
        return True
    except Exception:
        return False


def create_app(engine: Engine | None = None, *, background: bool = True) -> FastAPI:
    monitoring = _init_monitoring()
    state: dict = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        eng = engine or Engine()
        state["engine"] = eng
        state["ops"] = Ops(lambda: state["engine"])
        state["routines"] = Routines(eng, state["ops"])
        state["team"].hook(eng.bus)
        state["flows"] = flows.Flows(lambda: state["engine"], lambda: state["ops"], lambda: state["team"],
                                     lambda: state["channels"])
        state["flows"].recover()
        state["routines"].flows = state["flows"]
        state["channels"] = channels.Channels(lambda: state["engine"], lambda: state["flows"])
        state["channels"].hook(eng.bus)
        await state["channels"].start(background)
        state["relay"] = relay.Relay(app, lambda: state["engine"].store, lambda: state["engine"].bus,
                                     lambda: state["team"], lambda: os.environ.get("NIRNAYA_ACCESS_KEY", ""))
        state["relay"].hook(eng.bus)
        if background:
            await eng.recover()
            state["routines"].start()
            await state["relay"].resume()
        yield
        await state["relay"].shutdown()
        state["channels"].stop()
        state["routines"].stop()
        for t in list(eng.tasks.values()):
            t.cancel()

    state["team"] = Team(lambda: state["engine"])
    app = FastAPI(title="Nirnaya", version=__version__, lifespan=lifespan)

    @app.middleware("http")
    async def access_key(request: Request, call_next):
        """NIRNAYA_ACCESS_KEY locks the API for a server on the internet. Provider webhooks (each checks its
        own signature), the customer call page and the health check stay open; the app asks for the key."""
        key = os.environ.get("NIRNAYA_ACCESS_KEY", "")
        path = request.url.path
        if key and request.method != "OPTIONS" and (path.startswith("/api/") or path == "/mcp") \
                and not path.startswith(OPEN_PATHS) and path != "/api/health":
            given = request.headers.get("x-nirnaya-key") or request.cookies.get("nirnaya_key") or \
                request.query_params.get("key") or ""
            if not hmac.compare_digest(given.encode(), key.encode()):
                return JSONResponse({"detail": "this Nirnaya server needs its access key", "key_required": True},
                                    status_code=401)
        return await call_next(request)

    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    def E() -> Engine:
        return state["engine"]

    def get_case(case_id: str) -> dict:
        c = E().store.get_case(case_id)
        if not c:
            raise HTTPException(404, f"no case {case_id}")
        return c

    # ── bootstrap & state ────────────────────────────────────────────────────
    @app.get("/api/health")
    def health():
        e = E()
        return {"ok": True, "version": __version__, "uptime_s": round(time.time() - e.started_at, 1),
                "graph_hash": GRAPH_HASH, "policy_hash": e.policy.policy_hash(), "llm": e.llm.enabled}

    @app.get("/api/state")
    def app_state():
        e = E()
        customers = [{"id": c["id"], "name": c["name"], "segment": c["segment"]} for c in e.rails.customers()]
        return {"agents": e.roster.public(), "departments": DEPARTMENTS, "tools": e.gateway.describe(),
                "cases": [e.summary(c) for c in e.store.list_cases(100)], "stats": e.stats(),
                "customers": customers, "presets": PRESETS, "supersteps": SUPERSTEPS, "drift": e.drift_status,
                "policy_hash": e.policy.policy_hash(), "integrations": integrations(),
                "channels": _channel_status(),
                "waiting": {"cases": sum(1 for c in e.store.list_cases(500) if c.get("pending")),
                            "ops": sum(1 for o in state["ops"].all() if o["state"] == "waiting"),
                            "flows": len(state["flows"].waiting())}}

    def _channel_status() -> dict:
        ch = state.get("channels")
        if ch is None:
            return {}
        cfg = ch.config()
        return {k: {"enabled": bool(cfg[k]["enabled"]), "ok": ch.status[k]["ok"], "error": ch.status[k]["error"],
                    "provider": cfg[k].get("provider") or cfg[k].get("send") or ""} for k in ("email", "whatsapp", "voice", "hook")}

    @app.get("/api/integrations")
    def integrations():
        e = E()
        return {"llm": e.llm.summary(),
                "monitoring": {"enabled": monitoring, "provider": "Sentry SDK"},
                "documents": docparse.available(), "officecli": reports.officecli_available(),
                "mcp": {"endpoint": "/mcp", "tools": len(MCP_TOOLS)}}

    # ── shared workspaces: others join with a code, through a free Firebase relay (relay.py) ──
    @app.get("/api/workspace")
    def workspace():
        return state["relay"].status()

    @app.post("/api/workspace/create")
    async def workspace_create(body: WorkspaceIn):
        """Host a workspace (or make a new code for it, which shuts out everyone who had the old one)."""
        try:
            return await state["relay"].create(body.url, body.name, clean_name(body.by, "My"))
        except (ValueError, relay.RelayError) as ex:
            raise HTTPException(400, str(ex))

    @app.post("/api/workspace/stop")
    async def workspace_stop():
        return await state["relay"].stop()

    @app.post("/api/workspace/check")
    def workspace_check(body: WorkspaceIn):
        """Is this database set up right (address and rules)? Writes and removes a test entry."""
        try:
            return relay.probe(body.url or "")
        except (ValueError, relay.RelayError) as ex:
            raise HTTPException(400, str(ex))

    # ── the language model: free providers only, tried in order (llm.py) ────
    @app.get("/api/llm")
    def llm_get():
        return E().llm.describe()

    @app.put("/api/llm")
    def llm_put(body: dict = Body(...)):
        try:
            E().llm.update(body)
        except ValueError as ex:
            raise HTTPException(400, str(ex))
        return E().llm.describe()

    @app.post("/api/llm/test/{provider}")
    def llm_test(provider: str):
        try:
            return E().llm.test(provider)
        except ValueError as ex:
            raise HTTPException(404, str(ex))

    @app.get("/api/events")
    async def events(request: Request, who: str | None = None, client: str | None = None, view: str | None = None):
        q = E().bus.subscribe()
        team: Team = state["team"]
        client = (client or "")[:64] or None

        async def stream():
            if client:
                team.join(client, who or "Someone", view)
            try:
                yield f"event: hello\ndata: {json.dumps({'ts': time.time()})}\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        ev = await asyncio.wait_for(q.get(), timeout=15)
                        yield f"data: {json.dumps(ev, default=str)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keep-alive\n\n"
            finally:
                E().bus.unsubscribe(q)
                if client:
                    team.leave(client)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/events/recent")
    def recent_events(n: int = 200):
        return E().bus.recent(max(1, min(n, 1500)))

    # ── the team ─────────────────────────────────────────────────────────────
    @app.get("/api/team")
    def team_now():
        return {"people": state["team"].online()}

    @app.post("/api/team/me")
    def team_me(body: Me):
        p = state["team"].update(body.client, name=body.name, view=body.view, focus=body.focus)
        return {"me": p, "people": state["team"].online()}

    # ── cases ────────────────────────────────────────────────────────────────
    @app.post("/api/cases", status_code=201)
    async def create(body: NewCase):
        try:
            c = E().create_case(body.customer_id, body.message, body.channel, by=clean_name(body.by) if body.by else None)
        except ValueError as ex:
            raise HTTPException(400, str(ex))
        E().start(c["id"])
        return E().summary(c)

    @app.get("/api/cases")
    def list_cases(limit: int = 100):
        return [E().summary(c) for c in E().store.list_cases(limit)]

    @app.get("/api/cases/{case_id}")
    def case_detail(case_id: str):
        c = get_case(case_id)
        c["checkpoints"] = [{k: v for k, v in cp.items() if k != "state"} for cp in E().store.checkpoints(case_id)]
        c["trail"] = E().trail.entries(case_id)
        return c

    @app.post("/api/cases/{case_id}/approve")
    async def approve(case_id: str, body: Decision):
        try:
            return await E().approve(case_id, clean_name(body.by, "support lead"), body.note, body.edits)
        except ValueError as ex:
            raise HTTPException(409, str(ex))

    @app.post("/api/cases/{case_id}/reject")
    async def reject(case_id: str, body: Decision):
        try:
            return await E().reject(case_id, clean_name(body.by, "support lead"), body.note)
        except ValueError as ex:
            raise HTTPException(409, str(ex))

    @app.post("/api/cases/{case_id}/undo")
    async def undo(case_id: str, body: By | None = None):
        try:
            return await E().undo(case_id, by=clean_name(body.by, "support lead") if body and body.by else "support lead")
        except ValueError as ex:
            raise HTTPException(409, str(ex))

    @app.post("/api/cases/{case_id}/audit")
    def audit(case_id: str, correct: bool = True, by: str | None = None):
        get_case(case_id)
        return E().audit(case_id, correct, by=clean_name(by, "supervisor"))

    @app.get("/api/cases/{case_id}/export.xlsx")
    def export_xlsx(case_id: str):
        c = get_case(case_id)
        data = reports.case_workbook(c, E().trail.entries(case_id))
        return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition": f'attachment; filename="{case_id}.xlsx"'})

    @app.get("/api/cases/{case_id}/export.html")
    def export_html(case_id: str):
        c = get_case(case_id)
        p = reports.preview(reports.case_workbook(c, E().trail.entries(case_id)), c)
        return HTMLResponse(p["html"], headers={"X-Rendered-By": p["engine"]})

    @app.get("/api/approvals")
    def approvals():
        e = E()
        out = []
        for c in e.store.list_cases(500):
            if c.get("pending"):
                out.append({"case": e.summary(c), "pending": c["pending"], "facts": c["plan"]["facts"],
                            "decisions": c["decisions"], "scores": c.get("scores"), "text": c.get("text")})
        return out

    # ── supervisor ───────────────────────────────────────────────────────────
    @app.get("/api/supervisor")
    def supervisor():
        e = E()
        acts = []
        for aid, a in e.policy.actions.items():
            acts.append({"id": aid, "label": a.label, "alpha": a.alpha, "rung": a.rung, "moves_money": a.moves_money,
                         "reversible": a.reversible, "hedge_cap": a.hedge_cap, "policy_cap": a.policy_cap,
                         "thresholds": _jsonable(e.risk.table.get(aid, {})), "curve": e.risk.curves.get(aid, [])})
        routines = state["routines"].public()
        return {"actions": acts, "calibration": e.calibrator.metrics, "drift": e.drift_status,
                "drift_history": e.drift.history[-60:], "stats": e.stats(), "routines": routines,
                "policy_hash": e.policy.policy_hash()}

    @app.post("/api/supervisor/policy")
    def change_policy(body: PolicyChange):
        if body.action not in E().policy.actions:
            raise HTTPException(404, "unknown action")
        E().set_policy(body.action, body.alpha, body.rung, by=clean_name(body.by, "supervisor"))
        return supervisor()

    @app.post("/api/supervisor/recalibrate")
    def recalibrate():
        return E().recalibrate()

    @app.post("/api/supervisor/drift/inject")
    def inject_drift(n: int = 30):
        """Demo: feed the monitor low-confidence scores, as if a new kind of case started arriving."""
        e = E()
        import numpy as np
        for s in np.random.default_rng().uniform(0.35, 0.75, n):
            e.drift.observe(float(s))
        prev = e.drift_status["alarm"]
        e.drift_status = e.drift.check()
        if e.drift_status["alarm"] != prev:
            e.refit_thresholds()
            e.trail.append("-", "drift.alarm", "drift", e.drift_status)
        e.bus.publish("drift.alarm", status=e.drift_status)
        return e.drift_status

    @app.post("/api/supervisor/drift/clear")
    def clear_drift():
        e = E()
        e.drift.clear()
        e.drift_status = e.drift.check()
        e.refit_thresholds()
        e.trail.append("-", "drift.cleared", "human", {})
        e.bus.publish("drift.alarm", status=e.drift_status)
        return e.drift_status

    @app.post("/api/routines/{job_id}/run")
    async def run_routine(job_id: str):
        if not state["routines"].get(job_id):
            raise HTTPException(404, "unknown routine")
        return await state["routines"].run_job(job_id, manual=True)

    # ── trail, graph, memory, ledger ─────────────────────────────────────────
    @app.get("/api/trail")
    def trail(limit: int = 300):
        return E().trail.entries(limit=limit)

    @app.get("/api/trail/verify")
    def verify(tamper_seq: int | None = None):
        return E().trail.verify(tamper_seq)

    @app.get("/api/graph")
    def graph():
        return {"nodes": E().graph.nodes(), "edges": E().graph.edges()}

    @app.get("/api/graph/search")
    def graph_search(q: str):
        return E().graph.search(q)

    @app.get("/api/graph/node/{node_id:path}")
    def graph_node(node_id: str):
        return E().graph.neighbors(node_id)

    @app.get("/api/memory/search")
    def memory_search(q: str, intent: str | None = None):
        return E().memory.search(q, intent, k=10)

    @app.get("/api/ledger")
    def ledger():
        e = E()
        tok = lambda v: e.tok.tokenise(v)[0]
        txns = []
        for t in e.rails.state["txns"].values():
            txns.append({"id": t["id"], "customer_id": t["customer_id"], "account": tok(t["account_id"]),
                         "amount": t["amount"], "merchant": tok(t["merchant"]) if "@" in t["merchant"] else t["merchant"],
                         "utr": t["utr"], "npci_status": t["npci_status"], "debit_status": t["debit_status"],
                         "reversal": t["reversal"]["status"], "refund": t["refund"]["status"],
                         "dispute": (t.get("dispute") or {}).get("status"), "version": t["version"],
                         "created_at": t["created_at"], "can": e.rails.natural_event(t["id"])})
        accts = [{"account": tok(a["id"]), "customer_id": a["customer_id"], "balance": a["balance"],
                  "version": a["version"]} for a in e.rails.state["accounts"].values()]
        return {"transactions": txns, "accounts": accts, "wallet_credits": e.rails.state["wallet_credits"],
                "disputes": e.rails.state["disputes"], "blocks": e.rails.state["blocks"],
                "down": e.rails.state.get("down", [])}

    @app.post("/api/sim/rail-event")
    def rail_event(body: RailEvent):
        """An outside event lands on a payment. event "auto" picks the one that can really happen to it."""
        e = E()
        if body.txn_id not in e.rails.state["txns"]:
            raise HTTPException(400, f"no transaction {body.txn_id}")
        event = e.rails.natural_event(body.txn_id) if body.event == "auto" else body.event
        if not event:
            raise HTTPException(400, f"{body.txn_id} is already reversed or refunded; nothing more can land on it")
        try:
            snap = e.rails.outside_event(body.txn_id, event)
        except (KeyError, ValueError) as ex:
            raise HTTPException(400, str(ex))
        e.trail.append("-", "rail.event", "outside", {"txn_id": body.txn_id, "event": event})
        e.bus.publish("rail.event", txn_id=body.txn_id, event=event, version=snap["version"])
        return {"version": snap["version"], "event": event}

    @app.post("/api/sim/outage")
    def outage(system: str, down: bool = True):
        E().rails.set_down(system, down)
        if not down:
            E().gateway.reset_breakers()
        E().bus.publish("rail.outage", system=system, down=down)
        return {"down": E().rails.state["down"]}

    @app.post("/api/sim/reset")
    def reset_world():
        E().rails.reset()
        E().gateway.reset_breakers()
        E().bus.publish("rail.reset")
        return {"ok": True}

    @app.post("/api/system/restart")
    async def restart():
        """Simulate a crash: drop in-flight work and everything in memory, then resume from checkpoints."""
        old = E()
        for t in list(old.tasks.values()):
            t.cancel()
        fresh = Engine(old.store, step_delay=old.step_delay, llm=old.llm, calibrator=old.calibrator)
        fresh.bus = old.bus
        fresh.gateway.bus = old.bus
        state["engine"] = fresh
        state["routines"].engine = fresh
        resumed = await fresh.recover()
        fresh.bus.publish("system.restarted", resumed=resumed)
        return {"resumed": resumed, "parked": [c["id"] for c in fresh.store.list_cases(500) if c.get("pending")]}

    # ── benchmark & agents ───────────────────────────────────────────────────
    @app.post("/api/benchmark/run")
    async def run_benchmark(k: int = 3, label: str = ""):
        return await benchmark.run(E(), k=max(1, min(3, k)), label=label)

    @app.get("/api/benchmark/runs")
    def benchmark_runs():
        return benchmark.history(E().store)

    @app.post("/api/agents/{agent_id}/ask")
    async def ask_agent(agent_id: str, body: Ask):
        if agent_id not in E().roster.agents:
            raise HTTPException(404, "unknown agent")
        return await office.answer(E(), agent_id, body.question)

    @app.post("/api/evidence/parse")
    async def parse_evidence(file: UploadFile = File(...)):
        suffix = Path(file.filename or "upload.bin").suffix
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(await file.read())
        try:
            return docparse.parse(Path(tmp.name), E().tok.tokenise)
        finally:
            os.unlink(tmp.name)

    # ── MCP: Nirnaya as a tool server for other agents ───────────────────────
    MCP_TOOLS = {
        "upi_status": ("Final status of a UPI payment at the switch", "upi.status"),
        "bank_debit_status": ("Whether the account was debited, and any reversal", "bank.debit_status"),
        "refund_status": ("Merchant refund status and ARN", "refund.status"),
        "crm_profile": ("Customer history relevant to risk", "crm.profile"),
        "graph_search": ("Search the context graph (customers, transactions, merchants, cases, policies)", None),
        "memory_search": ("Search resolved cases, with what held and whether the ground moved", None),
        "score_action": ("Confidence Layer: calibrated score and certified route for a proposed action", None),
        "submit_case": ("Open a Nirnaya case from a customer message", None),
        "case_status": ("Current status, route and reply of a case", None),
    }
    SCHEMAS = {
        "graph_search": {"q": {"type": "string"}},
        "memory_search": {"q": {"type": "string"}, "intent": {"type": "string"}},
        "score_action": {"action": {"type": "string"}, "amount": {"type": "number"},
                         "intent_conf": {"type": "number"}, "evidence_agree": {"type": "number"},
                         "sentry_risk": {"type": "number"}},
        "submit_case": {"customer_id": {"type": "string"}, "message": {"type": "string"},
                        "channel": {"type": "string"}},
        "case_status": {"case_id": {"type": "string"}},
    }
    REQUIRED = {"graph_search": ["q"], "memory_search": ["q"], "score_action": ["action", "amount"],
                "submit_case": ["customer_id", "message"], "case_status": ["case_id"]}

    def _mcp_schema(name: str) -> dict:
        e = E()
        if name in SCHEMAS:
            return {"type": "object", "properties": SCHEMAS[name], "required": REQUIRED[name]}
        return e.gateway.tools[MCP_TOOLS[name][1]].schema

    async def _mcp_call(name: str, args: dict) -> dict:
        e = E()
        if name not in MCP_TOOLS:
            raise ValueError(f"unknown tool {name}")
        gw_name = MCP_TOOLS[name][1]
        if gw_name:
            return e.gateway.read(gw_name, agent="mcp", **args)
        if name == "graph_search":
            return {"nodes": e.graph.search(args["q"])}
        if name == "memory_search":
            return {"hits": e.memory.search(args["q"], args.get("intent"))}
        if name == "score_action":
            from .calibration import log_amount
            feats = {"intent_conf": float(args.get("intent_conf", 0.8)),
                     "evidence_agree": float(args.get("evidence_agree", 1.0)),
                     "log_amount": log_amount(float(args["amount"])), "prior_disputes": 0.0, "memory_support": 0.5,
                     "sentry_risk": float(args.get("sentry_risk", 0.05)), "novelty": 0.0, "voice": 0.0}
            a = {"type": args["action"], "amount": float(args["amount"])}
            if a["type"] not in e.policy.actions:
                raise ValueError(f"unknown action {a['type']}")
            s = e.calibrator.score(feats, a["type"])
            th = e.risk.thresholds(a["type"], a["amount"])
            route, why = e._route_one({"sentry": {"verdict": "pass"}}, a, s["calibrated"], th)
            return {**s, "route": route, "why": why, "band": th["band"], "alpha": th["alpha"]}
        if name == "submit_case":
            c = e.create_case(args["customer_id"], args["message"], args.get("channel", "api"))
            e.start(c["id"])
            return e.summary(c)
        if name == "case_status":
            c = e.store.get_case(args["case_id"])
            if not c:
                raise ValueError("no such case")
            last = next((m["text"] for m in reversed(c["conversation"]) if m["role"] == "nirnaya"), None)
            return {**e.summary(c), "reply": last}
        raise ValueError(name)

    @app.post("/mcp")
    async def mcp(request: Request):
        msg = await request.json()
        if "id" not in msg:
            return Response(status_code=202)
        mid, method, params = msg["id"], msg.get("method"), msg.get("params") or {}

        def ok(result):
            return JSONResponse({"jsonrpc": "2.0", "id": mid, "result": result})

        if method == "initialize":
            return ok({"protocolVersion": params.get("protocolVersion", "2025-06-18"),
                       "capabilities": {"tools": {"listChanged": False}},
                       "serverInfo": {"name": "nirnaya", "version": __version__}})
        if method == "ping":
            return ok({})
        if method == "tools/list":
            return ok({"tools": [{"name": n, "description": d, "inputSchema": _mcp_schema(n)}
                                 for n, (d, _) in MCP_TOOLS.items()]})
        if method == "tools/call":
            try:
                out = await _mcp_call(params.get("name"), params.get("arguments") or {})
                return ok({"content": [{"type": "text", "text": json.dumps(out, default=str)}],
                           "structuredContent": out, "isError": False})
            except Exception as ex:
                return ok({"content": [{"type": "text", "text": str(ex)}], "isError": True})
        return JSONResponse({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found"}})

    # ── the office ───────────────────────────────────────────────────────────
    office.register(app, E, lambda: state["routines"], lambda: state["ops"], lambda: state["team"],
                    lambda: state["flows"])
    flows.register(app, E, lambda: state["flows"])
    channels.register(app, E, lambda: state["channels"])

    # ── the web app ──────────────────────────────────────────────────────────
    if WEB_DIST.exists():
        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            f = WEB_DIST / path
            if path and f.is_file():
                return FileResponse(f)
            return FileResponse(WEB_DIST / "index.html")

    return app


def _jsonable(v):
    if isinstance(v, float) and (v == float("inf")):
        return None
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    return v
