"""Outreach: "pay ₹500 to Anushka", "ask Rahul for ₹1,200 on WhatsApp and call him if he hasn't paid in 2 hours".
The sentence is read by rules, what is missing is asked back, the right desks do each part, a payment out
waits for a person and is sealed, and the message goes out natively or through n8n (a stand-in here that
answers the way the workflow in n8n does)."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from nirnaya import benchmark, outreach
from nirnaya.api import create_app
from nirnaya.presets import PRESETS
from tests.test_pg import HOOK_SECRET, KEY_ID, KEY_SECRET, FakeRazorpay

TOKEN = "tok-n8n-test"


class FakeN8n:
    """The n8n workflow: checks X-Nirnaya-Token, answers a dry run, 'sends' everything else."""

    def __init__(self):
        self.posts: list[dict] = []
        self.fail_next = None
        self.unconfirmed = False
        me = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.headers.get("X-Nirnaya-Token") != TOKEN:
                    return self._send(401, {"ok": False, "error": "bad token"})
                me.posts.append(body)
                if body.get("dry_run"):
                    return self._send(200, {"ok": True, "dry_run": True, "channel": body.get("channel")})
                if me.unconfirmed:
                    return self._send(200, {"message": "Workflow was started"})
                if me.fail_next:
                    err, me.fail_next = me.fail_next, None
                    return self._send(200, {"ok": False, "error": err})
                return self._send(200, {"ok": True, "channel": body["channel"], "id": f"n8n-{len(me.posts)}"})

            def _send(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/webhook/nirnaya"


@pytest.fixture
def n8n():
    f = FakeN8n()
    yield f
    f.server.shutdown()


@pytest.fixture
def rz():
    f = FakeRazorpay()
    yield f
    f.server.shutdown()


@pytest.fixture
def client(engine, n8n):
    with TestClient(create_app(engine, background=False)) as c:
        c.put("/api/channels", json={"hook": {"url": n8n.url, "token": TOKEN}})
        c.put("/api/outreach", json={"per_contact_hour": 20, "from_name": "Karthik"})
        yield c


def wait_op(c, op_id, states=("done",), timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        op = next((o for o in c.get("/api/office").json()["ops"] if o["id"] == op_id), None)
        if op and op["state"] in states:
            return op
        time.sleep(0.05)
    raise AssertionError(f"{op_id} never reached {states}")


def task(c, text):
    r = c.post("/api/office/tasks", json={"dept": "intake", "text": text, "by": "Karthik"})
    assert r.status_code == 200, r.text
    return r.json()["op"]


# ── reading ──────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("text,want", [
    ("make a payment to anushka", {"money": "pay", "name": "Anushka", "amount": None}),
    ("pay ₹500 to anushka@example.com for dinner", {"money": "pay", "amount": 500, "email": "anushka@example.com",
                                                     "name": "Anushka", "reason": "dinner"}),
    ("ask anushka (+91 98765 43210) for ₹1,200 for the concert tickets on whatsapp",
     {"money": "request", "amount": 1200, "phone": "+919876543210", "channels": ["whatsapp"], "reason": "the concert tickets"}),
    ("call rahul 9876543210 and remind him about the ₹2,000 he owes", {"money": "request", "channels": ["call"], "name": "Rahul"}),
    ("whatsapp 9876543210: your refund of ₹349 is processed", {"action": "message", "say": "your refund of ₹349 is processed"}),
    ("anushka ko 500 bhej do", {"money": "pay", "amount": 500, "name": "Anushka", "lang": "hinglish"}),
    ("rahul se 2000 maango", {"money": "request", "amount": 2000, "name": "Rahul", "lang": "hinglish"}),
    ("send 1.5k to vikram on whatsapp 9812345678", {"money": "pay", "amount": 1500, "name": "Vikram"}),
    ("email priya@x.com and whatsapp her 9811122233: payment of ₹349 received, thanks",
     {"action": "message", "channels": ["email", "whatsapp"]}),
    ("ask Rahul +91 98765 43210 for ₹1,200 on WhatsApp and call him if he hasn't paid in 2 hours",
     {"money": "request", "channels": ["whatsapp"], "followup": {"after_s": 7200, "channels": ["call"]}}),
])
def test_the_sentence_is_read(text, want):
    assert outreach.looks_like(text)
    got = outreach.parse(text)
    for k, v in want.items():
        assert got[k] == v, (k, got[k], v)


def test_customers_telling_us_about_their_payments_are_never_mistaken_for_instructions():
    texts = [p["text"] for p in PRESETS] + [t for s in benchmark.SCENARIOS for t in s["phrasings"]] + [
        "I was charged twice ₹349 at CafeBrew yesterday", "Send me my refund status", "Refund my ₹349",
        "call me back please", "tell me where my refund is", "Please block my card", "I paid ₹500 to Anushka but she got nothing"]
    assert [t for t in texts if outreach.looks_like(t)] == []


def test_what_is_missing_is_asked_back(client, engine):
    plan = lambda t: client.get("/api/office/interpret", params={"dept": "intake", "text": t}).json()  # noqa: E731
    assert "How much" in plan("make a payment to anushka")["problem"]
    assert "email or phone" in plan("pay anushka 500")["problem"]
    assert "phone number" in plan("ask rahul for 2000 on whatsapp")["problem"]
    assert "Who is it for" in plan("call and talk to them")["problem"]
    assert "about" in plan("call rahul 9876543210")["problem"]
    assert "only send messages about money" in plan("whatsapp 9876543210: happy birthday!")["problem"]
    assert plan("email x@y.com: write python code to sort a list")["problem"].startswith("Finance only")
    assert "limit for one payment" in plan("pay 50000 to anu@example.com")["problem"]
    ok = plan("pay ₹500 to anushka@example.com for dinner")
    assert ok["problem"] is None and ok["needs_ok"] and ok["routes"] == {"email": "n8n"}
    assert client.post("/api/office/tasks", json={"dept": "intake", "text": "pay anushka 500"}).status_code == 400


def test_the_right_desks_do_each_part():
    agents = lambda t: [a for a, _ in outreach.steps_for(outreach.complete(outreach.parse(t), None))]  # noqa: E731
    pay = agents("pay ₹500 to anushka@example.com")
    assert pay[:3] == ["sentry", "pii", "triage"] and pay.index("kyc") < pay.index("fraud") < pay.index("router") \
        < pay.index("seal") < pay.index("human") < pay.index("commit") < pay.index("guard") and pay[-1] == "trail"
    req = agents("ask anushka 9876543210 for ₹1,200 on whatsapp")
    assert "upi" in req and "commit" in req and "seal" not in req and "human" not in req
    msg = agents("whatsapp 9876543210: your refund of ₹349 is processed")
    assert "commit" not in msg and "seal" not in msg and {"fraud", "router", "responder", "guard", "trail"} <= set(msg)


def test_people_already_known_are_found_by_name(client, engine):
    plan = client.get("/api/office/interpret", params={"dept": "intake", "text": "pay meera 200 on whatsapp"}).json()
    assert plan["problem"] is None and plan["task"]["phone"] == "+919123456780" and plan["found"] == "the ledger"


# ── doing ────────────────────────────────────────────────────────────────────
def test_a_request_makes_a_real_test_payment_link_and_goes_out_through_n8n(client, engine, n8n, rz):
    engine.pg.update({"enabled": True, "key_id": KEY_ID, "key_secret": KEY_SECRET, "webhook_secret": HOOK_SECRET,
                      "api_url": rz.url})
    op = wait_op(client, task(client, "ask anushka (+91 98765 43210) for ₹1,200 for the concert tickets on whatsapp")["id"])
    assert op["ok"], op["result"]
    assert len(rz.links) == 1 and rz.links[0]["amount"] == 120000 and rz.links[0]["customer"]["contact"] == "+919876543210"
    sent = n8n.posts[-1]
    assert sent["channel"] == "whatsapp" and sent["to"]["phone"] == "+919876543210" and sent["money"]["kind"] == "request"
    assert rz.links[0]["short_url"] in sent["text"] and "₹1,200" in sent["text"] and "test mode" in sent["text"]
    assert [s["agent"] for s in op["steps"]][:3] == ["sentry", "pii", "triage"] and "upi" in [s["agent"] for s in op["steps"]]
    assert any(t["kind"] == "outreach.done" for t in engine.trail.entries("-"))
    # Anushka is remembered: next time her number is not needed
    again = client.get("/api/office/interpret", params={"dept": "intake", "text": "ask anushka for ₹300 on whatsapp"}).json()
    assert again["problem"] is None and again["task"]["phone"] == "+919876543210" and again["found"] == "an earlier task"


def test_a_payment_waits_for_a_person_is_sealed_and_pays_once(client, engine, n8n):
    before = engine.rails.float_balance()
    op = wait_op(client, task(client, "pay ₹500 to anushka@example.com for dinner")["id"], ("waiting",))
    assert "Pay ₹500" in op["ask"] and "Sealed" in op["ask"] and "new payee" in op["ask"]
    assert engine.rails.payouts() == [] and n8n.posts == []           # nothing moves before the OK
    assert client.post(f"/api/office/ops/{op['id']}/approve", json={"by": "Karthik"}).status_code == 200
    op = wait_op(client, op["id"])
    assert op["ok"], op["result"]
    assert len(engine.rails.payouts()) == 1 and engine.rails.float_balance() == before - 500
    assert op["receipt"]["tool"] == "payout.send" and op["receipt"]["undo"] is None
    sent = n8n.posts[-1]
    assert sent["channel"] == "email" and sent["to"]["email"] == "anushka@example.com"
    assert "₹500" in sent["text"] and "no real money has moved" in sent["text"]   # a simulated payout says so
    assert "human" in [s["agent"] for s in op["steps"]]
    assert client.post(f"/api/office/ops/{op['id']}/approve", json={"by": "Karthik"}).status_code == 409


def test_when_the_float_moves_before_the_approval_the_old_approval_pays_nothing(client, engine, n8n):
    a = wait_op(client, task(client, "pay ₹300 to riya@example.com")["id"], ("waiting",))
    b = wait_op(client, task(client, "pay ₹400 to sam@example.com")["id"], ("waiting",))
    client.post(f"/api/office/ops/{a['id']}/approve", json={"by": "Karthik"})
    assert wait_op(client, a["id"])["ok"]
    client.post(f"/api/office/ops/{b['id']}/approve", json={"by": "Karthik"})
    b = wait_op(client, b["id"])
    assert not b["ok"] and "ground moved" in b["result"] and len(engine.rails.payouts()) == 1


def test_a_rejected_payment_pays_nothing_and_sends_nothing(client, engine, n8n):
    op = wait_op(client, task(client, "pay ₹250 to tara@example.com")["id"], ("waiting",))
    client.post(f"/api/office/ops/{op['id']}/reject", json={"by": "Karthik", "note": "not today"})
    op = wait_op(client, op["id"])
    assert op["rejected"] and engine.rails.payouts() == [] and n8n.posts == []


def test_limits_bad_tokens_and_failed_sends_are_reported(client, engine, n8n):
    client.put("/api/outreach", json={"per_contact_hour": 1})
    first = wait_op(client, task(client, "whatsapp 9822233344: your refund of ₹349 is processed")["id"])
    assert first["ok"]
    second = wait_op(client, task(client, "whatsapp 9822233344: your refund of ₹349 is processed")["id"])
    assert not second["ok"] and "already contacted" in second["result"]
    client.put("/api/outreach", json={"per_contact_hour": 20})
    n8n.fail_next = "Gmail credential missing"
    op = wait_op(client, task(client, "email dev@example.com about the ₹1,000 refund")["id"])
    assert not op["ok"] and "Gmail credential missing" in op["result"]
    client.put("/api/channels", json={"hook": {"token": "wrong"}})
    bad = client.post("/api/outreach/test").json()
    assert bad["ok"] is False and "bad token" in bad["error"]
    client.put("/api/channels", json={"hook": {"token": TOKEN}})
    assert client.post("/api/outreach/test").json()["answer"]["id"] == "n8n"
    assert n8n.posts[-1]["dry_run"] is True
    n8n.unconfirmed = True                        # a workflow that only says "received" is not a send
    op = wait_op(client, task(client, "email una@example.com about the ₹90 refund")["id"])
    assert not op["ok"] and "did not confirm" in op["result"]
    n8n.unconfirmed = False


def test_outreach_has_its_own_n8n_url_so_case_events_never_reach_that_workflow(client, n8n):
    client.put("/api/channels", json={"hook": {"url": "http://127.0.0.1:9/case-events", "outreach_url": n8n.url}})
    op = wait_op(client, task(client, "email omar@example.com about the ₹700 refund")["id"])
    assert op["ok"] and n8n.posts[-1]["to"]["email"] == "omar@example.com"


def test_if_they_have_not_paid_the_follow_up_reminds_them_and_if_they_have_it_does_not(client, engine, n8n, rz):
    engine.pg.update({"enabled": True, "key_id": KEY_ID, "key_secret": KEY_SECRET, "webhook_secret": HOOK_SECRET,
                      "api_url": rz.url})
    ops = lambda: client.get("/api/office").json()["ops"]  # noqa: E731
    for paid in (False, True):
        phone = "9876500001" if not paid else "9876500002"
        op = wait_op(client, task(client, f"ask rahul {phone} for ₹1,200 on whatsapp and call him if he hasn't paid in 2 hours")["id"])
        assert op["ok"] and op["followup_id"]
        f = next(o for o in ops() if o["id"] == op["followup_id"])
        assert f["state"] == "scheduled" and 7100 < f["due_at"] - time.time() < 7300
        if paid:
            rz.links[-1]["status"] = "paid"
        n = len(n8n.posts)
        engine.store.kv_set("office_ops", [{**o, "due_at": time.time() - 1} if o["id"] == f["id"] else o
                                           for o in engine.store.kv_get("office_ops")])

        async def fire():                     # what the routines' tick does every minute
            client.app.state.nirnaya["ops"].fire_due()
        client.portal.call(fire)
        f = wait_op(client, f["id"])
        if paid:
            assert "no reminder needed" in f["result"] and len(n8n.posts) == n
        else:
            assert f["ok"] and n8n.posts[-1]["channel"] == "call" and "reminder" in n8n.posts[-1]["text"]
            assert rz.links[-1]["short_url"] in n8n.posts[-1]["text"] or n8n.posts[-1]["channel"] == "call"


def test_in_chat_the_agent_asks_for_what_is_missing_then_does_it(client, engine, n8n):
    say = lambda t: client.post("/api/office/chat", json={"agent": "triage", "text": t, "by": "Karthik"}).json()  # noqa: E731
    assert "How much" in say("hey, make a payment to anushka")["reply"]
    assert "email or phone" in say("500")["reply"]
    assert not say("what have you done today?").get("asking")          # a question in between does not answer it
    r = say("anushka@example.com")
    assert r["reply"].startswith("On it as OP-") and "Approvals" in r["reply"]
    op = wait_op(client, r["op"]["id"], ("waiting",))
    assert "₹500" in op["ask"]
    assert "How much" in say("ask rahul for money on whatsapp 9812300000")["reply"]
    assert "dropped" in say("cancel")["reply"]
    assert say("email x@y.com: write python code to sort a list")["reply"].startswith("Finance only")


def test_the_ledger_shows_payouts_masked(client, engine, n8n):
    op = wait_op(client, task(client, "pay ₹150 to neha@example.com")["id"], ("waiting",))
    client.post(f"/api/office/ops/{op['id']}/approve", json={"by": "Karthik"})
    wait_op(client, op["id"])
    led = client.get("/api/ledger").json()
    assert led["payouts"][0]["amount"] == 150 and led["payouts"][0]["to"]["email"].startswith("ne…@")
    assert led["float"]["balance"] == 500_000 - 150
