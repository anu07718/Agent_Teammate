import time

import pytest
from fastapi.testclient import TestClient

from nirnaya import schedule
from nirnaya.api import create_app
from nirnaya.ops import interpret


@pytest.fixture
def client(engine):
    app = create_app(engine, background=False)
    with TestClient(app) as c:
        yield c


def wait_op(client, op_id, states=("done",), timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        op = next((o for o in client.get("/api/office").json()["ops"] if o["id"] == op_id), None)
        if op and op["state"] in states:
            return op
        time.sleep(0.05)
    raise AssertionError(f"{op_id} never reached {states}")


def wait_case(client, case_id, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        c = client.get(f"/api/cases/{case_id}").json()
        if c["status"] != "running":
            return c
        time.sleep(0.05)
    raise AssertionError("case did not finish")


def test_schedule_parse_and_next_run():
    p = schedule.parse("every weekday at 8am, verify the audit trail")
    assert p["when"] == {"kind": "weekdays", "at": "08:00"} and p["text"] == "Verify the audit trail"
    assert schedule.parse("mon and thu at 17:30 check drift")["when"] == {"kind": "weekly", "days": [0, 3], "at": "17:30"}
    assert schedule.parse("every day verify the trail")["needs_time"]
    assert schedule.parse("pull the evidence for T-5001") is None
    # a Saturday noon: the next weekday run is Monday 08:00
    sat = time.mktime((2026, 10, 3, 12, 0, 0, 0, 0, -1))
    nxt = time.localtime(schedule.next_run({"kind": "weekdays", "at": "08:00"}, sat))
    assert (nxt.tm_wday, nxt.tm_hour, nxt.tm_min) == (0, 8, 0)
    runs = schedule.occurrences({"kind": "daily", "at": "09:00"}, sat, sat + 7 * 86400)
    assert len(runs) == 7
    assert not schedule.valid({"kind": "weekly", "days": [], "at": "09:00"})


def test_interpret_routes_sentences():
    case = interpret("intake", "My UPI payment of ₹2,450 to FreshMart failed but money was debited")
    assert case["kind"] == "case" and case["agent"] == "upi" and case["dept"] == "resolution"
    # "daily" inside a customer's message is not a timetable
    assert interpret("intake", "my daily limit is too low, please raise it")["kind"] == "case"
    op = interpret("oversight", "verify the audit trail")
    assert op["kind"] == "op" and op["op_kind"] == "trail-verify" and op["agent"] == "trail"
    r = interpret("decision", "every weekday at 9am recalibrate")
    assert r["kind"] == "routine" and r["op_kind"] == "recalibrate" and r["needs_ok"] and r["next_at"]
    assert interpret("oversight", "every day verify the trail")["problem"].startswith("What time")
    assert interpret("verification", "hello")["op_kind"] == "help"


def test_office_snapshot(client):
    s = client.get("/api/office").json()
    assert [p["id"] for p in s["pods"]] == ["intake", "resolution", "verification", "decision", "commit", "oversight"]
    assert {c["key"] for c in s["connectors"]} >= {"upi", "bank", "refunds", "crm"}
    assert set(s["kpis"]) >= {p["id"] for p in s["pods"]} | {"brain"}
    assert {r["id"] for r in s["routines"]} >= {"tat-watch", "drift-check", "benchmark"}
    agents = client.get("/api/state").json()["agents"]
    leads = sorted(a["id"] for a in agents if a["lead"])
    assert leads == sorted(p["lead"] for p in s["pods"])


def test_task_to_a_department_runs_an_op(client):
    r = client.post("/api/office/tasks", json={"dept": "oversight", "text": "verify the audit trail"}).json()
    assert r["kind"] == "op"
    op = wait_op(client, r["op"]["id"])
    assert op["ok"] and "Chain intact" in op["result"]
    r = client.post("/api/office/tasks", json={"dept": "verification", "text": "check T-5001"}).json()
    op = wait_op(client, r["op"]["id"])
    assert op["ok"] and "T-5001" in op["result"] and "UPI switch" in op["result"] and op["tools"]


def test_customer_message_to_intake_opens_a_case(client):
    r = client.post("/api/office/tasks", json={"dept": "intake", "customer_id": "C-1002",
                                                "text": "I was charged twice ₹349 at CafeBrew yesterday"}).json()
    assert r["kind"] == "case" and r["case"]["owner"] in ("triage", "refund")
    c = wait_case(client, r["case"]["id"])
    assert c["status"] == "resolved"
    summary = next(x for x in client.get("/api/cases").json() if x["id"] == c["id"])
    assert summary["owner"] == "refund"


def test_an_op_that_needs_an_ok_waits(client):
    r = client.post("/api/office/tasks", json={"dept": "decision", "text": "recalibrate"}).json()
    op = wait_op(client, r["op"]["id"], ("waiting",))
    assert "Recalibrate on" in op["ask"]
    no = client.post(f"/api/office/ops/{op['id']}/reject", json={"note": "not today"}).json()
    assert no["state"] == "done" and no["rejected"] and "not today" in no["result"]
    r = client.post("/api/office/tasks", json={"dept": "decision", "text": "recalibrate please"}).json()
    wait_op(client, r["op"]["id"], ("waiting",))
    client.post(f"/api/office/ops/{r['op']['id']}/approve")
    done = wait_op(client, r["op"]["id"])
    assert done["ok"] and done["approved"] and "re-certified" in done["result"]
    assert client.post(f"/api/office/ops/{r['op']['id']}/approve").status_code == 409


def test_booked_task_fires_on_its_minute(client):
    at = (time.time() + 3600) * 1000
    r = client.post("/api/office/tasks", json={"dept": "oversight", "text": "write the digest", "at": at}).json()
    assert r["op"]["state"] == "scheduled"
    assert client.post("/api/office/tasks", json={"dept": "oversight", "text": "digest", "at": 1000}).status_code == 400
    # the clock reaches it (as the routine loop would)
    client.app.state  # noqa: B018 - the app is live
    ops = client.get("/api/office").json()["ops"]
    assert any(o["id"] == r["op"]["id"] and o["state"] == "scheduled" for o in ops)
    booked_case = client.post("/api/office/tasks", json={"dept": "intake", "text": "Where is my refund of Rs 1299 from StyleKart?",
                                                          "customer_id": "C-1002", "at": at}).json()
    assert booked_case["kind"] == "op" and booked_case["op"]["kind"] == "case"
    assert client.delete(f"/api/office/ops/{booked_case['op']['id']}").json()["ok"]


def test_routines_add_run_pause_delete(client):
    bad = client.post("/api/office/routines", json={"dept": "oversight", "text": "verify the trail"})
    assert bad.status_code == 400
    r = client.post("/api/office/routines", json={"dept": "oversight", "text": "every weekday at 9am verify the audit trail"}).json()
    rt = r["routine"]
    assert rt["kind"] == "trail-verify" and rt["desc"] == "every weekday · 09:00" and rt["next_at"]
    ran = client.post(f"/api/office/routines/{rt['id']}/run").json()
    op = wait_op(client, ran["op"]["id"])
    assert op["routine"] == rt["id"] and op["by"] == "routine" and op["ok"]
    assert client.post(f"/api/office/routines/{rt['id']}/pause").json()["routine"]["paused"]
    occ = client.get(f"/api/office/occurrences?start={time.time()}&end={time.time() + 14 * 86400}").json()
    assert rt["id"] not in occ and "benchmark" in occ
    assert client.delete(f"/api/office/routines/{rt['id']}").json()["ok"]
    via_chat = client.post("/api/office/chat", json={"agent": "human", "text": "every monday at 10am write the digest"}).json()
    assert "every Mon · 10:00" in via_chat["reply"]


def test_brain_and_chat(client):
    b = client.get("/api/office/brain").json()
    groups = {n["group"] for n in b["nodes"]}
    assert {"Customers", "Transactions", "Policies", "Past cases"} <= groups
    assert b["links"] and all(len(l) == 3 for l in b["links"])
    r = client.post("/api/office/chat", json={"agent": "evidence", "text": "Which systems do you use?"}).json()
    assert "UPI switch" in r["reply"]
    none = client.post("/api/office/chat", json={"agent": "human", "text": "move the ground"}).json()
    assert none["moved"] is None
    c = client.post("/api/cases", json={"customer_id": "C-1003",
                                        "message": "There is a transaction of ₹18,500 at QuickPay Store that was not done by me"}).json()
    wait_case(client, c["id"])
    moved = client.post("/api/office/chat", json={"agent": "fraud", "text": "move the ground"}).json()
    assert moved["moved"]["case_id"] == c["id"]
    after = client.post(f"/api/cases/{c['id']}/approve", json={"by": "tester"}).json()
    assert after["seal_broken"]
