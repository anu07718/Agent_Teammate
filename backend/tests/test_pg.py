"""Real UPI payments from Razorpay's test mode, against a stand-in that answers the way Razorpay's API does
(the same paths, Basic auth, JSON shapes and errors) and webhooks signed the way Razorpay signs them
(HMAC-SHA256 of the raw body with the webhook secret)."""
import asyncio
import base64
import hashlib
import hmac
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from nirnaya.engine import Engine
from nirnaya.pg import PG, PGError

KEY_ID, KEY_SECRET, HOOK_SECRET = "rzp_test_AbCdEf123456", "test_secret_xyz", "whsec_test_123"


class FakeRazorpay:
    def __init__(self):
        self.payments: dict[str, dict] = {}
        self.refunds: list[dict] = []
        self.links: list[dict] = []
        self.calls: list[tuple[str, str]] = []
        rz = self
        auth = "Basic " + base64.b64encode(f"{KEY_ID}:{KEY_SECRET}".encode()).decode()

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _err(self, code, desc):
                self._send(code, {"error": {"code": "BAD_REQUEST_ERROR", "description": desc, "source": "business",
                                            "step": "payment_initiation", "reason": "input_validation_failed"}})

            def _route(self, method):
                rz.calls.append((method, self.path))
                if self.headers.get("Authorization") != auth:
                    return self._send(401, {"error": {"code": "BAD_REQUEST_ERROR",
                                                      "description": "The api key provided is invalid"}})
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                parts = self.path.split("?")[0].strip("/").split("/")
                if parts[:2] == ["v1", "payments"] and len(parts) == 2 and method == "GET":
                    return self._send(200, {"entity": "collection", "count": len(rz.payments),
                                            "items": sorted(rz.payments.values(), key=lambda p: -p["created_at"])})
                if parts[:2] == ["v1", "payments"] and len(parts) >= 3:
                    p = rz.payments.get(parts[2])
                    if not p:
                        return self._err(400, "The id provided does not exist")
                    if len(parts) == 3:
                        return self._send(200, p)
                    if parts[3] == "refunds" and method == "GET":
                        return self._send(200, {"entity": "collection", "items": [r for r in rz.refunds if r["payment_id"] == p["id"]]})
                    if parts[3] == "refund" and method == "POST":
                        amt = body.get("amount", p["amount"] - p["amount_refunded"])
                        if p["status"] not in ("captured", "refunded"):
                            return self._err(400, "The payment has not been captured")
                        if amt > p["amount"] - p["amount_refunded"]:
                            return self._err(400, "The refund amount provided is greater than amount captured")
                        r = {"id": f"rfnd_{len(rz.refunds) + 1:014d}", "entity": "refund", "amount": amt, "currency": "INR",
                             "payment_id": p["id"], "notes": body.get("notes") or {}, "receipt": body.get("receipt"),
                             "acquirer_data": {"rrn": "910000000001"}, "created_at": int(time.time()), "status": "processed",
                             "speed_processed": "normal", "speed_requested": body.get("speed", "normal")}
                        rz.refunds.append(r)
                        p["amount_refunded"] += amt
                        p["refund_status"] = "full" if p["amount_refunded"] == p["amount"] else "partial"
                        if p["amount_refunded"] == p["amount"]:
                            p["status"] = "refunded"
                        return self._send(200, r)
                if parts[:2] == ["v1", "payment_links"] and method == "POST":
                    link = {"id": f"plink_{len(rz.links) + 1:014d}", "short_url": f"https://rzp.io/i/test{len(rz.links) + 1}",
                            "status": "created", **body}
                    rz.links.append(link)
                    return self._send(200, link)
                self._err(404, "not found")

            def do_GET(self):
                self._route("GET")

            def do_POST(self):
                self._route("POST")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def pay(self, pid, rupees, *, status="captured", contact="+919123456780", merchant="CafeBrew", ago=60, notes=None,
            error=None):
        self.payments[pid] = {
            "id": pid, "entity": "payment", "amount": int(rupees * 100), "currency": "INR", "status": status,
            "order_id": None, "method": "upi", "amount_refunded": 0, "refund_status": None,
            "captured": status == "captured", "description": f"{merchant} order", "vpa": "success@razorpay",
            "email": "void@razorpay.com", "contact": contact, "notes": notes or {"merchant": merchant},
            "error_code": "BAD_REQUEST_ERROR" if error else None, "error_description": error,
            "acquirer_data": {"rrn": "" if status == "failed" else f"5{abs(hash(pid)) % 10**11:011d}"},
            "created_at": int(time.time() - ago)}
        return self.payments[pid]


def sign(raw: bytes) -> str:
    return hmac.new(HOOK_SECRET.encode(), raw, hashlib.sha256).hexdigest()


@pytest.fixture
def rz():
    f = FakeRazorpay()
    yield f
    f.server.shutdown()


@pytest.fixture
def eng(store, calibrator, rz):
    e = Engine(store, step_delay=0, calibrator=calibrator)
    e.pg.update({"enabled": True, "key_id": KEY_ID, "key_secret": KEY_SECRET, "webhook_secret": HOOK_SECRET,
                 "api_url": rz.url})
    return e


def run(coro):
    return asyncio.run(coro)


def test_only_test_keys_and_the_secrets_never_come_back(store):
    from nirnaya.rails import Rails
    pg = PG(store, Rails(store), None)
    with pytest.raises(ValueError, match="live key"):
        pg.update({"key_id": "rzp_live_AbCdEf123456"})
    with pytest.raises(ValueError, match="rzp_test_"):
        pg.update({"key_id": "sk_test_123"})
    out = pg.update({"enabled": True, "key_id": KEY_ID, "key_secret": KEY_SECRET, "webhook_secret": HOOK_SECRET})
    assert out["ready"] and out["key_secret_set"] and KEY_SECRET not in json.dumps(out) and HOOK_SECRET not in json.dumps(out)
    assert pg.update({"key_secret": ""})["key_secret_set"]        # "" keeps it
    assert not pg.update({"key_secret": None})["ready"]           # null clears it


def test_sync_brings_real_payments_into_the_ledger_matched_to_customers(eng, rz):
    rz.pay("pay_A0000000000001", 349, contact="+91 91234 56780")                     # Meera's number (C-1002)
    rz.pay("pay_A0000000000002", 799, status="failed", contact="+919876543210", merchant="CityCabs",
           error="Payment was unsuccessful as the UPI ID was not found")            # Aarav (C-1001)
    rz.pay("pay_A0000000000003", 1500, contact="+919555000111", notes={"merchant": "BookNest", "customer_name": "Kabir Das"})
    out = eng.pg.sync()
    assert out["seen"] == 3 and out["changed"] == 3
    a, b, c = (eng.rails.txn(f"pay_A000000000000{i}") for i in (1, 2, 3))
    assert a["customer_id"] == "C-1002" and a["npci_status"] == "SUCCESS" and a["source"] == "razorpay_test"
    assert len(a["utr"]) == 12 and a["pg"]["method"] == "upi" and a["merchant"] == "CafeBrew"
    assert b["customer_id"] == "C-1001" and b["npci_status"] == "FAILED" and b["debit_status"] == "NOT_DEBITED"
    new = eng.rails.customer(c["customer_id"])
    assert new["name"] == "Kabir Das" and new["source"] == "razorpay_test" and new["phone"] == "9555000111"
    assert eng.pg.sync()["changed"] == 0                         # nothing changed on Razorpay: nothing changes here
    with pytest.raises(ValueError, match="Razorpay"):              # simulated events never land on real payments
        eng.rails.outside_event("pay_A0000000000001", "merchant_refund")
    assert eng.rails.natural_event("pay_A0000000000001") is None


def test_webhooks_are_signed_deduplicated_and_update_refunds(eng, rz):
    p = rz.pay("pay_B0000000000001", 250)
    raw = json.dumps({"entity": "event", "event": "payment.captured", "contains": ["payment"],
                      "payload": {"payment": {"entity": p}}, "created_at": int(time.time())}).encode()
    with pytest.raises(PGError, match="signature"):
        eng.pg.webhook(raw, "0" * 64, "evt_1")
    assert eng.pg.webhook(raw, sign(raw), "evt_1")["changed"]
    assert eng.pg.webhook(raw, sign(raw), "evt_1") == {"ok": True, "duplicate": True}
    ref = {"id": "rfnd_X1", "entity": "refund", "amount": 25000, "payment_id": p["id"], "status": "processed",
           "created_at": int(time.time()), "acquirer_data": {"arn": "74332716045000999999999"}}
    raw2 = json.dumps({"event": "refund.processed", "payload": {"refund": {"entity": ref}, "payment": {"entity": {**p, "amount_refunded": 25000, "status": "refunded"}}}}).encode()
    assert eng.pg.webhook(raw2, sign(raw2), "evt_2")["changed"]
    t = eng.rails.txn(p["id"])
    assert t["refund"]["status"] == "PROCESSED" and t["refund"]["ref"] == "rfnd_X1" and t["pg"]["amount_refunded"] == 250


def _charged_twice(eng, rz):
    rz.pay("pay_C0000000000001", 349, ago=120)
    rz.pay("pay_C0000000000002", 349, ago=60)
    eng.pg.sync()
    assert eng.rails.txn("pay_C0000000000002")["duplicate_of"] == "pay_C0000000000001"
    c = eng.create_case("C-1002", "I was charged twice ₹349 at CafeBrew today", "chat")
    return run(eng.run(c["id"]))


def test_a_refund_on_a_real_payment_always_asks_a_person_then_goes_to_razorpay_exactly_once(eng, rz):
    c = _charged_twice(eng, rz)
    assert c["txn"]["id"] == "pay_C0000000000002" and c["txn"]["source"] == "razorpay_test"
    d = next(x for x in c["decisions"] if x["action"]["type"] == "refund_duplicate")
    assert d["route"] == "ESCALATE" and "cannot be undone" in d["why"]
    assert any("Razorpay (test mode) has pay_C0000000000002 as captured" in f for f in c["plan"]["facts"])
    assert ("GET", "/v1/payments/pay_C0000000000002") in rz.calls   # the evidence read the live payment
    assert not rz.refunds
    c = run(eng.approve(c["id"], by="Asha"))
    assert len(rz.refunds) == 1 and rz.refunds[0]["amount"] == 34900 and rz.refunds[0]["payment_id"] == "pay_C0000000000002"
    assert rz.refunds[0]["notes"]["nirnaya_idem"].startswith(c["id"])
    t = eng.rails.txn("pay_C0000000000002")
    assert t["refund"]["status"] == "PROCESSED" and t["refund"]["ref"].startswith("rfnd_")
    assert t["pg"]["amount_refunded"] == 349 and t["pg"]["status"] == "refunded"
    receipt = next(x for x in c["decisions"] if x["action"]["type"] == "refund_duplicate")["receipt"]
    assert receipt["tool"] == "pg.refund" and receipt["undo"] is None and receipt["result"]["gateway"] == "Razorpay (test)"
    # the same refund asked again (a retry after a crash, say) finds the first one and does not pay twice
    again = eng.pg.refund_for("pay_C0000000000002", 349, receipt["idempotency_key"], c["id"])
    assert again["replayed"] and len(rz.refunds) == 1


def test_when_razorpay_moved_before_the_approval_the_old_approval_is_not_applied(eng, rz):
    c = _charged_twice(eng, rz)
    p = rz.payments["pay_C0000000000002"]                # refunded from Razorpay's dashboard meanwhile
    p.update(amount_refunded=34900, status="refunded", refund_status="full")
    c = run(eng.approve(c["id"], by="Asha"))
    assert not rz.refunds                                  # nothing was refunded on top
    kinds = [e["kind"] for e in eng.bus.recent(400) if e.get("case_id") == c["id"]]
    assert "seal.rejected_approval" in kinds or "seal.broken" in kinds


def test_refund_guardrails_and_a_failed_payment_that_took_no_money(eng, rz):
    rz.pay("pay_D0000000000001", 100)
    rz.pay("pay_D0000000000002", 799, status="failed", contact="+919876543210", merchant="CityCabs",
           error="Payment was unsuccessful due to a temporary issue")
    eng.pg.sync()
    with pytest.raises(PGError, match="can still be refunded"):
        eng.pg.refund_for("pay_D0000000000001", 150, "k1", "NR-x")
    with pytest.raises(PGError, match="nothing was captured"):
        eng.pg.refund_for("pay_D0000000000002", 799, "k2", "NR-x")
    c = run(eng.run(eng.create_case("C-1001", "Paid ₹799 to CityCabs today, payment failed but money deducted", "chat")["id"]))
    assert c["txn"]["id"] == "pay_D0000000000002"
    assert [d["action"]["type"] for d in c["decisions"]] == ["share_status"]   # no money moves: none was taken
    assert "failed before any money was taken" in c["conversation"][-1]["text"]


def test_a_test_payment_link_for_a_customer(eng, rz):
    link = eng.pg.link_for("C-1002", 349, "CafeBrew")
    assert link["short_url"].startswith("https://rzp.io/") and rz.links[0]["amount"] == 34900
    assert rz.links[0]["notes"]["customer_id"] == "C-1002" and rz.links[0]["customer"]["contact"] == "+919123456780"
    with pytest.raises(PGError, match="between"):
        eng.pg.link_for("C-1002", 200000, "CafeBrew")


def test_the_api_and_the_webhook_route(eng, rz, monkeypatch):
    from fastapi.testclient import TestClient
    from nirnaya.api import create_app
    monkeypatch.setenv("NIRNAYA_ACCESS_KEY", "k")                 # the webhook stays open: Razorpay signs it
    p = rz.pay("pay_E0000000000001", 420)
    with TestClient(create_app(eng, background=False)) as cl:
        h = {"X-Nirnaya-Key": "k"}
        assert cl.get("/api/pg", headers=h).json()["ready"]
        assert cl.post("/api/pg/test", headers=h).json() == {"ok": True}
        raw = json.dumps({"event": "payment.captured", "payload": {"payment": {"entity": p}}}).encode()
        assert cl.post("/api/pg/razorpay/webhook", content=raw, headers={"X-Razorpay-Signature": "bad"}).status_code == 401
        r = cl.post("/api/pg/razorpay/webhook", content=raw, headers={"X-Razorpay-Signature": sign(raw), "X-Razorpay-Event-Id": "e9"})
        assert r.status_code == 200 and r.json()["changed"]
        led = cl.get("/api/ledger", headers=h).json()["transactions"]
        row = next(t for t in led if t["id"] == "pay_E0000000000001")
        assert row["source"] == "razorpay_test" and row["pg"]["status"] == "captured" and row["can"] is None
        s = cl.get("/api/state", headers=h).json()["integrations"]["pg"]
        assert s["ready"] and s["payments"] == 1
        assert cl.put("/api/pg", headers=h, json={"key_id": "rzp_live_AAAAAAAAAAAAAA"}).status_code == 400
