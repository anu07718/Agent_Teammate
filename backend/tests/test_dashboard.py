"""The dashboard: accepted / rejected / waiting for a person, the agents on each case, and the tokens the model
used (the provider's own count when it sends one, an estimate when not), each credited to its case or task,
priced at the saved rates. Intake reads back a sentence's tokens as you type."""
import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from nirnaya import usage
from nirnaya.api import create_app
from nirnaya.engine import Engine
from test_llm import EXTRACT, Fake, model_on

REPLY = "Hi Meera, we have refunded ₹349 for the double charge at CafeBrew."


@pytest.fixture
def fake():
    f = Fake()
    yield f
    f.server.shutdown()


def wait(client, case_id, timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        c = client.get(f"/api/cases/{case_id}").json()
        if c["status"] != "running":
            return c
        time.sleep(0.05)
    raise AssertionError("case did not finish")


def test_estimate_counts_like_a_qwen_tokenizer_roughly():
    assert usage.estimate("") == 0
    assert usage.estimate("pay") == 1
    assert usage.estimate("500") == 3                       # Qwen splits numbers into digits
    assert usage.estimate("pay ₹500 to anushka for dinner") == 9   # pay ₹ 5 0 0 to anushka for dinner
    assert usage.estimate("transactions") == 2              # a long word is a few pieces
    assert usage.estimate("पैसा कट गया") >= 4                # Devanagari: about one per two letters
    long = "My UPI payment of ₹2,450 to FreshMart failed 3 days ago but the money was debited"
    assert 20 <= usage.estimate(long) <= 40


def test_the_providers_own_count_is_used_and_credited_to_the_case(fake, store, calibrator):
    fake.usage = {"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150}
    fake.behaviour["ollama"] = [("ok", EXTRACT), ("ok", REPLY)]
    e = Engine(store, step_delay=0, llm=model_on(fake, "ollama", store=store), calibrator=calibrator)
    c = e.create_case("C-1002", "I was charged twice ₹349 at CafeBrew yesterday", "chat")
    c = asyncio.run(e.run(c["id"]))
    calls = len(fake.posts("ollama"))
    assert calls >= 2
    t = e.llm.meter.of(c["id"])
    assert t["calls"] == calls and t["in"] == 120 * calls and t["out"] == 30 * calls
    assert c["tokens"] == 150 * calls and e.summary(c)["tokens"] == 150 * calls
    assert {"read", "reply"} <= set(t["jobs"])
    s = e.llm.meter.summary()
    assert s["total"] == 150 * calls and s["estimated_calls"] == 0
    assert s["days"][-1]["total"] == 150 * calls and len(s["days"]) == 14
    # ₹15 per million in, ₹60 per million out by default
    assert s["cost"] == round((120 * calls * 15 + 30 * calls * 60) / 1e6, 4)
    assert s["model"] == {"name": "qwen3.6", "runtime": "Ollama", "price_in": 15.0, "price_out": 60.0}
    # the counts last: a new meter on the same store reads them back
    assert usage.Meter(store).summary()["total"] == 150 * calls


def test_without_a_count_the_tokens_are_estimated(fake, store, calibrator):
    fake.behaviour["groq"] = [("ok", EXTRACT), ("ok", REPLY)]
    e = Engine(store, step_delay=0, llm=model_on(fake, "groq", store=store), calibrator=calibrator)
    c = asyncio.run(e.run(e.create_case("C-1002", "I was charged twice ₹349 at CafeBrew yesterday", "chat")["id"]))
    s = e.llm.meter.summary()
    assert s["estimated_calls"] == s["calls"] >= 2 and s["in"] > 100 and s["out"] > 10
    assert c["tokens"] == s["total"]


def test_rules_only_uses_no_tokens(run_case, engine):
    c = asyncio.run(run_case("C-1002", "I was charged twice ₹349 at CafeBrew yesterday"))
    assert c["tokens"] == 0 and engine.llm.meter.summary()["total"] == 0


def test_dashboard_counts_outcomes_and_names_the_agents_on_a_case(engine):
    with TestClient(create_app(engine, background=False)) as client:
        post = lambda cust, msg: client.post("/api/cases", json={"customer_id": cust, "message": msg}).json()["id"]
        ok = post("C-1002", "I was charged twice ₹349 at CafeBrew yesterday")
        held = post("C-1003", "There is a transaction of ₹18,500 at QuickPay Store that was not done by me")
        refused = post("C-1002", "my otp is 482913 someone called asking for it")
        a, b, r = wait(client, ok), wait(client, held), wait(client, refused)
        assert (a["status"], b["status"], r["status"]) == ("resolved", "parked", "refused")
        d = client.get("/api/dashboard").json()
        assert {k: d["cases"][k] for k in ("total", "accepted", "rejected", "waiting")} == \
            {"total": 3, "accepted": 1, "rejected": 1, "waiting": 1}
        assert d["cases"]["how"] == {"resolved by the agents": 1, "sealed, waiting for a person": 1, "refused by the agents": 1}
        assert d["days"][-1] | {"day": 0} == {"day": 0, "accepted": 1, "rejected": 1, "waiting": 1, "running": 0}
        row = {i["id"]: i for i in d["items"]}
        assert row[held]["outcome"] == "waiting" and row[held]["agents"] >= 8 and row[refused]["outcome"] == "rejected"
        assert d["usage"]["model"]["name"] == "qwen3.6" and d["usage"]["total"] == 0
        it = client.get(f"/api/dashboard/item/{held}").json()
        names = {x["id"] for x in it["agents"]}
        assert {"pii", "sentry", "triage", "evidence", "router", "seal", "human"} <= names
        assert len(it["agents"]) == row[held]["agents"] and it["steps"][0]["agents"][0]["name"]
        assert "9876543210" not in str(d) and "9876543210" not in str(it)   # the dashboard shows tokenised text only
        # a person rejects it: it moves from waiting to rejected, with their name on it
        assert client.post(f"/api/cases/{held}/reject", json={"by": "Asha", "note": "no"}).status_code == 200
        d = client.get("/api/dashboard").json()
        assert (d["cases"]["waiting"], d["cases"]["rejected"], d["cases"]["acceptance"]) == (0, 2, round(1 / 3, 3))
        it = client.get(f"/api/dashboard/item/{held}").json()
        assert {"name": "Asha", "did": "rejected"} in it["people"] and it["how"] == "rejected by a person"
        assert client.get("/api/dashboard/item/NR-9999").status_code == 404


def test_prices_and_model_label_are_settings(engine):
    with TestClient(create_app(engine, background=False)) as client:
        engine.llm.meter.record(1_000_000, 1_000_000, job="read", ref="NR-1")
        assert client.get("/api/usage").json()["cost"] == 75.0
        s = client.put("/api/usage", json={"model": "qwen3.6:8b", "price_in": 0, "price_out": 10}).json()
        assert s["model"]["name"] == "qwen3.6:8b" and s["cost"] == 10.0
        assert client.put("/api/usage", json={"price_in": -1}).status_code == 400
        assert client.put("/api/usage", json={"model": "  "}).status_code == 400


def test_intake_reads_back_tokens_and_the_tasks_tokens_land_on_it(fake, store, calibrator):
    fake.usage = {"prompt_tokens": 50, "completion_tokens": 10}
    fake.behaviour["ollama"] = [("ok", EXTRACT), ("ok", REPLY)]
    e = Engine(store, step_delay=0, llm=model_on(fake, "ollama", store=store), calibrator=calibrator)
    with TestClient(create_app(e, background=False)) as client:
        text = "I was charged twice ₹349 at CafeBrew yesterday"
        hint = client.get("/api/office/interpret", params={"dept": "intake", "text": text}).json()
        assert hint["kind"] == "case" and hint["tokens"] == usage.estimate(text) > 5
        r = client.post("/api/office/tasks", json={"dept": "intake", "text": text, "customer_id": "C-1002", "by": "Ira"}).json()
        assert r["kind"] == "case" and r["tokens"]["prompt"] == hint["tokens"]
        c = wait(client, r["case"]["id"])
        assert c["tokens"] == 60 * len(fake.posts("ollama")) > 0
        item = client.get(f"/api/dashboard/item/{c['id']}").json()
        assert item["tokens"]["total"] == c["tokens"] and item["tokens"]["jobs"][0]["label"]
        # an agent's chat is counted too, under its own name
        client.post("/api/office/chat", json={"agent": "triage", "text": "how many refunds did you handle today?", "by": "Ira"})
        assert e.llm.meter.of("chat:triage")["calls"] >= 1
