"""Calls in Hindi and English, recorded, with a report.

A Twilio stand-in (a real local HTTP server) records each API request and serves a recording file; Twilio's
webhooks are posted signed, the way Twilio sends them.
"""
import json
import re
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from nirnaya import lingo
from nirnaya.api import create_app
from nirnaya.channels import voice
from nirnaya.understand import classify, extract_entities

PUBLIC = "https://nirnaya.example"
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb" * 400
HINDI_FAILED = "मेरा 2450 रुपये का पेमेंट फेल हो गया लेकिन पैसा कट गया, 3 दिन पहले"


class Twilio(ThreadingHTTPServer):
    def __init__(self, refuse_recording: bool = False):
        self.calls: list[dict] = []
        self.refuse_recording = refuse_recording
        super().__init__(("127.0.0.1", 0), H)
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_address[1]}"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body: bytes, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.server.calls.append({"method": "GET", "path": self.path, "headers": dict(self.headers)})
        if self.path.endswith(".mp3") and self.headers.get("Authorization", "").startswith("Basic "):
            return self._send(200, MP3, "audio/mpeg")
        self._send(404, b"{}")

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        body = dict(urllib.parse.parse_qsl(raw.decode()))
        self.server.calls.append({"method": "POST", "path": self.path, "body": body})
        if self.path.endswith("/Recordings.json"):
            if self.server.refuse_recording:
                return self._send(400, json.dumps({"code": 21220, "message": "Recording is not allowed on trial accounts for incoming calls"}).encode())
            return self._send(201, json.dumps({"sid": "RE100"}).encode())
        if self.path.endswith("/Calls.json"):
            return self._send(201, json.dumps({"sid": "CAout1"}).encode())
        self._send(200, b"{}")


@pytest.fixture
def twilio():
    t = Twilio()
    yield t
    t.shutdown()


@pytest.fixture
def client(engine, twilio):
    with TestClient(create_app(engine, background=False)) as c:
        c.put("/api/channels", json={"public_url": PUBLIC, "voice": {
            "enabled": True, "account_sid": "AC1", "auth_token": "authtok", "from_number": "+15550001111",
            "api_url": twilio.url, "language": "both", "record": True}})
        yield c


def tw(client, path_query, **form):
    sig = voice.signature("authtok", PUBLIC + path_query, form)
    return client.post(path_query, data=form, headers={"X-Twilio-Signature": sig})


def turn_of(xml):
    return re.search(r'action="([^"]+)"', xml).group(1).replace("&amp;", "&").replace(PUBLIC, "")


def follow(client, xml, sid, rounds=8):
    for _ in range(rounds):
        m = re.search(r"<Redirect method=\"POST\">([^<]+)</Redirect>", xml)
        if "<Gather" in xml or "<Hangup/>" in xml or not m:
            return xml
        xml = tw(client, m.group(1).replace("&amp;", "&").replace(PUBLIC, ""), CallSid=sid).text
    return xml


def until(fn, timeout=10.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(0.05)
    raise AssertionError("timed out")


# ── reading Hindi ───────────────────────────────────────────────────────────
@pytest.mark.parametrize("hindi,intent,amount", [
    (HINDI_FAILED, "failed_debit", 2450),
    ("कल कैफ़े पर मुझसे दो बार 349 रुपये काटे गए", "duplicate_charge", 349),
    ("यह 18500 रुपये का ट्रांजैक्शन मैंने नहीं किया", "unauthorized", 18500),
    ("मेरा रिफंड अभी तक नहीं आया", "refund_status", None),
    ("मेरा कार्ड ब्लॉक कर दो", "block_request", None),
])
def test_hindi_is_read_into_words_the_agents_understand(hindi, intent, amount):
    r = lingo.for_agents(hindi)
    assert r["lang"] == "hi" and r["via"] == "rules" and not lingo.has_devanagari(r["text"])
    assert classify(r["text"])["intent"] == intent
    assert extract_entities(r["text"]).get("amount") == amount


def test_language_detection_and_the_callers_side():
    assert lingo.detect("my refund is late") == "en"
    assert lingo.detect("mera paisa kat gaya") == "hi" and lingo.detect("पैसा") == "hi"
    assert lingo.transliterate("मेरा पैसा कट गया") == "mera paisa kat gaya"
    out = lingo.for_caller("Thank you, Aarav. I've found your account. How can I help you with your payment?", "hi")
    assert out["text"] == "धन्यवाद Aarav जी, आपका अकाउंट मिल गया है। बताइए, आपके पेमेंट में मैं क्या मदद करूँ?" and out["via"] == "fixed"
    assert lingo.for_caller("Anything", "en")["text"] == "Anything"
    assert lingo.numbers_kept("₹2,450 on 3 Oct", "३ अक्टूबर को ₹2450") and not lingo.numbers_kept("₹2,450", "₹2,540")


class FakeModel:
    enabled = True

    def __init__(self, answer):
        self.answer, self.asked = answer, []

    def translate(self, text, to):
        self.asked.append((text, to))
        return self.answer(text) if callable(self.answer) else self.answer


def test_the_model_translates_only_tokenised_text_and_must_keep_every_number(engine):
    # a model keeps the tokens it is given (the masked phone number) exactly as written
    ten = re.compile(r"\d{10}")
    m = FakeModel(lambda t: "My payment of 2450 rupees to " + ten.search(t).group(0) + " failed")
    r = lingo.for_agents("मेरा 2450 रुपये का पेमेंट 9876543210 पर फेल हो गया", m, engine.tok)
    assert r["via"] == "model" and "9876543210" not in m.asked[0][0]       # the model saw a token, not the number
    assert "9876543210" in r["text"]                                        # the caller's number comes back for the agents
    wrong = FakeModel("My payment of 4250 rupees failed")                    # a changed amount is never used
    assert lingo.for_agents("मेरा 2450 रुपये का पेमेंट फेल हो गया", wrong, engine.tok)["via"] == "rules"
    hi = FakeModel("आपके 2,450 रुपये वापस कर दिए गए हैं।")
    assert lingo.for_caller("I've reversed the ₹2,450.", "hi", hi)["via"] == "model"
    assert lingo.for_caller("I've reversed the ₹2,450.", "hi", FakeModel("आपके 245 रुपये"))["via"] == "as is"


# ── a phone call in Hindi, recorded, with its report ────────────────────────
def test_a_hindi_caller_is_understood_answered_in_hindi_recorded_and_reported(client, engine, twilio):
    xml = tw(client, "/api/channels/voice/twilio/incoming", CallSid="CA7", From="+919876543210", To="+15550001111").text
    assert "This call is recorded" in xml and 'language="en-IN"' in xml and "2 दबाएँ" in xml
    rec = until(lambda: [c for c in twilio.calls if c["path"].endswith("/Calls/CA7/Recordings.json")])
    assert rec[0]["body"]["RecordingChannels"] == "dual" and "/recording?c=voice%3ACA7" in rec[0]["body"]["RecordingStatusCallback"]
    turn = turn_of(xml)
    # they speak Hindi straight away: the agents read it, and the call carries on in Hindi
    xml = follow(client, tw(client, turn, CallSid="CA7", From="+919876543210", SpeechResult=HINDI_FAILED, Confidence="0.8").text, "CA7")
    case = next(c for c in engine.store.list_cases(10) if c["channel"] == "voice")
    assert case["intent"] == "failed_debit" and case["customer_id"] == "C-1001"
    assert 'voice="Polly.Aditi" language="hi-IN"' in xml and '<Gather input="dtmf speech" numDigits="1"' in xml
    assert 'language="hi-IN" hints=' in xml and "2,450" in xml
    conv = client.get("/api/channels/conversations/voice:CA7").json()
    said = next(m for m in conv["messages"] if m["dir"] == "in" and m.get("original"))
    assert said["original"] == HINDI_FAILED and said["lang"] == "hi" and "payment failed" in said["text"]
    # Twilio says the recording is ready: it is downloaded and kept
    assert tw(client, "/api/channels/voice/twilio/recording?c=voice%3ACA7", CallSid="CA7", RecordingSid="RE100",
              RecordingStatus="completed", RecordingUrl=f"{twilio.url}/2010-04-01/Accounts/AC1/Recordings/RE100",
              RecordingDuration="74").status_code == 200
    until(lambda: (client.get("/api/channels/call-reports/voice:CA7").json()["recording"]["status"] == "kept"))
    audio = client.get("/api/channels/call-reports/voice:CA7/audio")
    assert audio.status_code == 200 and audio.content == MP3 and audio.headers["content-type"] == "audio/mpeg"
    # hanging up ends the call; the report keeps what was said, both ways, and how the case ended
    tw(client, "/api/channels/voice/twilio/status?c=voice%3ACA7", CallSid="CA7", CallStatus="completed", CallDuration="81")
    rep = client.get("/api/channels/call-reports/voice:CA7").json()
    assert rep["duration"] == 81 and rep["langs"] == ["en", "hi"] and rep["direction"] == "in"
    assert rep["cases"][0]["id"] == case["id"] and rep["cases"][0]["outcome"] in ("accepted", "waiting")
    caller = next(t for t in rep["turns"] if t["who"] == "caller")
    assert caller["said"] == HINDI_FAILED and "payment failed" in caller["english"]
    assert any(t["who"] == "agent" and t["lang"] == "hi" for t in rep["turns"])
    assert "Spoke English and Hindi" in rep["summary"] and "Recording kept (1m 14s)" in rep["summary"]
    listed = client.get("/api/channels/call-reports").json()
    assert listed[0]["id"] == "voice:CA7" and listed[0]["recording"] == "kept" and listed[0]["cases"] == [case["id"]]
    page = client.get("/api/channels/call-reports/voice:CA7/html")
    assert page.status_code == 200 and "attachment" in page.headers["content-disposition"]
    assert HINDI_FAILED in page.text and "English: " in page.text and case["id"] in page.text
    # the report outlives the conversation
    convs = engine.store.kv_get("channel_convs")
    convs.pop("voice:CA7")
    engine.store.kv_set("channel_convs", convs)
    assert client.get("/api/channels/call-reports/voice:CA7").json()["duration"] == 81


def test_press_2_switches_to_hindi_and_1_back(client):
    xml = tw(client, "/api/channels/voice/twilio/incoming", CallSid="CA8", From="+919876543210", To="+15550001111").text
    turn = turn_of(xml)
    xml = tw(client, turn, CallSid="CA8", Digits="2").text
    assert "अब हम हिंदी में बात करेंगे" in xml and 'language="hi-IN"' in xml and "Polly.Aditi" in xml
    xml = tw(client, turn, CallSid="CA8", Digits="1").text
    assert "continue in English" in xml and 'language="en-IN" hints=' in xml


def test_a_trial_account_cannot_record_incoming_calls_and_the_report_says_so(engine):
    t = Twilio(refuse_recording=True)
    try:
        with TestClient(create_app(engine, background=False)) as client:
            client.put("/api/channels", json={"public_url": PUBLIC, "voice": {
                "enabled": True, "account_sid": "AC1", "auth_token": "authtok", "from_number": "+15550001111",
                "api_url": t.url, "record": True}})
            tw(client, "/api/channels/voice/twilio/incoming", CallSid="CA9", From="+919876543210", To="+15550001111")
            until(lambda: (client.get("/api/channels/conversations/voice:CA9").json().get("recording") or {}).get("status") == "failed")
            tw(client, "/api/channels/voice/twilio/status?c=voice%3ACA9", CallSid="CA9", CallStatus="completed", CallDuration="12")
            rep = client.get("/api/channels/call-reports/voice:CA9").json()
            assert rep["recording"]["status"] == "failed" and "trial" in rep["recording"]["error"]
            assert "Not recorded:" in rep["summary"]
            assert client.get("/api/channels/call-reports/voice:CA9/audio").status_code == 404
    finally:
        t.shutdown()


def test_recording_off_says_nothing_and_records_nothing(client, twilio):
    client.put("/api/channels", json={"voice": {"record": False, "language": "en-IN"}})
    xml = tw(client, "/api/channels/voice/twilio/incoming", CallSid="CA10", From="+919876543210", To="+15550001111").text
    assert "recorded" not in xml and "दबाएँ" not in xml and '<Gather input="speech"' in xml
    time.sleep(0.2)
    assert not [c for c in twilio.calls if "Recordings" in c["path"]]


def test_a_call_we_place_is_recorded_by_twilio(client, engine, twilio):
    c = engine.create_case("C-1002", "I was charged twice for ₹349 at CafeBrew yesterday", "chat")
    r = client.post(f"/api/cases/{c['id']}/call", json={"to": "98765 43210", "by": "Asha"})
    assert r.status_code == 200, r.text
    call = [x for x in twilio.calls if x["path"].endswith("/Calls.json")][-1]["body"]
    assert call["Record"] == "true" and call["RecordingChannels"] == "dual"
    assert call["RecordingStatusCallback"].startswith(PUBLIC + "/api/channels/voice/twilio/recording?c=voice:out-")


# ── the call page in Hindi ──────────────────────────────────────────────────
def test_the_call_page_speaks_hindi_and_leaves_a_report(client, engine):
    s = client.post("/api/channels/web/start", json={"customer_id": "C-1001", "lang": "hi"}).json()
    assert s["lang"] == "hi" and s["greeting"].startswith("नमस्ते Aarav जी")
    r = client.post("/api/channels/web/turn", json={"session": s["session"], "text": HINDI_FAILED, "lang": "hi"}).json()
    case_id = r["case_id"]
    assert case_id and engine.store.get_case(case_id)["intent"] == "failed_debit" and "2,450" in r["reply"]
    r = client.post("/api/channels/web/turn", json={"session": s["session"], "text": "धन्यवाद", "lang": "hi"}).json()
    assert r["reply"].startswith("आपका स्वागत है")
    end = client.post("/api/channels/web/end", json={"session": s["session"]}).json()
    rep = client.get(end["report"]).json()
    assert rep["channel"] == "call page" and rep["langs"] == ["hi"] and [c["id"] for c in rep["cases"]] == [case_id]
    assert rep["recording"]["status"] == "off" and len(rep["turns"]) >= 5


def test_the_call_page_keeps_its_own_recording_with_the_report(client):
    s = client.post("/api/channels/web/start", json={"customer_id": "C-1002", "lang": "en"}).json()
    client.post("/api/channels/web/turn", json={"session": s["session"], "text": "I was charged twice for ₹349 at CafeBrew yesterday"})
    webm = b"\x1aE\xdf\xa3" + b"\x00" * 2048
    url = f"/api/channels/web/recording?session={s['session']}&seconds=42"
    assert client.post(url, content=webm, headers={"Content-Type": "text/plain"}).status_code == 415
    assert client.post("/api/channels/web/recording?session=0123456789abcdef", content=webm,
                       headers={"Content-Type": "audio/webm"}).status_code == 404
    r = client.post(url, content=webm, headers={"Content-Type": "audio/webm;codecs=opus"})
    assert r.status_code == 200 and r.json()["bytes"] == len(webm)
    assert client.post(url, content=webm, headers={"Content-Type": "audio/webm"}).status_code == 409   # once per call
    end = client.post("/api/channels/web/end", json={"session": s["session"]}).json()
    rep = client.get(end["report"]).json()
    assert rep["recording"]["status"] == "kept" and rep["recording"]["duration"] == 42 and "Recording kept (42s)" in rep["summary"]
    audio = client.get(end["report"] + "/audio")
    assert audio.status_code == 200 and audio.content == webm and audio.headers["content-type"] == "audio/webm"


def test_twilios_trial_refusal_is_explained(client, engine, twilio):
    class Refuse(H):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self._send(400, json.dumps({"code": 400, "message": "Invalid or disallowed parameters provided - trial accounts "
                                        "have limited parameter access, upgrade your account to unlock full functionality"}).encode())
    t = Twilio()
    t.RequestHandlerClass = Refuse
    try:
        client.put("/api/channels", json={"voice": {"api_url": t.url}})
        c = engine.create_case("C-1002", "I was charged twice for ₹349 at CafeBrew yesterday", "chat")
        r = client.post(f"/api/cases/{c['id']}/call", json={"to": "+919930021383"})
        assert r.status_code >= 400 and "free trial only runs Twilio's own sample calls" in r.text and "/call" in r.text
    finally:
        t.shutdown()
