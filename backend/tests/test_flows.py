"""Flows (drawn on the canvas, run by the agents) and the team (who is here, the shared chat, names on actions)."""
import time

import pytest
from fastapi.testclient import TestClient

from nirnaya.api import create_app
from nirnaya.flows import check, fill


@pytest.fixture
def client(engine):
    app = create_app(engine, background=False)
    with TestClient(app) as c:
        yield c


def node(i, t, x=0, **cfg):
    return {"id": i, "type": t, "x": x, "y": 0, "config": cfg}


def wire(a, b, port="next"):
    return {"from": a, "to": b, "port": port}


def wait_run(client, rid, states=("done", "failed", "stopped"), timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = next((r for r in client.get("/api/flows").json()["runs"] if r["id"] == rid), None)
        if r and r["state"] in states:
            return r
        time.sleep(0.05)
    raise AssertionError(f"{rid} never reached {states}")


def test_examples_are_there_and_valid(client):
    d = client.get("/api/flows").json()
    names = [f["name"] for f in d["flows"]]
    assert {"Morning audit check", "Duplicate-charge drill", "Model health"} <= set(names)
    morning = next(f for f in d["flows"] if f["name"] == "Morning audit check")
    assert morning["when"] == {"kind": "weekdays", "at": "09:00"} and morning["next_at"]
    assert set(d["types"]) == {"start", "case", "task", "if", "approval", "notify", "wait"}


def test_a_bad_flow_is_refused_with_a_reason(client):
    bad = [
        ({"name": "x", "nodes": [node("a", "task", dept="oversight", text="verify the trail")]}, "Start"),
        ({"name": "x", "nodes": [node("s", "start"), node("t", "task", dept="oversight", text="verify the trail")],
          "edges": [wire("s", "t"), wire("t", "s")]}, "into Start"),
        ({"name": "x", "nodes": [node("s", "start"), node("a", "wait", seconds=1), node("b", "wait", seconds=1)],
          "edges": [wire("s", "a"), wire("a", "b"), wire("b", "a")]}, "loop"),
        ({"name": "x", "nodes": [node("s", "start"), node("t", "task", dept="oversight", text="make me a sandwich")],
          "edges": [wire("s", "t")]}, "doesn't know"),
        ({"name": "x", "nodes": [node("s", "start"), node("t", "task", dept="intake", text="hello")],
          "edges": [wire("s", "t")]}, "Customer message"),
        ({"name": "x", "nodes": [node("s", "start", when="whenever you like")]}, "schedule"),
        ({"name": "x", "nodes": [node("s", "start"), node("c", "case", customer_id="C-9999", message="hi")],
          "edges": [wire("s", "c")]}, "unknown customer"),
    ]
    for body, why in bad:
        r = client.post("/api/flows", json=body)
        assert r.status_code == 400 and why in r.json()["detail"], (why, r.json())


def test_a_flow_runs_through_the_agents_and_branches(client, engine):
    body = {"name": "Trail then tell", "by": "Asha", "nodes": [
        node("s", "start"),
        node("t", "task", dept="oversight", text="Verify the audit trail"),
        node("c", "if", field="ok", op="is", value="true"),
        node("y", "notify", dept="oversight", text="Trail says: {result}"),
        node("n", "notify", dept="oversight", text="Trail broken"),
    ], "edges": [wire("s", "t"), wire("t", "c"), wire("c", "y", "yes"), wire("c", "n", "no")]}
    f = client.post("/api/flows", json=body).json()
    assert f["by"] == "Asha" and f["version"] == 1
    run = client.post(f"/api/flows/{f['id']}/run", json={"by": "Asha"}).json()
    done = wait_run(client, run["id"])
    assert done["state"] == "done" and done["progress"] == 1.0
    st = {k: v["state"] for k, v in done["nodes"].items()}
    assert st == {"s": "done", "t": "done", "c": "done", "y": "done", "n": "skipped"}
    assert "Chain intact" in done["nodes"]["t"]["text"]
    # the department really did it: an op on the office board, by the flow
    op = next(o for o in client.get("/api/office").json()["ops"] if o["id"] == done["nodes"]["t"]["out"]["op_id"])
    assert op["agent"] == "trail" and op["by"] == "flow · Trail then tell" and op["ok"]
    # and the note is in the Oversight lead's chat, for the whole team
    chat = client.get("/api/office/chats").json()["human"]
    assert any(m["text"].startswith("Trail says: Chain intact") for m in chat)
    kinds = [e["kind"] for e in engine.bus.history]
    assert "flow.run" in kinds and "chat.message" in kinds


def test_a_customer_message_node_waits_for_the_case(client):
    body = {"name": "Drill", "nodes": [
        node("s", "start"), node("m", "case", customer_id="C-1002", message="I was charged twice for ₹349 at CafeBrew"),
        node("c", "if", field="route", op="is not", value="ESCALATE"), node("y", "wait", seconds=0),
    ], "edges": [wire("s", "m"), wire("m", "c"), wire("c", "y", "yes")]}
    f = client.post("/api/flows", json=body).json()
    done = wait_run(client, client.post(f"/api/flows/{f['id']}/run", json={}).json()["id"])
    out = done["nodes"]["m"]["out"]
    assert out["case_id"].startswith("NR-") and out["status"] == "resolved" and out["route"] == "HEDGE"
    assert done["nodes"]["y"]["state"] == "done"
    case = client.get(f"/api/cases/{out['case_id']}").json()
    assert case["opened_by"] == "flow · Drill"


def test_ask_a_person_waits_then_goes_the_way_they_said(client):
    body = {"name": "Gate", "nodes": [node("s", "start"), node("a", "approval", question="Go?"),
                                      node("y", "wait", seconds=0), node("n", "wait", seconds=0)],
            "edges": [wire("s", "a"), wire("a", "y", "yes"), wire("a", "n", "no")]}
    f = client.post("/api/flows", json=body).json()
    run = client.post(f"/api/flows/{f['id']}/run", json={"by": "Ravi"}).json()
    waiting = wait_run(client, run["id"], states=("waiting",))
    assert waiting["nodes"]["a"]["state"] == "waiting"
    assert client.get("/api/office").json()["flow_waits"][0]["question"] == "Go?"
    assert client.post(f"/api/flows/runs/{run['id']}/decide", json={"node": "s", "approve": True}).status_code == 409
    client.post(f"/api/flows/runs/{run['id']}/decide", json={"node": "a", "approve": False, "by": "Asha", "note": "not today"})
    done = wait_run(client, run["id"])
    assert done["nodes"]["n"]["state"] == "done" and done["nodes"]["y"]["state"] == "skipped"
    assert "Asha said no" in done["nodes"]["a"]["text"]


def test_a_stale_save_is_refused(client):
    f = client.post("/api/flows", json={"name": "Mine", "nodes": [node("s", "start")], "by": "Asha"}).json()
    ok = client.put(f"/api/flows/{f['id']}", json={"name": "Mine v2", "nodes": [node("s", "start")], "by": "Asha",
                                                   "version": f["version"]})
    assert ok.status_code == 200 and ok.json()["version"] == 2
    stale = client.put(f"/api/flows/{f['id']}", json={"name": "Ravi's", "nodes": [node("s", "start")], "by": "Ravi",
                                                      "version": f["version"]})
    assert stale.status_code == 409 and "Asha saved a newer version" in stale.json()["detail"]


def test_stop_a_run(client):
    f = client.post("/api/flows", json={"name": "Slow", "nodes": [node("s", "start"), node("w", "wait", seconds=30)],
                                        "edges": [wire("s", "w")]}).json()
    run = client.post(f"/api/flows/{f['id']}/run", json={}).json()
    wait_run(client, run["id"], states=("running",))
    client.post(f"/api/flows/runs/{run['id']}/stop", json={"by": "Asha"})
    assert wait_run(client, run["id"])["state"] == "stopped"


def test_checks_and_fill():
    assert check({"field": "ok", "op": "is", "value": "true"}, {"ok": True})
    assert check({"field": "route", "op": "is not", "value": "ESCALATE"}, {"route": "HEDGE"})
    assert check({"field": "amount", "op": ">", "value": "₹1,000"}, {"amount": 18500})
    assert not check({"field": "result", "op": "contains", "value": "broken"}, {"result": "Chain intact"})
    assert fill("{case} went {route}", {"case_id": "NR-1", "route": "ACT"}, {}) == "NR-1 went ACT"
    # an amount compares as a number whichever way it is written, and stored as a float
    assert check({"field": "amount", "op": "is", "value": "₹349"}, {"amount": 349.0})
    assert check({"field": "amount", "op": "is not", "value": "350"}, {"amount": 349.0})
    assert check({"field": "amount", "op": "<", "value": "1,000"}, {"amount": 349.0})
    assert not check({"field": "amount", "op": "is", "value": "lots"}, {"amount": 349.0})
    assert check({"field": "ok", "op": "is not", "value": "true"}, {"ok": False})
    assert check({"field": "status", "op": "is", "value": "Resolved"}, {"status": "resolved"})
    assert check({"field": "result", "op": "contains", "value": "intact"}, {"result": "Chain intact"})


def test_a_check_only_offers_what_makes_sense_for_its_field(client):
    d = client.get("/api/flows").json()
    assert d["ops_for"]["route"] == ["is", "is not"] and "contains" in d["ops_for"]["result"] and ">" in d["ops_for"]["amount"]
    for field, op, value in [("route", ">", "ACT"), ("ok", "contains", "true"), ("status", "<", "x"), ("amount", "contains", "3")]:
        r = client.post("/api/flows", json={"name": "Odd", "nodes": [node("s", "start"), node("c", "if", field=field, op=op, value=value)],
                                            "edges": [wire("s", "c")]})
        assert r.status_code == 400 and "pick what to check and how" in r.json()["detail"], (field, op)
    r = client.post("/api/flows", json={"name": "Empty", "nodes": [node("s", "start"), node("c", "if", field="result", op="contains", value=" ")],
                                        "edges": [wire("s", "c")]})
    assert r.status_code == 400 and "compare with" in r.json()["detail"]


def test_the_team_sees_names_and_one_chat(client, engine):
    c = client.post("/api/cases", json={"customer_id": "C-1003", "by": "Asha",
                                        "message": "There is a transaction of ₹18,500 at QuickPay Store that was not done by me"}).json()
    assert c["opened_by"] == "Asha"
    t0 = time.time()
    while not client.get(f"/api/cases/{c['id']}").json().get("pending") and time.time() - t0 < 10:
        time.sleep(0.05)
    client.post(f"/api/cases/{c['id']}/approve", json={"by": "Ravi"})
    trail = [t for t in client.get(f"/api/cases/{c['id']}").json()["trail"] if t["kind"] == "approval.granted"]
    assert trail[0]["actor"] == "Ravi"
    chats = client.get("/api/office/chats").json()
    assert any("Ravi approved " + c["id"] in m["text"] for m in chats["fraud"])
    r = client.post("/api/office/chat", json={"agent": "triage", "text": "What are you working on?", "by": "Asha"}).json()
    msgs = client.get("/api/office/chats").json()["triage"]
    assert msgs[-2]["who"] == "user" and msgs[-2]["by"] == "Asha" and msgs[-1]["text"] == r["reply"]
    op = client.post("/api/office/tasks", json={"dept": "oversight", "text": "verify the audit trail", "by": "Ravi"}).json()["op"]
    assert op["by"] == "Ravi"


def test_presence(engine):
    from nirnaya.team import Team
    t = Team(lambda: engine)
    t.join("a1", "Asha", "office")
    t.join("r1", "Ravi <script>", "approvals")
    t.join("a1", "Asha", "office")  # a second tab
    names = [p["name"] for p in t.online()]
    assert names == ["Asha", "Ravi script"]
    t.update("r1", view="flows", focus="Morning audit check")
    assert next(p for p in t.online() if p["client"] == "r1")["view"] == "flows"
    t.leave("a1")
    assert len(t.online()) == 2  # one of Asha's tabs is still open
    t.leave("a1")
    assert [p["name"] for p in t.online()] == ["Ravi script"]
    last = [e for e in engine.bus.subscribers] or [None]
    assert all(e["kind"] != "presence" for e in engine.bus.history)  # who is online is not history
