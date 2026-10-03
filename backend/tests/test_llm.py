"""The language model layer: free providers in order, a 429 moves on to the next, broken JSON from small
models is still read, OpenRouter only ever uses free models, and with nothing set up the rules carry on.

The providers are stood in for by a local OpenAI-compatible server, one path prefix per provider, that
answers the way the real ones do (including their 429s). NIRNAYA_TEST_LLM_URL=http://127.0.0.1:8089/v1
also runs a real local model (llamafile, Ollama, LM Studio) through the whole case.
"""
import asyncio
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from nirnaya import llm as llm_mod
from nirnaya.engine import Engine
from nirnaya.llm import LLM, extract_json, normalise_extract


class Fake:
    """A stand-in for several providers at once: /<provider>/v1/models and /<provider>/v1/chat/completions."""

    def __init__(self):
        self.calls: list[tuple[str, dict, dict]] = []
        self.behaviour: dict[str, list] = {}     # provider → answers to give, in turn (the last one repeats)
        self.models: dict[str, list[dict]] = {}
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body, headers=None):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                pid = self.path.split("/")[1]
                fake.calls.append((pid, {"path": self.path}, dict(self.headers)))
                self._send(200, {"object": "list", "data": fake.models.get(pid, [{"id": f"{pid}-model"}])})

            def do_POST(self):
                pid = self.path.split("/")[1]
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
                fake.calls.append((pid, body, dict(self.headers)))
                seq = fake.behaviour.get(pid) or [("ok", "OK")]
                kind, value = seq.pop(0) if len(seq) > 1 else seq[0]
                if kind == "429":
                    return self._send(429, {"error": {"message": "Rate limit reached for model"}}, {"Retry-After": "120"})
                if kind == "401":
                    return self._send(401, {"error": {"message": "Invalid API Key"}})
                if kind == "no_json_mode" and "response_format" in body:
                    return self._send(400, {"error": {"message": "response_format is not supported by this model"}})
                if kind == "no_json_mode":
                    kind, value = "ok", value
                self._send(200, {"id": "x", "object": "chat.completion", "model": body.get("model"),
                                 "choices": [{"index": 0, "finish_reason": "stop",
                                              "message": {"role": "assistant", "content": value}}]})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def base(self, pid):
        return f"{self.url}/{pid}/v1"

    def posts(self, pid):
        return [b for p, b, _ in self.calls if p == pid and "messages" in b]


@pytest.fixture
def fake():
    f = Fake()
    yield f
    f.server.shutdown()


def model_on(fake, *pids, store=None, **extra):
    m = LLM(store, off=False)
    m.update({"order": list(pids), "providers": {
        p: {"enabled": True, "key": "test-key", "base_url": fake.base(p), **extra.get(p, {})} for p in pids} | {
        p: {"enabled": False} for p in llm_mod.PROVIDERS if p not in pids}})
    return m


EXTRACT = '{"intent": "duplicate_charge", "amount": 349, "days_ago": 1, "merchant": "CafeBrew", "language": "en"}'


def test_nothing_set_up_means_rules_only(monkeypatch):
    for v in ("GROQ_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "OLLAMA_HOST",
              "NIRNAYA_LLM_URL"):
        monkeypatch.delenv(v, raising=False)
    m = LLM(off=False)
    m.update({"providers": {"ollama": {"base_url": "http://127.0.0.1:9"}}})  # nothing listens on port 9
    assert not m.enabled and m.extract("charged twice") is None and m.summary()["enabled"] is False
    assert LLM(off=True).enabled is False


def test_a_429_moves_on_to_the_next_free_provider_and_rests_the_first(fake):
    fake.behaviour["groq"] = [("429", None)]
    fake.behaviour["gemini"] = [("ok", EXTRACT)]
    m = model_on(fake, "groq", "gemini")
    got = m.extract("I was charged twice ₹349 at CafeBrew yesterday")
    assert got == {"intent": "duplicate_charge", "amount": 349.0, "days_ago": 1, "merchant": "CafeBrew", "language": "en"}
    assert m.last["provider"] == "gemini" and m.summary()["provider"] == "gemini"
    d = {r["id"]: r for r in m.describe()["providers"]}
    assert d["groq"]["resting"] >= 100 and "429" in d["groq"]["error"]   # Retry-After: 120
    n = len(fake.posts("groq"))
    m.extract("again")                                                    # groq is resting: not asked
    assert len(fake.posts("groq")) == n and len(fake.posts("gemini")) == 2


def test_each_model_has_its_own_quota_so_the_next_free_model_answers_before_the_provider_rests(fake):
    fake.models["groq"] = [{"id": "openai/gpt-oss-20b"}, {"id": "llama-3.1-8b-instant"}]
    fake.behaviour["groq"] = [("429", None), ("ok", EXTRACT)]
    m = model_on(fake, "groq")
    assert m.extract("I was charged twice ₹349 at CafeBrew yesterday")["intent"] == "duplicate_charge"
    assert [b["model"] for b in fake.posts("groq")] == ["openai/gpt-oss-20b", "llama-3.1-8b-instant"]
    assert m.last["model"] == "llama-3.1-8b-instant"
    assert {r["id"]: r for r in m.describe()["providers"]}["groq"]["resting"] == 0   # Groq itself carries on
    m.extract("again")                                     # the tired model is not asked until its quota is back
    assert fake.posts("groq")[-1]["model"] == "llama-3.1-8b-instant"
    fake.behaviour["groq"] = [("429", None)]               # now that one is out too: Groq rests, the rules carry on
    assert m.extract("and again") is None
    assert {r["id"]: r for r in m.describe()["providers"]}["groq"]["resting"] >= 100


def test_all_providers_out_of_quota_falls_back_to_the_rules(fake, store, calibrator):
    fake.behaviour["groq"] = [("429", None)]
    fake.behaviour["mistral"] = [("401", None)]
    m = model_on(fake, "groq", "mistral", store=store)
    e = Engine(store, step_delay=0, llm=m, calibrator=calibrator)
    c = e.create_case("C-1002", "I was charged twice ₹349 at CafeBrew yesterday", "chat")
    c = asyncio.run(e.run(c["id"]))
    assert c["status"] == "resolved" and c["understanding"]["source"] != "llm" and "llm" not in c["understanding"]
    assert "groq" in m.error.lower() or "Groq" in m.error


def test_a_model_without_json_mode_is_asked_again_plainly(fake):
    fake.behaviour["openrouter"] = [("no_json_mode", "Sure! " + EXTRACT + " Hope that helps.")]
    fake.models["openrouter"] = [{"id": "big/model", "pricing": {"prompt": "0.000002", "completion": "0.000004"}},
                                 {"id": "meta/llama-free:free", "pricing": {"prompt": "0", "completion": "0"}},
                                 {"id": "sneaky/paid:free", "pricing": {"prompt": "0.0001", "completion": "0"}}]
    m = model_on(fake, "openrouter")
    assert m.extract("charged twice")["intent"] == "duplicate_charge"
    posts = fake.posts("openrouter")
    assert "response_format" in posts[0] and "response_format" not in posts[1]
    assert {p["model"] for p in posts} == {"meta/llama-free:free"}       # only a model that is free
    assert m.models("openrouter") == ["meta/llama-free:free"]
    with pytest.raises(ValueError, match="free models only"):
        m.update({"providers": {"openrouter": {"model": "big/model"}}})


def test_small_model_output_is_read_and_cleaned():
    # what Llama 3.2 1B (llamafile) really answered: a stray brace and its end-of-turn token
    raw = '{"intent": "duplicate_charge", "amount": 349.0, "days_ago": 1, "merchant": "CafeBrew", "language": "en", ' \
          '"other": "Customer was charged twice"}}<|eot_id|>'
    assert normalise_extract(extract_json(raw))["intent"] == "duplicate_charge"
    assert extract_json('```json\n{"a": "x}y"}\n```')["a"] == "x}y"
    assert normalise_extract({"intent": "Refund_Status", "amount": "₹1,299", "days_ago": "4", "merchant": "null",
                              "language": "Hinglish"}) == {"intent": "refund_status", "amount": 1299.0, "days_ago": 4,
                                                           "merchant": None, "language": "hinglish"}
    assert normalise_extract({"intent": "make me rich", "amount": -5})["intent"] == "other"
    assert llm_mod.clean_text("<think>hmm</think> Hello <|im_end|>") == "Hello"


def test_reasoning_effort_low_for_gpt_oss_on_groq(fake):
    fake.models["groq"] = [{"id": "whisper-large-v3"}, {"id": "openai/gpt-oss-20b"}, {"id": "openai/gpt-oss-120b"}]
    fake.behaviour["groq"] = [("ok", "Namaste! Your refund is on its way.")]
    m = model_on(fake, "groq")
    assert m.draft_reply(["refund raised"], "Your refund is raised.", "en").startswith("Namaste")
    body = fake.posts("groq")[0]
    assert body["model"] == "openai/gpt-oss-20b" and body["reasoning_effort"] == "low"   # whisper is skipped
    hdrs = [h for p, b, h in fake.calls if p == "groq" and "messages" in b][0]
    assert hdrs["Authorization"] == "Bearer test-key"


def test_keys_are_kept_cleared_and_never_shown(fake, monkeypatch, store):
    m = model_on(fake, "groq", store=store)
    m.update({"providers": {"groq": {"key": ""}}})                 # "" keeps the saved key
    assert m.config()["providers"]["groq"]["key"] == "test-key"
    shown = json.dumps(m.describe())
    assert "test-key" not in shown and m.describe()["providers"][0]["key_set"] is True
    m.update({"providers": {"groq": {"key": None}}})               # null clears it
    assert not m.config()["providers"]["groq"]["key"] and "groq" not in m.ready()
    monkeypatch.setenv("GROQ_API_KEY", "from-env")
    row = next(r for r in m.describe()["providers"] if r["id"] == "groq")
    assert row["key_set"] and row["locked"] == ["key"] and "groq" in m.ready()


def test_settings_test_lists_models_and_says_ok(fake):
    fake.models["mistral"] = [{"id": "mistral-embed"}, {"id": "mistral-small-latest"}, {"id": "codestral-latest"}]
    m = model_on(fake, "mistral")
    r = m.test("mistral")
    assert r["ok"] and r["model"] == "mistral-small-latest" and r["models"] == ["mistral-small-latest"]
    fake.behaviour["mistral"] = [("401", None)]
    r = m.test("mistral")
    assert not r["ok"] and "refused" in r["error"]


def test_the_engine_uses_a_free_model_and_the_guard_still_checks_its_reply(fake, store, calibrator):
    fake.behaviour["groq"] = [("ok", EXTRACT), ("ok", "Hi Meera, we have refunded ₹349 for the double charge at CafeBrew.")]
    m = model_on(fake, "groq", store=store)
    e = Engine(store, step_delay=0, llm=m, calibrator=calibrator)
    c = e.create_case("C-1002", "I was charged twice ₹349 at CafeBrew yesterday", "chat")
    c = asyncio.run(e.run(c["id"]))
    assert c["understanding"]["llm"]["intent"] == "duplicate_charge"
    assert c["guard"]["llm_draft"] is not None                      # the draft went through the Promise Guard
    assert "9876543210" not in json.dumps(fake.posts("groq"))       # the model only saw tokenised text


def test_an_agent_answer_says_which_free_model_wrote_it(fake, store, calibrator):
    from nirnaya import office
    fake.models["groq"] = [{"id": "openai/gpt-oss-20b"}]
    fake.behaviour["groq"] = [("ok", "Nothing on my desk yet: no cases have reached me today.")]
    e = Engine(store, step_delay=0, llm=model_on(fake, "groq", store=store), calibrator=calibrator)
    agent = next(iter(e.roster.agents))
    out = asyncio.run(office.answer(e, agent, "what have you done today?"))
    assert out["answer"].startswith("Nothing on my desk") and out["via"] == "Groq · openai/gpt-oss-20b"
    e.llm = LLM(store, off=True)                                     # no model: the rules answer, with no "via"
    assert asyncio.run(office.answer(e, agent, "what have you done today?"))["via"] is None


def test_api_settings_round_trip(fake, monkeypatch, tmp_path, calibrator):
    from fastapi.testclient import TestClient
    from nirnaya.api import create_app
    monkeypatch.setenv("NIRNAYA_LLM", "auto")
    for v in ("GROQ_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY"):
        monkeypatch.delenv(v, raising=False)
    from nirnaya.store import Store
    eng = Engine(Store(tmp_path / "a.db"), step_delay=0, calibrator=calibrator)
    with TestClient(create_app(eng, background=False)) as cl:
        r = cl.put("/api/llm", json={"order": ["gemini", "groq"], "providers": {
            "gemini": {"enabled": True, "key": "g-key", "base_url": fake.base("gemini")},
            "ollama": {"enabled": False}}}).json()
        assert [p["id"] for p in r["providers"]][:2] == ["gemini", "groq"] and r["active"]["id"] == "gemini"
        assert "g-key" not in json.dumps(r)
        assert cl.post("/api/llm/test/gemini").json()["ok"]
        s = cl.get("/api/state").json()["integrations"]["llm"]
        assert s["enabled"] and s["provider"] == "gemini" and s["label"] == "Google Gemini"
        assert cl.put("/api/llm", json={"providers": {"openrouter": {"model": "paid/model"}}}).status_code == 400
        assert cl.post("/api/llm/test/nope").status_code == 404


REAL = os.environ.get("NIRNAYA_TEST_LLM_URL")


@pytest.mark.skipif(not REAL, reason="set NIRNAYA_TEST_LLM_URL to a local OpenAI-compatible model server")
def test_a_real_local_model_classifies_and_drafts(store, calibrator):
    m = LLM(store, off=False)
    m.update({"order": ["custom"], "providers": {"custom": {"enabled": True, "base_url": REAL},
                                                 **{p: {"enabled": False} for p in llm_mod.PROVIDERS if p != "custom"}}})
    assert m.test("custom")["ok"]
    for text, want in [("I was charged twice for ₹349 at CafeBrew yesterday", "duplicate_charge"),
                       ("Someone used my card for ₹18,500 at QuickPay Store, it was not me", "unauthorized"),
                       ("My UPI payment of ₹2,450 failed but money got debited 3 days ago", "failed_debit")]:
        got = m.extract(text)
        assert got and got["intent"] in llm_mod.INTENTS, got
        print(f"{want:>18} → {got}")
    e = Engine(store, step_delay=0, llm=m, calibrator=calibrator)
    c = e.create_case("C-1002", "I was charged twice ₹349 at CafeBrew yesterday", "chat")
    c = asyncio.run(e.run(c["id"]))
    assert c["status"] == "resolved" and "llm" in c["understanding"] and m.last["provider"] == "custom"
    print("reply:", c["conversation"][-1]["text"])
