"""Outside events on the simulated ledger happen the way they can in real life: once, and only where they fit."""
import pytest
from fastapi.testclient import TestClient

from nirnaya.api import create_app


@pytest.fixture
def client(engine):
    app = create_app(engine, background=False)
    with TestClient(app) as c:
        yield c


def balance(client, customer):
    return next(a["balance"] for a in client.get("/api/ledger").json()["accounts"] if a["customer_id"] == customer)


def test_a_reversal_lands_once_and_only_on_a_failed_debit(client):
    before = balance(client, "C-1001")
    r = client.post("/api/sim/rail-event", json={"txn_id": "T-5001", "event": "auto"})
    assert r.status_code == 200 and r.json()["event"] == "reversal_lands"
    assert balance(client, "C-1001") == before + 2450
    again = client.post("/api/sim/rail-event", json={"txn_id": "T-5001", "event": "reversal_lands"})
    assert again.status_code == 400 and "already reversed" in again.json()["detail"]
    assert client.post("/api/sim/rail-event", json={"txn_id": "T-5001", "event": "auto"}).status_code == 400
    assert balance(client, "C-1001") == before + 2450  # credited once, not twice


def test_a_payment_that_went_through_gets_a_merchant_refund_not_a_reversal(client):
    wrong = client.post("/api/sim/rail-event", json={"txn_id": "T-5004", "event": "reversal_lands"})
    assert wrong.status_code == 400 and "went through" in wrong.json()["detail"]
    r = client.post("/api/sim/rail-event", json={"txn_id": "T-5004", "event": "auto"})
    assert r.json()["event"] == "merchant_refund"
    ledger = {t["id"]: t for t in client.get("/api/ledger").json()["transactions"]}
    assert ledger["T-5004"]["refund"] == "PROCESSED" and ledger["T-5004"]["can"] is None
    assert ledger["T-5003"]["can"] is None          # seeded already refunded
    assert ledger["T-5002"]["can"] == "reversal_lands"
    assert client.post("/api/sim/rail-event", json={"txn_id": "T-9999", "event": "auto"}).status_code == 400


def test_ordinary_traffic_does_not_trip_the_drift_alarm_but_a_less_certain_mix_does(engine):
    import asyncio
    from nirnaya.presets import PRESETS

    async def run_all():
        for _ in range(3):
            engine.rails.reset()
            for p in PRESETS:
                c = engine.create_case(p["customer"], p["text"], "chat")
                await engine.run(c["id"])
    asyncio.run(run_all())
    assert not engine.drift.check()["alarm"]          # 33 ordinary cases, the same ones repeated
    for _ in range(25):
        engine.drift.observe(0.55, "reverse_failed_debit")  # this action's cases now score far less certain
    st = engine.drift.check()
    assert st["alarm"] and "reverse_failed_debit" in st["reason"]


def test_policy_changes_at_the_same_time_never_fail(engine):
    # two people (or the α box and an autonomy button) changing the policy at once refit the thresholds in
    # two threads; the table is swapped in whole, so neither request fails and routing never sees half of it
    import threading
    errors = []

    def change(i):
        try:
            engine.set_policy("tat_compensation", rung=i % 3, by="Tester")
            engine.set_policy("refund_duplicate", alpha=0.02 + 0.001 * (i % 3), by="Tester")
        except Exception as ex:  # noqa: BLE001 - any failure is the bug
            errors.append(repr(ex))

    threads = [threading.Thread(target=change, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors, errors
    assert set(engine.risk.table) == set(engine.policy.actions)
