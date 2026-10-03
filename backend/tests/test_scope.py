"""Finance only: every way in (a customer message on any channel, a question to an agent, a department task)
refuses code, general knowledge and random questions, and lets every real banking message through. A model's
answer that drifts (code, its own OFF_TOPIC) never reaches anyone."""
import asyncio

import pytest

from nirnaya import benchmark, office, ops, scope
from nirnaya.engine import Engine
from nirnaya.presets import PRESETS
from tests.test_llm import Fake, model_on

FINANCE = [
    "my money got stuck in a UPI transfer", "paise kat gaye par payment fail ho gaya", "mera refund kab aayega",
    "I didn't get the OTP code", "what is the IFSC code of my branch", "the promo code did not give me cashback",
    "give me the code to unblock my card", "who is the RBI governor", "how is EMI interest calculated on my loan",
    "₹500 sent to my brother but he did not receive it", "my salary was not credited", "increase my UPI limit",
    "I bought a game and was charged twice", "the amount does not match my statement",
    "send me the code again", "I did not get the code",
]
STAFF_OK = ["what have you done today?", "anything waiting on me?", "status of NR-1001", "routines",
            "what can you do?", "which systems do you use?", "hi", "thanks", "who are you",
            "explain the function of the calibrator", "create a routine every weekday at 9am to write the digest"]
OFF = [
    ("who is the president of india", "general"), ("tell me a joke", "general"),
    ("what's the weather in delhi today", "general"), ("who won the ipl last year", "general"),
    ("write me a poem about love", "general"), ("capital of france?", "general"),
    ("write python code to sort a list", "code"), ("write a python program for an EMI calculator", "code"),
    ("def foo():\n    return 1", "code"), ("explain recursion in javascript", "code"),
    ("SELECT * FROM users WHERE id = 1", "code"), ("```js\nconsole.log(1)\n```", "code"),
    ("fix my code please", "code"), ("generate a website for my shop", "code"),
]


@pytest.fixture
def eng(store, calibrator):
    return Engine(store, step_delay=0, calibrator=calibrator)


def test_every_sample_and_benchmark_message_is_in_scope():
    texts = [p["text"] for p in PRESETS] + [t for s in benchmark.SCENARIOS for t in s["phrasings"]]
    bad = [t for t in texts if not scope.check(t, scope.CUSTOMER)["in_scope"]]
    assert texts and not bad, bad


def test_real_banking_phrasings_pass_and_staff_can_ask_about_their_work():
    assert [t for t in FINANCE if not scope.check(t, scope.CUSTOMER)["in_scope"]] == []
    assert [t for t in STAFF_OK if not scope.check(t, scope.STAFF)["in_scope"]] == []


@pytest.mark.parametrize("text,category", OFF)
def test_off_topic_is_refused_for_customers_and_staff(text, category):
    for who in (scope.CUSTOMER, scope.STAFF):
        got = scope.check(text, who)
        assert not got["in_scope"] and got["category"] == category, (who, text, got)


def test_the_model_decides_what_the_words_cannot():
    class Stub:
        enabled, asked = True, []

        def in_scope(self, text, audience):
            self.asked.append(text)
            return False
    m = Stub()
    got = scope.check("what is 2+2", scope.CUSTOMER, m)
    assert not got["in_scope"] and got["by"] == "model" and m.asked == ["what is 2+2"]
    scope.check("refund my ₹349", scope.CUSTOMER, m)                 # clear from the words: not asked
    assert m.asked == ["what is 2+2"]
    assert scope.check("what is 2+2", scope.CUSTOMER)["in_scope"]   # no model: the desk asks which payment


def test_an_off_topic_customer_message_is_refused_with_no_money_moved(eng):
    before = len(eng.rails.state["txns"])
    c = eng.create_case("C-1001", "Who is the president of India?", "chat")
    c = asyncio.run(eng.run(c["id"]))
    assert c["route"] == "REFUSE" and c["status"] == "refused" and c["scope"]["category"] == "general"
    assert c["conversation"][-1]["text"].startswith("I can only help with banking and payments")
    assert not c.get("decisions") and len(eng.rails.state["txns"]) == before
    assert any(t["kind"] == "scope.refused" for t in eng.trail.entries(c["id"]))
    c = asyncio.run(eng.run(eng.create_case("C-1001", "write python code for a calculator", "chat")["id"]))
    assert c["route"] == "REFUSE" and c["scope"]["category"] == "code"


def test_agents_refuse_off_topic_questions_and_tasks(eng, monkeypatch):
    from fastapi.testclient import TestClient
    from nirnaya.api import create_app
    with TestClient(create_app(eng, background=False)) as cl:
        for q in ("write python code to reverse a string", "who is the president of india"):
            r = cl.post("/api/office/chat", json={"agent": "triage", "text": q, "by": "Asha"}).json()
            assert r["reply"].startswith("I only work on banking and payments") and r["via"] == "finance-only guard"
            assert r["answered"]["via"] == "finance-only guard"
            assert cl.post("/api/agents/triage/ask", json={"question": q}).json()["answer"].startswith("I only work")
        ok = cl.post("/api/office/chat", json={"agent": "triage", "text": "what have you done today?"}).json()
        assert not ok["reply"].startswith("I only work") and not ok.get("refused")
        assert ops.interpret("oversight", "write a python script")["kind"] == "off_topic"
        r = cl.post("/api/office/tasks", json={"dept": "oversight", "text": "write a python script to scrape news"})
        assert r.status_code == 400 and "Finance only" in r.json()["detail"]
        r = cl.post("/api/office/tasks", json={"dept": "intake", "text": "who is the prime minister of india"})
        assert r.status_code == 400


def test_a_model_answer_with_code_or_its_off_topic_signal_never_goes_out(store, calibrator):
    f = Fake()
    try:
        f.models["groq"] = [{"id": "openai/gpt-oss-20b"}]
        f.behaviour["groq"] = [("ok", "Sure:\n```python\nprint(emi(5000, 12))\n```")]
        e = Engine(store, step_delay=0, llm=model_on(f, "groq", store=store), calibrator=calibrator)
        out = asyncio.run(office.answer(e, "triage", "how does the desk work out an EMI refund?"))
        assert out["answer"].startswith("I only work on banking") and out["via"] == "finance-only guard"
        f.behaviour["groq"] = [("ok", "OFF_TOPIC")]
        assert asyncio.run(office.answer(e, "triage", "tell me about the desk"))["refused"] == "model"
        f.behaviour["groq"] = [("ok", "def refund(): pass")]
        assert e.llm.draft_reply(["refund of ₹349"], "We have refunded ₹349.", "en") is None
        assert "OFF_TOPIC" in e.llm.ask_agent.__doc__ and "OFF_TOPIC" in scope.RULE
        posted = f.posts("groq")[0]["messages"][0]["content"]
        assert "Never write, explain or fix code" in posted                 # every prompt carries the rule
        # a call's translation (Hindi ↔ English) carries it too, and code or OFF_TOPIC is never spoken
        f.behaviour["groq"] = [("ok", "```python\nprint('hi')\n```")]
        assert e.llm.translate("mera paisa kat gaya", "English") is None
        assert "Never write, explain or fix code" in f.posts("groq")[-1]["messages"][0]["content"]
        f.behaviour["groq"] = [("ok", "OFF_TOPIC")]
        assert e.llm.translate("who is the prime minister", "Hindi") is None
    finally:
        f.server.shutdown()
