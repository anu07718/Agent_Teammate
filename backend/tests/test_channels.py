"""Real channels: email, WhatsApp (Meta and WAHA), phone calls (Twilio), the call page, webhooks for n8n.

Providers are stood in for by a local HTTP server that records what Nirnaya sends and answers the way
the provider does; every webhook is signed the way the provider signs it. Email also runs against a real
SMTP and IMAP server (GreenMail) when one is listening on 127.0.0.1:3025 / 3143 (`make test-mail`).
"""
import hashlib
import hmac
import json
import re
import socket
import smtplib
import threading
import time
import urllib.parse
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from nirnaya.api import create_app
from nirnaya.channels import mail, voice

FAILED_UPI = "My UPI payment of ₹2,450 to FreshMart failed 3 days ago but the money was debited from my account"
DUPLICATE = "I was charged twice for ₹349 at CafeBrew yesterday"
UNAUTHORISED = "There is a transaction of ₹18,500 at QuickPay Store that was not done by me, please help"


class Fake(ThreadingHTTPServer):
    """A stand-in provider: records each request, answers like Meta, WAHA, Twilio or an n8n webhook."""

    def __init__(self):
        self.calls: list[dict] = []
        super().__init__(("127.0.0.1", 0), FakeHandler)
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_address[1]}"

    def to(self, part):
        return [c for c in self.calls if part in c["path"]]


class FakeHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        ctype = self.headers.get("Content-Type") or ""
        body = json.loads(raw or b"{}") if "json" in ctype else dict(urllib.parse.parse_qsl(raw.decode()))
        self.server.calls.append({"path": self.path, "headers": dict(self.headers), "body": body})
        if self.path.endswith("/messages"):
            out = {"messages": [{"id": f"wamid.{len(self.server.calls)}"}]}
        elif self.path.endswith("/api/sendText"):
            out = {"id": {"_serialized": f"true_{len(self.server.calls)}"}}
        elif self.path.endswith("/Calls.json"):
            out = {"sid": f"CAout{len(self.server.calls)}"}
        else:
            out = {"ok": True}
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def fake():
    f = Fake()
    yield f
    f.shutdown()


@pytest.fixture
def client(engine):
    app = create_app(engine, background=False)
    with TestClient(app) as c:
        yield c


def until(fn, timeout=15.0, every=0.05):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(every)
    raise AssertionError("timed out waiting")


def wa_post(client, body: dict, secret="shh"):
    raw = json.dumps(body).encode()
    sig = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return client.post("/api/channels/whatsapp/webhook", content=raw,
                       headers={"Content-Type": "application/json", "X-Hub-Signature-256": sig})


def wa_message(frm, text, mid, name="Tester"):
    return {"object": "whatsapp_business_account", "entry": [{"id": "WABA", "changes": [{"field": "messages", "value": {
        "messaging_product": "whatsapp", "metadata": {"display_phone_number": "15550001111", "phone_number_id": "PNID"},
        "contacts": [{"profile": {"name": name}, "wa_id": frm}],
        "messages": [{"from": frm, "id": mid, "timestamp": str(int(time.time())), "type": "text", "text": {"body": text}}]}}]}]}


def setup_meta(client, fake, **extra):
    r = client.put("/api/channels", json={"public_url": "https://nirnaya.example", "whatsapp": {
        "enabled": True, "provider": "meta", "phone_number_id": "PNID", "token": "tok", "app_secret": "shh",
        "verify_token": "vt", "graph_url": fake.url, **extra}})
    assert r.status_code == 200, r.text
    return r.json()


# ── settings ────────────────────────────────────────────────────────────────
def test_settings_hide_secrets_keep_them_and_the_environment_wins(client, fake, monkeypatch):
    snap = setup_meta(client, fake)
    wa = snap["config"]["whatsapp"]
    assert wa["token"] == "" and wa["token_set"] and wa["app_secret_set"] and wa["verify_token"] == "vt"
    # sending "" keeps a secret; null clears it
    client.put("/api/channels", json={"whatsapp": {"token": ""}})
    assert client.get("/api/channels").json()["config"]["whatsapp"]["token_set"]
    client.put("/api/channels", json={"whatsapp": {"token": None}})
    assert not client.get("/api/channels").json()["config"]["whatsapp"]["token_set"]
    assert client.put("/api/channels", json={"whatsapp": {"provider": "carrier pigeon"}}).status_code == 400
    assert client.put("/api/channels", json={"public_url": "nirnaya.example"}).status_code == 400
    assert client.put("/api/channels", json={"unknown": "C-9999"}).status_code == 400
    monkeypatch.setenv("NIRNAYA_WHATSAPP_TOKEN", "from-env")
    monkeypatch.setenv("NIRNAYA_PUBLIC_URL", "https://env.example/")
    snap = client.get("/api/channels").json()
    assert snap["config"]["whatsapp"]["token_set"] and "whatsapp.token" in snap["config"]["locked"]
    assert snap["webhooks"]["whatsapp"] == "https://env.example/api/channels/whatsapp/webhook"
    assert "from-env" not in json.dumps(snap)


def test_contacts_are_emails_numbers_or_handles(client):
    link = lambda a, c="C-1001": client.post("/api/channels/contacts", json={"address": a, "customer_id": c})
    assert link("Aarav@Customer.test").json()["key"] == "email:aarav@customer.test"
    assert link("+91 98765-43210").json()["key"] == "phone:9876543210"
    assert link("@aarav_t").json()["key"] == "id:@aarav_t"
    for bad in ("hello", "12345", "a@b", " "):
        assert link(bad).status_code in (400, 422), bad
    assert link("x@y.test", "C-9999").status_code == 400
    assert {c["kind"] for c in client.get("/api/channels").json()["contacts"]} == {"email", "phone", "id"}
    client.delete("/api/channels/contacts", params={"address": "@aarav_t"})
    assert "id" not in {c["kind"] for c in client.get("/api/channels").json()["contacts"]}
    # someone on a webhook channel (Telegram through n8n) who says who they are is remembered by their handle
    client.put("/api/channels", json={"hook": {"enabled": True, "token": "t"}})
    r = client.post("/api/channels/hook", headers={"X-Nirnaya-Token": "t"},
                    json={"channel": "telegram", "from": "@Meera_T", "text": "I'm C-1002. " + DUPLICATE}).json()
    assert r["action"] == "case" and r["reply"].startswith("Thank you, Meera. I've found your account.")
    assert any(c["key"] == "id:@meera_t" and c["customer_id"] == "C-1002" for c in client.get("/api/channels").json()["contacts"])
    r = client.post("/api/channels/hook", headers={"X-Nirnaya-Token": "t"}, json={"channel": "telegram", "from": "@meera_t", "text": "thanks!"}).json()
    assert r["action"] == "reply" and "welcome" in r["reply"]
    # a numeric chat id with a prefix (channels.md's n8n example) is remembered too, not read as a phone number
    client.post("/api/channels/hook", headers={"X-Nirnaya-Token": "t"},
                json={"channel": "telegram", "from": "tg:123456789", "text": "I'm C-1003. " + UNAUTHORISED, "wait": False})
    assert any(c["key"] == "id:tg:123456789" and c["customer_id"] == "C-1003" for c in client.get("/api/channels").json()["contacts"])


# ── email ───────────────────────────────────────────────────────────────────
def raw_email(frm, to, subject, text, msg_id=None, **headers):
    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = frm, to, subject
    m["Message-ID"] = msg_id or f"<{time.time_ns()}@customer.test>"
    for k, v in headers.items():
        m[k.replace("_", "-")] = v
    m.set_content(text)
    return m.as_bytes()


def test_email_parsing_takes_only_the_new_text_and_skips_robots():
    reply = ("Thanks, it worked.\n\nOn Tue, 1 Oct 2026 at 10:00, Nirnaya Support <support@nirnaya.test>\nwrote:\n"
             "> I've reversed your debit\n> -- Case NR-1001\n")
    m = mail.parse(raw_email("Aarav <Aarav@Customer.test>", "support@nirnaya.test", "Re: Refund", reply,
                             In_Reply_To="<a@nirnaya.test>", References="<root@x> <a@nirnaya.test>"))
    assert m["from"] == "aarav@customer.test" and m["name"] == "Aarav" and m["text"] == "Thanks, it worked."
    assert m["in_reply_to"] == "<a@nirnaya.test>" and m["automatic"] is None
    assert mail.parse(raw_email("x@y.test", "s@n.test", "Out of office", "away", Auto_Submitted="auto-replied"))["automatic"]
    assert mail.parse(raw_email("news@shop.test", "s@n.test", "Sale", "50% off", List_Unsubscribe="<mailto:u@shop.test>"))["automatic"]
    assert mail.parse(raw_email("no-reply@bank.test", "s@n.test", "OTP", "123456"))["automatic"]
    assert mail.strip_quoted("Hello\n-- \nSent with love") == "Hello"
    out = mail.build({"address": "support@nirnaya.test", "username": "", "name": "Nirnaya Support"}, "aarav@customer.test",
                     mail.reply_subject("Refund", "x"), "Done", in_reply_to="<b@c>", references="<a@c>")
    assert out["Subject"] == "Re: Refund" and out["In-Reply-To"] == "<b@c>" and out["References"] == "<a@c> <b@c>"
    assert out["Auto-Submitted"] == "auto-replied" and out["Message-ID"].endswith("@nirnaya.test>")
    assert mail.reply_subject("Re: Refund", "x") == "Re: Refund" and mail.reply_subject("", "Your case NR-1") == "Your case NR-1"


def test_email_by_webhook_opens_a_case_and_replies_in_the_thread(client, engine, monkeypatch):
    sent: list = []
    monkeypatch.setattr(mail, "send", lambda cfg, msg: (sent.append(msg), str(msg["Message-ID"]))[1])
    client.put("/api/channels", json={"email": {"enabled": True, "address": "support@nirnaya.test", "receive": "webhook",
                                                "inbound_token": "in-tok", "accept": "contacts"}})
    body = {"from": "Aarav Sharma <aarav@customer.test>", "subject": "Money debited", "text": FAILED_UPI,
            "message_id": "<m1@customer.test>"}
    assert client.post("/api/channels/email/inbound", json=body).status_code == 403          # no token
    r = client.post("/api/channels/email/inbound?token=in-tok", json=body).json()
    assert r["action"] == "ignored" and "not a contact" in r["why"]                           # contacts only
    client.post("/api/channels/contacts", json={"address": "aarav@customer.test", "customer_id": "C-1001"})
    r = client.post("/api/channels/email/inbound", json={**body, "message_id": "<m2@customer.test>"},
                    headers={"X-Nirnaya-Token": "in-tok"}).json()
    assert r["action"] == "case"
    case = until(lambda: (c := engine.store.get_case(r["case_id"])) and c["status"] != "running" and c)
    assert case["channel"] == "email" and case["route"] == "ACT" and case["opened_by"].startswith("Email ·")
    msg = until(lambda: sent and sent[-1])
    assert msg["To"].endswith("aarav@customer.test>") and msg["Subject"] == "Re: Money debited"
    assert msg["In-Reply-To"] == "<m2@customer.test>" and r["case_id"] in msg.get_content()
    conv = client.get(f"/api/cases/{r['case_id']}/channel").json()
    assert [m["dir"] for m in conv["messages"]][-2:] == ["in", "out"] and conv["messages"][-1]["status"] == "sent"
    # the same message again (a forwarder retrying) is not a second case
    assert client.post("/api/channels/email/inbound?token=in-tok", json={**body, "message_id": "<m2@customer.test>"}).json()["action"] == "duplicate"
    # "thanks" in the thread is answered without a case
    n = len(engine.store.list_cases(50))
    r2 = client.post("/api/channels/email/inbound?token=in-tok", json={**body, "text": "Thank you!", "message_id": "<m3@customer.test>"}).json()
    assert r2["action"] == "reply" and len(engine.store.list_cases(50)) == n
    until(lambda: "welcome" in sent[-1].get_content())
    # a new email (a flow's Send email, a test) keeps its own subject and starts its own thread
    r3 = client.post("/api/channels/test", json={"channel": "email", "to": "new@customer.test", "text": "Hello", "subject": "A new thread"})
    assert r3.status_code == 200, r3.text
    assert sent[-1]["Subject"] == "A new thread" and sent[-1]["In-Reply-To"] is None and sent[-1]["To"] == "new@customer.test"


# ── WhatsApp: Meta ──────────────────────────────────────────────────────────
def test_whatsapp_meta_handshake_signature_and_a_whole_conversation(client, engine, fake):
    setup_meta(client, fake, accept="anyone")
    q = {"hub.mode": "subscribe", "hub.verify_token": "vt", "hub.challenge": "12345"}
    assert client.get("/api/channels/whatsapp/webhook", params=q).text == "12345"
    assert client.get("/api/channels/whatsapp/webhook", params={**q, "hub.verify_token": "nope"}).status_code == 403
    bad = json.dumps(wa_message("919000000001", "hi", "w0")).encode()
    assert client.post("/api/channels/whatsapp/webhook", content=bad,
                       headers={"X-Hub-Signature-256": "sha256=00"}).status_code == 403
    # a stranger is asked who they are; their first message waits until they say
    assert wa_post(client, wa_message("919000000001", FAILED_UPI, "w1")).status_code == 200
    first = until(lambda: next((c for c in fake.to("/messages") if c["body"].get("type") == "text"), None))
    assert first["headers"]["Authorization"] == "Bearer tok" and first["body"]["to"] == "919000000001"
    assert "customer ID" in first["body"]["text"]["body"] and first["path"] == "/v23.0/PNID/messages"
    wa_post(client, wa_message("919000000001", "It's C-1001", "w2"))
    texts = lambda: [c["body"]["text"]["body"] for c in fake.to("/messages") if c["body"].get("type") == "text"]
    until(lambda: any("found your account" in t for t in texts()))
    case_reply = until(lambda: next((t for t in texts() if "reversal" in t.lower() or "₹2,450" in t), None))
    assert "2,450" in case_reply
    case = next(c for c in engine.store.list_cases(20) if c["channel"] == "whatsapp")
    assert case["customer_id"] == "C-1001" and FAILED_UPI[:20] in (case.get("text") or case.get("raw") or FAILED_UPI)
    # read receipts went back, and a delivery status lands on our message
    assert any(c["body"].get("status") == "read" for c in fake.to("/messages"))
    sent_id = next(m["msg_id"] for m in client.get("/api/channels/conversations/whatsapp:919000000001").json()["messages"]
                   if m["dir"] == "out" and m.get("msg_id"))
    wa_post(client, {"entry": [{"changes": [{"value": {"statuses": [{"id": sent_id, "status": "delivered"}]}}]}]})
    conv = client.get("/api/channels/conversations/whatsapp:919000000001").json()
    assert next(m for m in conv["messages"] if m.get("msg_id") == sent_id)["status"] == "delivered"
    # the contact is remembered: the next message goes straight to a case
    assert any(c["address"] == "9000000001" and c["customer_id"] == "C-1001" for c in client.get("/api/channels").json()["contacts"])


def test_whatsapp_writes_first_with_a_template(client, fake):
    setup_meta(client, fake)
    r = client.post("/api/channels/test", json={"channel": "whatsapp", "to": "91 90000 00001", "text": "template:hello_world"})
    assert r.status_code == 200, r.text
    body = fake.to("/messages")[-1]["body"]
    assert body["type"] == "template" and body["template"] == {"name": "hello_world", "language": {"code": "en_US"}}
    client.post("/api/channels/test", json={"channel": "whatsapp", "to": "919000000001", "text": "template:order_update:hi"})
    assert fake.to("/messages")[-1]["body"]["template"] == {"name": "order_update", "language": {"code": "hi"}}
    client.post("/api/channels/test", json={"channel": "whatsapp", "to": "919000000001", "text": "template: is a word"})
    assert fake.to("/messages")[-1]["body"]["type"] == "text"


def test_whatsapp_contacts_only_ignores_strangers_and_status_questions_get_answers(client, engine, fake):
    setup_meta(client, fake, accept="contacts")
    wa_post(client, wa_message("919111111111", "hello?", "s1"))
    time.sleep(0.3)
    assert not fake.to("/messages")
    client.post("/api/channels/contacts", json={"address": "+91 91111 11111", "customer_id": "C-1003"})
    wa_post(client, wa_message("919111111111", UNAUTHORISED, "s2", name="Rohan"))
    case = until(lambda: next((c for c in engine.store.list_cases(20) if c["channel"] == "whatsapp" and c.get("pending")), None))
    wa_post(client, wa_message("919111111111", "any update?", "s3"))
    until(lambda: any("with a specialist" in c["body"].get("text", {}).get("body", "") for c in fake.to("/messages")))
    assert len([c for c in engine.store.list_cases(20) if c["channel"] == "whatsapp"]) == 1
    client.post(f"/api/cases/{case['id']}/approve", json={"by": "Asha"})
    until(lambda: any("18,500" in c["body"].get("text", {}).get("body", "") and "credit" in c["body"]["text"]["body"].lower()
                      for c in fake.to("/messages") if c["body"].get("type") == "text"))


# ── WhatsApp: WAHA ──────────────────────────────────────────────────────────
def test_waha_signature_groups_and_replies(client, engine, fake):
    client.put("/api/channels", json={"whatsapp": {"enabled": True, "provider": "waha", "waha_url": fake.url,
                                                   "waha_hmac_key": "hk", "accept": "anyone"}, "unknown": "C-1002"})
    msg = {"event": "message", "session": "default", "payload": {"id": "true_9198@c.us_A", "from": "919812345678@c.us",
                                                                   "fromMe": False, "body": DUPLICATE, "_data": {"notifyName": "Meera"}}}
    raw = json.dumps(msg).encode()
    sig = hmac.new(b"hk", raw, hashlib.sha512).hexdigest()
    assert client.post("/api/channels/waha/webhook", content=raw, headers={"X-Webhook-Hmac": "bad"}).status_code == 403
    group = json.dumps({**msg, "payload": {**msg["payload"], "from": "1203@g.us", "id": "g1"}}).encode()
    gsig = hmac.new(b"hk", group, hashlib.sha512).hexdigest()
    assert client.post("/api/channels/waha/webhook", content=group, headers={"X-Webhook-Hmac": gsig}).json()["messages"] == 0
    assert client.post("/api/channels/waha/webhook", content=raw, headers={"X-Webhook-Hmac": sig}).json()["messages"] == 1
    out = until(lambda: fake.to("/api/sendText") and fake.to("/api/sendText")[-1])
    assert out["body"]["chatId"] == "919812345678@c.us" and out["body"]["session"] == "default" and "349" in out["body"]["text"]
    case = next(c for c in engine.store.list_cases(10) if c["channel"] == "whatsapp")
    assert case["customer_id"] == "C-1002" and case["route"] == "HEDGE"


# ── phone calls: Twilio ─────────────────────────────────────────────────────
PUBLIC = "https://nirnaya.example"


def tw(client, path_query, **form):
    """POST like Twilio does: form-encoded, signed with the auth token over the public URL."""
    url = PUBLIC + path_query
    sig = voice.signature("authtok", url, form)
    return client.post(path_query, data=form, headers={"X-Twilio-Signature": sig})


def follow(client, xml, call_sid, rounds=8):
    """Follow <Redirect>s like Twilio until something is said with a <Gather> or a <Hangup>."""
    for _ in range(rounds):
        m = re.search(r"<Redirect method=\"POST\">([^<]+)</Redirect>", xml)
        if "<Gather" in xml or "<Hangup/>" in xml or not m:
            return xml
        nxt = m.group(1).replace("&amp;", "&").replace(PUBLIC, "")
        xml = tw(client, nxt, CallSid=call_sid).text
    return xml


def test_twilio_signature_matches_twilios_own_library():
    # computed with twilio.request_validator.RequestValidator("12345abcdef") for these exact inputs
    url = "https://abc.trycloudflare.com/api/channels/voice/twilio/turn?c=voice%3ACA123&quiet=1"
    params = {"CallSid": "CA123", "From": "+919876543210", "To": "+15005550006", "SpeechResult": "my refund is late",
              "Confidence": "0.91"}
    assert voice.signature("12345abcdef", url, params) == "AbFxRg8CRim0JUcWIRkHMjYZtTs="
    assert not voice.signature_ok("12345abcdef", url, {**params, "SpeechResult": "send me ₹50,000"}, "AbFxRg8CRim0JUcWIRkHMjYZtTs=")


def test_a_phone_call_turn_by_turn(client, engine, fake):
    client.put("/api/channels", json={"public_url": PUBLIC, "voice": {
        "enabled": True, "account_sid": "AC1", "auth_token": "authtok", "from_number": "+15550001111", "api_url": fake.url}})
    assert client.post("/api/channels/voice/twilio/incoming", data={"CallSid": "CA1", "From": "+919876543210"}).status_code == 403
    xml = tw(client, "/api/channels/voice/twilio/incoming", CallSid="CA1", From="+919876543210", To="+15550001111").text
    assert "<Gather input=\"dtmf speech\"" in xml and "Hello Aarav" in xml and 'language="en-IN"' in xml
    assert "This call is recorded" in xml and "2 दबाएँ" in xml          # told it is recorded; offered Hindi
    turn = re.search(r'action="([^"]+)"', xml).group(1).replace("&amp;", "&").replace(PUBLIC, "")
    xml = tw(client, turn, CallSid="CA1", From="+919876543210", SpeechResult=FAILED_UPI, Confidence="0.9").text
    xml = follow(client, xml, "CA1")
    assert "2,450" in xml and "<Gather" in xml and "anything else" in xml.lower()
    case = next(c for c in engine.store.list_cases(10) if c["channel"] == "voice")
    assert case["customer_id"] == "C-1001" and case["route"] == "ACT"
    xml = tw(client, turn, CallSid="CA1", From="+919876543210", SpeechResult="No, that's all.").text
    assert "Goodbye" in xml and "<Hangup/>" in xml
    # silence three times ends the call politely
    for i in range(3):
        xml = tw(client, turn + "&quiet=1", CallSid="CA1", From="+919876543210").text
    assert "<Hangup/>" in xml
    conv = client.get("/api/channels/conversations/voice:CA1").json()
    assert conv["customer_id"] == "C-1001" and any(m["dir"] == "in" and "2,450" in m["text"] for m in conv["messages"])


def test_an_unknown_caller_says_who_they_are_and_hears_the_answer(client, engine, fake):
    client.put("/api/channels", json={"public_url": PUBLIC, "voice": {
        "enabled": True, "account_sid": "AC1", "auth_token": "authtok", "from_number": "+15550001111", "api_url": fake.url}})
    xml = tw(client, "/api/channels/voice/twilio/incoming", CallSid="CA9", From="+919000000009", To="+15550001111").text
    assert "Hello, this is Nirnaya" in xml and "<Gather" in xml
    turn = re.search(r'action="([^"]+)"', xml).group(1).replace("&amp;", "&").replace(PUBLIC, "")
    xml = tw(client, turn, CallSid="CA9", From="+919000000009", SpeechResult=FAILED_UPI, Confidence="0.9").text
    assert "registered mobile number" in xml and "<Gather" in xml
    xml = follow(client, tw(client, turn, CallSid="CA9", From="+919000000009", SpeechResult="my customer ID is C 1 0 0 1").text, "CA9")
    # one answer: who they are, then what happened to the payment they first asked about
    assert "Thank you, Aarav. I&apos;ve found your account." in xml or "Thank you, Aarav. I've found your account." in xml
    assert "2,450" in xml and "<Gather" in xml
    assert any(c["address"] == "9000000009" and c["customer_id"] == "C-1001" for c in client.get("/api/channels").json()["contacts"])


def test_the_agent_calls_a_customer_back(client, engine, fake):
    client.put("/api/channels", json={"public_url": PUBLIC, "voice": {
        "enabled": True, "account_sid": "AC1", "auth_token": "authtok", "from_number": "+15550001111", "api_url": fake.url}})
    c = engine.create_case("C-1002", DUPLICATE, "chat")
    r = client.post(f"/api/cases/{c['id']}/call", json={"to": "98765 43210", "by": "Asha"})
    assert r.status_code == 200, r.text
    call = fake.to("/Calls.json")[-1]
    assert call["path"] == "/2010-04-01/Accounts/AC1/Calls.json" and call["body"]["To"] == "+919876543210"
    assert call["headers"]["Authorization"].startswith("Basic ") and call["body"]["Url"].startswith(PUBLIC)
    path = call["body"]["Url"].replace(PUBLIC, "")
    xml = tw(client, path, CallSid=r.json()["sid"], To="+919876543210").text
    assert f"calling about your case {c['id']}" in xml and "<Gather" in xml
    # without the public URL Twilio could not fetch the call's script, so it is refused up front
    client.put("/api/channels", json={"public_url": ""})
    assert "public URL" in client.post(f"/api/cases/{c['id']}/call", json={"to": "9876543210"}).json()["detail"]


# ── the browser call page ───────────────────────────────────────────────────
def test_the_call_page_talks_with_the_agent(client, engine):
    assert len(client.get("/api/channels/web/customers").json()) == 4
    s = client.post("/api/channels/web/start", json={"customer_id": "C-1004"}).json()
    assert "Hello Priya" in s["greeting"]
    r = client.post("/api/channels/web/turn", json={"session": s["session"], "text": "Where is my refund for the GadgetHub order?"}).json()
    assert r["case_id"] and r["reply"] and r["status"] in ("resolved", "parked")
    assert engine.store.get_case(r["case_id"])["channel"] == "voice"
    r = client.post("/api/channels/web/turn", json={"session": s["session"], "text": "thank you"}).json()
    assert "welcome" in r["reply"].lower() and not r["case_id"]
    r = client.post("/api/channels/web/turn", json={"session": s["session"], "text": "bye"}).json()
    assert r["end"] and "Goodbye" in r["reply"]
    client.post("/api/channels/web/end", json={"session": s["session"]})
    assert client.get(f"/api/channels/conversations/web:{s['session']}").json()["ended"]
    assert client.post("/api/channels/web/turn", json={"session": "nosuchcall", "text": "hi"}).status_code == 404


def test_someone_new_on_the_call_page_says_who_they_are(client, engine):
    client.put("/api/channels", json={"unknown": "C-1001"})  # strangers elsewhere count as Aarav; the call page still asks
    s = client.post("/api/channels/web/start", json={"customer_id": None}).json()
    assert s["customer_id"] is None and s["greeting"].startswith("Hello, this is Nirnaya")
    r = client.post("/api/channels/web/turn", json={"session": s["session"], "text": DUPLICATE}).json()
    assert "registered mobile number" in r["reply"] and not r["case_id"]
    r = client.post("/api/channels/web/turn", json={"session": s["session"], "text": "my customer ID is C 1 0 0 2"}).json()
    # the first thing they said is what the case is about, and the answer says both at once
    assert r["case_id"] and r["reply"].startswith("Thank you, Meera. I've found your account.") and "349" in r["reply"]
    assert engine.store.get_case(r["case_id"])["customer_id"] == "C-1002"
    assert not client.get("/api/channels").json()["contacts"]  # a call page session is not a contact


# ── webhooks for n8n, Make, Zapier ──────────────────────────────────────────
def test_the_generic_webhook_answers_inline_and_posts_events(client, engine, fake):
    assert client.post("/api/channels/hook", json={"from": "x", "text": "hi"}).status_code == 403
    client.put("/api/channels", json={"unknown": "C-1001", "hook": {"enabled": True, "token": "hooktok", "url": fake.url + "/n8n"}})
    assert client.post("/api/channels/hook", json={"from": "x", "text": "hi"}, headers={"X-Nirnaya-Token": "no"}).status_code == 403
    r = client.post("/api/channels/hook", json={"channel": "telegram", "from": "@aarav", "name": "Aarav", "text": FAILED_UPI},
                    headers={"X-Nirnaya-Token": "hooktok"}).json()
    assert r["action"] == "case" and "2,450" in (r["reply"] or "") and r["status"] == "resolved"
    assert {"key": "id:@aarav", "address": "@aarav", "kind": "id", "customer_id": "C-1001", "customer": "Aarav Sharma"} not in \
        client.get("/api/channels").json()["contacts"]  # unknown = C-1001 is not someone saying who they are
    ev = until(lambda: next((c for c in fake.to("/n8n") if c["body"].get("type") == "case.finished"), None))
    assert ev["body"]["case_id"] == r["case_id"] and ev["body"]["channel"] == "telegram" and ev["headers"]["X-Nirnaya-Token"] == "hooktok"
    # not waiting: the reply is POSTed to the URL instead
    # unknown senders count as Aarav here (unknown = C-1001), so this one is about Aarav's CityCabs payment
    r = client.post("/api/channels/hook?token=hooktok", json={"channel": "telegram", "from": "@aarav2", "wait": False,
                                                              "text": "My ₹799 payment to CityCabs failed but the money was debited"}).json()
    assert r["action"] == "case"
    out = until(lambda: next((c for c in fake.to("/n8n") if c["body"].get("type") == "reply" and c["body"]["to"] == "@aarav2"), None))
    assert "799" in out["body"]["text"] and out["body"]["case_id"] == r["case_id"]


# ── flows that start on a message and use the channels ──────────────────────
def test_a_flow_starts_on_a_whatsapp_message_and_answers_on_whatsapp_and_a_webhook(client, engine, fake):
    setup_meta(client, fake, accept="anyone")
    client.put("/api/channels", json={"unknown": "C-1002"})
    node = lambda i, t, **cfg: {"id": i, "type": t, "x": 0, "y": 0, "config": cfg}
    f = client.post("/api/flows", json={"name": "Thank on WhatsApp", "by": "Asha", "nodes": [
        node("s", "start", on="message", channel="whatsapp", contains="charged"),
        node("w", "whatsapp", to="{from}", text="Hi {name}, {case} went {route}. Thanks for writing."),
        node("h", "webhook", url=fake.url + "/flowhook", text="{result}")],
        "edges": [{"from": "s", "to": "w", "port": "next"}, {"from": "w", "to": "h", "port": "next"}]})
    assert f.status_code == 201, f.text
    assert f.json()["when_desc"] == "on a WhatsApp message with “charged”"
    bad = client.post("/api/flows", json={"name": "Both", "nodes": [node("s", "start", on="message", when="every day at 9am")], "edges": []})
    assert bad.status_code == 400 and "not both" in bad.json()["detail"]
    wa_post(client, wa_message("919222222222", DUPLICATE, "f1", name="Meera"))
    run = until(lambda: next((r for r in client.get("/api/flows").json()["runs"] if r["flow_id"] == f.json()["id"] and r["state"] == "done"), None))
    assert run["by"].startswith("WhatsApp ·")
    thanks = until(lambda: next((c for c in fake.to("/messages") if "Thanks for writing" in c["body"].get("text", {}).get("body", "")), None))
    assert thanks["body"]["to"] == "919222222222" and re.search(r"NR-\d+ went HEDGE", thanks["body"]["text"]["body"])
    hook = until(lambda: fake.to("/flowhook") and fake.to("/flowhook")[-1])
    assert hook["body"]["channel"] == "whatsapp" and hook["body"]["from"] == "919222222222" and hook["body"]["flow"] == "Thank on WhatsApp"
    # the step's own text is "text"; what the customer wrote is "message"
    assert re.match(r"NR-\d+ resolved · HEDGE", hook["body"]["text"]) and hook["body"]["message"] == DUPLICATE
    # a message without the word does not start it
    n = len(client.get("/api/flows").json()["runs"])
    wa_post(client, wa_message("919222222222", "Where is my refund for the BookNest order?", "f2", name="Meera"))
    time.sleep(1.0)
    assert len([r for r in client.get("/api/flows").json()["runs"] if r["flow_id"] == f.json()["id"]]) == 1
    assert len(client.get("/api/flows").json()["runs"]) == n


def test_a_send_node_that_is_not_set_up_fails_on_its_node_with_the_reason(client):
    node = lambda i, t, **cfg: {"id": i, "type": t, "x": 0, "y": 0, "config": cfg}
    f = client.post("/api/flows", json={"name": "Email nobody", "nodes": [node("s", "start"), node("e", "email", to="boss@bank.test", subject="Hi", text="Hello")],
                                        "edges": [{"from": "s", "to": "e", "port": "next"}]}).json()
    run = client.post(f"/api/flows/{f['id']}/run", json={"by": "Asha"}).json()
    done = until(lambda: next((r for r in client.get("/api/flows").json()["runs"] if r["id"] == run["id"] and r["state"] in ("done", "failed")), None))
    assert done["state"] == "failed" and "Channels → Email" in done["nodes"]["e"]["text"]
    assert client.post("/api/flows", json={"name": "Bad", "nodes": [node("s", "start"), node("e", "email", to="not-an-address", text="x")], "edges": []}).status_code == 400


# ── a server on the internet ────────────────────────────────────────────────
def test_the_access_key_locks_the_api_but_not_webhooks_or_the_call_page(client, monkeypatch):
    monkeypatch.setenv("NIRNAYA_ACCESS_KEY", "s3cret")
    r = client.get("/api/state")
    assert r.status_code == 401 and r.json()["key_required"]
    assert client.get("/api/state", headers={"X-Nirnaya-Key": "s3cret"}).status_code == 200
    client.cookies.set("nirnaya_key", "s3cret")
    assert client.get("/api/cases").status_code == 200
    client.cookies.clear()
    assert client.get("/api/trail/verify?key=s3cret").status_code == 200
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/channels/web/customers").status_code == 200
    assert client.post("/api/channels/whatsapp/webhook", content=b"{}").status_code == 403    # its own check, not the key
    assert client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).status_code == 401


# ── real SMTP and IMAP (GreenMail) ──────────────────────────────────────────
def _greenmail() -> bool:
    try:
        socket.create_connection(("127.0.0.1", 3143), 0.5).close()
        socket.create_connection(("127.0.0.1", 3025), 0.5).close()
        return True
    except OSError:
        return False


GM = {"enabled": True, "address": "support@nirnaya.test", "username": "support", "password": "secret",
      "imap_host": "127.0.0.1", "imap_port": 3143, "smtp_host": "127.0.0.1", "smtp_port": 3025,
      "smtp_security": "none", "receive": "imap", "send": "smtp", "accept": "contacts", "forward_to": "boss@bank.test"}


def deliver(frm, to, subject, text, **headers):
    raw = raw_email(frm, to, subject, text, **headers)
    with smtplib.SMTP("127.0.0.1", 3025) as s:
        s.sendmail(frm.split("<")[-1].strip(">"), [to], raw)
    return raw


def mailbox(login, password=None):
    """Read a GreenMail mailbox. Addresses it made up on delivery log in with the address as both."""
    import imaplib
    c = imaplib.IMAP4("127.0.0.1", 3143)
    try:
        c.login(login, password or login)
    except imaplib.IMAP4.error:
        return []  # GreenMail makes the mailbox when the first message for it arrives
    c.select("INBOX")
    _, data = c.uid("SEARCH", None, "ALL")
    out = []
    for uid in (data[0] or b"").split():
        _, parts = c.uid("FETCH", uid, "(BODY.PEEK[])")
        out.append(mail.email.message_from_bytes(next(p[1] for p in parts if isinstance(p, tuple)), policy=mail.email.policy.default))
    c.logout()
    return out


@pytest.mark.skipif(not _greenmail(), reason="no SMTP/IMAP test server on 127.0.0.1:3025/3143 (make test-mail)")
def test_email_round_trips_through_a_real_mail_server(client, engine):
    tag = str(time.time_ns())[-6:]
    cust, boss = f"aarav{tag}@customer.test", "boss@bank.test"
    # an old unread email is already in the mailbox: the first poll only remembers where the mailbox is
    deliver(f"Old <{cust}>", "support@nirnaya.test", "Old thread", "this was here before you connected")
    client.put("/api/channels", json={"email": GM})
    client.post("/api/channels/contacts", json={"address": cust, "customer_id": "C-1001"})
    client.post("/api/channels/contacts", json={"address": f"rohan{tag}@customer.test", "customer_id": "C-1003"})
    first = client.post("/api/channels/email/poll").json()
    assert first["read"] == 0 and first["started_fresh"]
    # a customer writes; the agents answer in the same thread
    deliver(f"Aarav Sharma <{cust}>", "support@nirnaya.test", f"Failed payment {tag}", FAILED_UPI, msg_id=f"<q{tag}@customer.test>")
    deliver(f"Shop <news{tag}@shop.test>", "support@nirnaya.test", "Big sale", "50% off", List_Unsubscribe="<mailto:u@shop.test>")
    deliver(f"Stranger <someone{tag}@else.test>", "support@nirnaya.test", "Hi", "Who is this?")
    polled = client.post("/api/channels/email/poll").json()
    assert polled["read"] == 3
    whats = sorted(r["action"] for r in polled["results"])
    assert whats == ["case", "ignored", "ignored"], polled
    case_id = next(r["case_id"] for r in polled["results"] if r["action"] == "case")
    until(lambda: engine.store.get_case(case_id)["status"] == "resolved")
    reply = until(lambda: next((m for m in mailbox(cust) if f"Failed payment {tag}" in str(m["Subject"])), None))
    assert reply["Subject"] == f"Re: Failed payment {tag}" and reply["In-Reply-To"] == f"<q{tag}@customer.test>"
    assert "2,450" in reply.get_content() and case_id in reply.get_content() and reply["Auto-Submitted"] == "auto-replied"
    # nothing went to the newsletter or the stranger
    assert not mailbox(f"news{tag}@shop.test") and not mailbox(f"someone{tag}@else.test")
    # an escalation is forwarded to the supervisor, who approves it by replying
    deliver(f"Rohan <rohan{tag}@customer.test>", "support@nirnaya.test", f"Fraud {tag}", UNAUTHORISED, msg_id=f"<f{tag}@customer.test>")
    polled = client.post("/api/channels/email/poll").json()
    fraud = polled["results"][0]["case_id"]
    until(lambda: engine.store.get_case(fraud).get("pending"))
    # (the boss's mailbox outlives test runs, so match this run's customer too)
    fwd = until(lambda: next((m for m in mailbox("boss", "secret") if fraud in str(m["Subject"])
                              and f"rohan{tag}" in m.get_content()), None), timeout=20)
    assert "needs approval" in fwd["Subject"] and "APPROVE" in fwd.get_content() and "18,500" in fwd.get_content()
    deliver(f"Boss <{boss}>", "support@nirnaya.test", "Re: " + str(fwd["Subject"]), "APPROVE\n\nOn ... wrote:\n> old",
            msg_id=f"<a{tag}@bank.test>", In_Reply_To=str(fwd["Message-ID"]))
    polled = client.post("/api/channels/email/poll").json()
    assert polled["results"][0]["action"] == "approval"
    until(lambda: engine.store.get_case(fraud)["status"] == "resolved")
    trail = client.get(f"/api/cases/{fraud}").json()["trail"]
    assert any(t["kind"] == "approval.granted" and "(email)" in t["actor"] for t in trail)
    confirm = until(lambda: next((m for m in mailbox("boss", "secret") if str(m["Subject"]).startswith("Re:")
                                  and m["In-Reply-To"] == f"<a{tag}@bank.test>"), None))
    assert confirm.get_content().startswith("Approved")
    credited = until(lambda: next((m for m in mailbox(f"rohan{tag}@customer.test") if "credit" in m.get_content().lower()), None))
    assert "18,500" in credited.get_content()
