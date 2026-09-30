import time

import pytest
from fastapi.testclient import TestClient

from nirnaya.api import create_app


@pytest.fixture
def client(engine):
    app = create_app(engine, background=False)
    with TestClient(app) as c:
        yield c


def wait_done(client, case_id, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        c = client.get(f"/api/cases/{case_id}").json()
        if c["status"] != "running":
            return c
        time.sleep(0.05)
    raise AssertionError("case did not finish")


def test_health_and_state(client):
    h = client.get("/api/health").json()
    assert h["ok"] and len(h["policy_hash"]) == 16
    s = client.get("/api/state").json()
    assert len(s["agents"]) == 19 and len(s["departments"]) == 6 and len(s["presets"]) >= 10
    assert any(t["name"] == "bank.reverse" and t["moves_money"] for t in s["tools"])


def test_case_lifecycle_over_http(client):
    r = client.post("/api/cases", json={"customer_id": "C-1003",
                                        "message": "There is a transaction of ₹18,500 at QuickPay Store that was not done by me"})
    assert r.status_code == 201
    cid = r.json()["id"]
    c = wait_done(client, cid)
    assert c["status"] == "parked" and c["trail"] and c["checkpoints"]
    ap = client.get("/api/approvals").json()
    assert ap and ap[0]["case"]["id"] == cid and ap[0]["pending"]["seal"]
    done = client.post(f"/api/cases/{cid}/approve", json={"by": "tester"}).json()
    assert done["status"] == "resolved"
    x = client.get(f"/api/cases/{cid}/export.xlsx")
    assert x.status_code == 200 and x.content[:2] == b"PK"
    assert client.get(f"/api/cases/{cid}/export.html").status_code == 200
    assert client.post(f"/api/cases/{cid}/approve", json={}).status_code == 409


def test_supervisor_policy_and_verify(client):
    s = client.get("/api/supervisor").json()
    assert s["calibration"]["ece_calibrated"] < s["calibration"]["ece_stated"]
    rev = next(a for a in s["actions"] if a["id"] == "reverse_failed_debit")
    assert rev["thresholds"]["large"]["act"]["lambda"] is None      # large reversals never run alone
    s2 = client.post("/api/supervisor/policy", json={"action": "raise_dispute", "rung": 0}).json()
    assert next(a for a in s2["actions"] if a["id"] == "raise_dispute")["rung"] == 0
    assert s2["policy_hash"] != s["policy_hash"]
    assert client.get("/api/trail/verify").json()["ok"]


def test_bad_input_is_rejected(client):
    assert client.post("/api/cases", json={"customer_id": "nobody", "message": "hi"}).status_code == 400
    assert client.post("/api/cases", json={"customer_id": "C-1001", "message": ""}).status_code == 422


def test_mcp_server(client):
    rpc = lambda method, params=None, i=1: client.post("/mcp", json={"jsonrpc": "2.0", "id": i, "method": method,
                                                                      "params": params or {}}).json()
    init = rpc("initialize", {"protocolVersion": "2025-06-18"})
    assert init["result"]["serverInfo"]["name"] == "nirnaya"
    names = {t["name"] for t in rpc("tools/list")["result"]["tools"]}
    assert {"upi_status", "score_action", "submit_case", "case_status"} <= names
    st = rpc("tools/call", {"name": "upi_status", "arguments": {"txn_id": "T-5001"}})["result"]
    assert not st["isError"] and st["structuredContent"]["npci_status"] == "FAILED"
    sc = rpc("tools/call", {"name": "score_action", "arguments": {"action": "chargeback_credit", "amount": 18500}})
    assert sc["result"]["structuredContent"]["route"] == "ESCALATE"
    sub = rpc("tools/call", {"name": "submit_case", "arguments": {"customer_id": "C-1004",
                                                                  "message": "what is my balance"}})
    cid = sub["result"]["structuredContent"]["id"]
    wait_done(client, cid)
    status = rpc("tools/call", {"name": "case_status", "arguments": {"case_id": cid}})["result"]["structuredContent"]
    assert status["status"] == "resolved" and "balance" in status["reply"]
    assert client.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}).status_code == 202
    assert "error" in rpc("nope")


def test_restart_endpoint_keeps_parked_cases(client):
    cid = client.post("/api/cases", json={"customer_id": "C-1003",
                                          "message": "There is a transaction of ₹18,500 at QuickPay Store that was not done by me"}).json()["id"]
    wait_done(client, cid)
    r = client.post("/api/system/restart").json()
    assert cid in r["parked"]
    assert client.post(f"/api/cases/{cid}/approve", json={"by": "after restart"}).json()["status"] == "resolved"


def test_agent_ask_and_graph_and_memory(client):
    cid = client.post("/api/cases", json={"customer_id": "C-1004", "message": "what is my balance"}).json()["id"]
    wait_done(client, cid)
    a = client.post("/api/agents/sentry/ask", json={"question": "what did you do?"}).json()
    assert "Sentry" in a["answer"]
    assert client.get("/api/graph").json()["nodes"]
    assert client.get("/api/graph/node/customer:C-1004").json()["edges"]
    assert client.get("/api/memory/search", params={"q": "failed upi debited"}).json()
    assert client.get("/api/ledger").json()["transactions"]
