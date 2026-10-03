"""HTTP routes for the channels: provider webhooks (each checks its own signature), the phone-call loop,
the browser call page, the generic webhook for n8n and friends, and the settings the app edits."""
from __future__ import annotations

import asyncio
import hmac
import ipaddress
import re
import time
import urllib.parse
import uuid
from typing import Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field

from .. import lingo
from ..team import clean_name
from . import calls, mail, voice, whatsapp
from .hub import BYE, Channels
from .http import ChannelError


class Patch(BaseModel):
    model_config = {"extra": "allow"}


class Contact(BaseModel):
    address: str = Field(min_length=3, max_length=200)
    customer_id: str


class Test(BaseModel):
    channel: str
    to: str = ""
    text: str = Field("Hello from Nirnaya: this is a test message.", max_length=2000)
    subject: str = "Nirnaya test"
    by: str | None = None


class Say(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    by: str | None = None


class Forward(BaseModel):
    to: str = ""
    note: str = Field("", max_length=1000)
    by: str | None = None


class CallReq(BaseModel):
    to: str = ""
    text: str = Field("", max_length=1000)
    by: str | None = None


class WebStart(BaseModel):
    customer_id: str | None = None
    name: str | None = None
    lang: str = "en"          # "en" or "hi": what the caller speaks and hears


class WebTurn(BaseModel):
    session: str = Field(min_length=6, max_length=40)
    text: str = Field(min_length=1, max_length=2000)
    mode: str = "voice"
    lang: str | None = None


class WebEnd(BaseModel):
    session: str = Field(min_length=6, max_length=40)


class HookIn(BaseModel):
    channel: str = Field("webhook", max_length=40)
    sender: str = Field(alias="from", min_length=1, max_length=200)
    name: str = ""
    text: str = Field(min_length=1, max_length=4000)
    wait: bool = True
    model_config = {"populate_by_name": True}


def _base(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto.split(',')[0].strip()}://{host.split(',')[0].strip()}"


def _private(request: Request) -> bool:
    try:
        ip = ipaddress.ip_address((request.client.host if request.client else "") or "")
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private


def register(app: FastAPI, E: Callable, C: Callable[[], Channels]) -> None:
    # ── settings, status, contacts ───────────────────────────────────────────
    @app.get("/api/channels")
    def channels_get(request: Request):
        return C().snapshot(_base(request))

    @app.put("/api/channels")
    def channels_put(body: Patch, request: Request):
        try:
            C().update(body.model_dump())
        except ValueError as e:
            raise HTTPException(400, str(e))
        return C().snapshot(_base(request))

    @app.post("/api/channels/contacts")
    def contact_add(body: Contact):
        try:
            return C().link(body.address, body.customer_id)
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.delete("/api/channels/contacts")
    def contact_remove(address: str):
        C().unlink(address)
        return {"ok": True}

    @app.post("/api/channels/test")
    async def channel_test(body: Test, request: Request):
        try:
            if body.channel == "voice":
                return await C().call(body.to, body.text, by=body.by, base=_base(request))
            if body.channel == "hook":
                await asyncio.to_thread(C()._post_hook, {"type": "test", "text": body.text})
                st = C().status["hook"]
                if st.get("ok") is False:
                    raise ChannelError(st.get("error") or "the webhook did not answer")
                return {"ok": True}
            return await C().send(body.channel, body.to, body.text, subject=body.subject, by=body.by)
        except (ChannelError, ValueError) as e:
            raise HTTPException(400, str(e))

    @app.post("/api/channels/email/poll")
    async def email_poll():
        if not C().config()["email"]["enabled"]:
            raise HTTPException(400, "switch email on first (Channels → Email)")
        try:
            return await C().poll_email()
        except ChannelError as e:
            raise HTTPException(400, str(e))

    @app.get("/api/channels/conversations")
    def conversations(limit: int = 60):
        return [C()._summary(c) for c in C().conversations(max(1, min(limit, 300)))]

    @app.get("/api/channels/conversations/{conv_id:path}")
    def conversation(conv_id: str):
        conv = C().conversation(conv_id)
        if not conv:
            raise HTTPException(404, f"no conversation {conv_id}")
        call = conv["channel"] in ("voice", "web")
        return {**C()._summary(conv), "messages": conv["messages"], "lang": conv.get("lang"),
                "recording": conv.get("recording") if call else None,
                "report": f"/api/channels/call-reports/{conv_id}" if call else None}

    @app.post("/api/channels/reply/{conv_id:path}")
    async def conv_reply(conv_id: str, body: Say):
        try:
            return await C().reply(conv_id, body.text, by=clean_name(body.by) if body.by else None)
        except KeyError:
            raise HTTPException(404, f"no conversation {conv_id}")
        except (ChannelError, ValueError) as e:
            raise HTTPException(400, str(e))

    @app.get("/api/cases/{case_id}/channel")
    def case_channel(case_id: str):
        conv = C().case_conversation(case_id)
        return {**C()._summary(conv), "messages": conv["messages"]} if conv else None

    @app.post("/api/cases/{case_id}/forward")
    async def case_forward(case_id: str, body: Forward):
        to = body.to or C().config()["email"].get("forward_to") or ""
        try:
            return await C().forward(case_id, to, body.note, by=clean_name(body.by) if body.by else None)
        except KeyError:
            raise HTTPException(404, f"no case {case_id}")
        except (ChannelError, ValueError) as e:
            raise HTTPException(400, str(e))

    @app.post("/api/cases/{case_id}/call")
    async def case_call(case_id: str, body: CallReq, request: Request):
        e = E()
        case = e.store.get_case(case_id)
        if not case:
            raise HTTPException(404, f"no case {case_id}")
        conv = C().case_conversation(case_id)
        to = body.to or (conv["address"] if conv and conv["channel"] in ("whatsapp", "voice") else "") or \
            (e.rails.customer(case["customer_id"]) or {}).get("phone", "")
        last = next((m["text"] for m in reversed(case.get("conversation") or []) if m["role"] == "nirnaya"), "")
        text = body.text or (f"Hello {case['customer_name']}, this is Nirnaya calling about your case {case_id}. " + last)
        try:
            return await C().call(to, text, case_id=case_id, by=clean_name(body.by) if body.by else None, base=_base(request))
        except (ChannelError, ValueError) as ex:
            raise HTTPException(400, str(ex))

    # ── email in, from a forwarder (Cloudflare Email Worker, n8n, Postmark…) ──
    @app.post("/api/channels/email/inbound")
    async def email_inbound(request: Request):
        cfg = C().config()["email"]
        token = request.headers.get("x-nirnaya-token") or request.query_params.get("token") or ""
        if not cfg["enabled"] or cfg["receive"] != "webhook":
            raise HTTPException(403, "email by webhook is switched off (Channels → Email → Receive: webhook)")
        if not cfg.get("inbound_token") or not hmac.compare_digest(token, cfg["inbound_token"]):
            raise HTTPException(403, "wrong or missing token")
        try:
            body = await request.json()
        except ValueError:
            raise HTTPException(400, "send JSON: {from, subject, text} or {raw}")
        m = mail.from_json(body if isinstance(body, dict) else {})
        if not m["from"]:
            raise HTTPException(400, "no sender address")
        return await C().receive_email(m)

    # ── WhatsApp: Meta Cloud API ─────────────────────────────────────────────
    @app.get("/api/channels/whatsapp/webhook")
    def wa_verify(request: Request):
        challenge = whatsapp.meta_verify(C().config()["whatsapp"], request.query_params)
        if challenge is None:
            raise HTTPException(403, "verify token does not match (Channels → WhatsApp → Verify token)")
        return PlainTextResponse(challenge)

    @app.post("/api/channels/whatsapp/webhook")
    async def wa_webhook(request: Request):
        cfg = C().config()["whatsapp"]
        body = await request.body()
        if not cfg["enabled"] or cfg["provider"] != "meta":
            raise HTTPException(403, "WhatsApp (Meta) is switched off")
        if not whatsapp.meta_signature_ok(cfg.get("app_secret") or "", body, request.headers.get("x-hub-signature-256")):
            raise HTTPException(403, "bad signature: set the app secret (Channels → WhatsApp) to the one in Meta's app settings")
        try:
            payload = await request.json()
        except ValueError:
            raise HTTPException(400, "not JSON")
        msgs, statuses = whatsapp.meta_parse(payload)
        hub = C()
        for s in statuses:
            _status(hub, "whatsapp", s)
        for m in msgs:
            asyncio.get_running_loop().create_task(_wa_in(hub, cfg, m))
        return {"ok": True, "messages": len(msgs), "statuses": len(statuses)}

    async def _wa_in(hub: Channels, cfg: dict, m: dict) -> None:
        r = await hub.receive("whatsapp", m["from"], m["text"], name=m["name"], msg_id=m["msg_id"])
        # blue ticks only for messages we act on: an ignored stranger should not look read
        if r.get("action") not in ("ignored", "duplicate") and cfg.get("provider") == "meta" and m.get("msg_id"):
            await asyncio.to_thread(whatsapp.meta_mark_read, cfg, m["msg_id"])

    # ── WhatsApp: WAHA (self-hosted) ─────────────────────────────────────────
    @app.post("/api/channels/waha/webhook")
    async def waha_webhook(request: Request):
        cfg = C().config()["whatsapp"]
        body = await request.body()
        if not cfg["enabled"] or cfg["provider"] != "waha":
            raise HTTPException(403, "WhatsApp (WAHA) is switched off")
        key = cfg.get("waha_hmac_key") or ""
        if not key and not _private(request):
            raise HTTPException(403, "set an HMAC key (Channels → WhatsApp) to accept WAHA over the internet")
        if key and not whatsapp.waha_signature_ok(key, body, request.headers.get("x-webhook-hmac")):
            raise HTTPException(403, "bad signature (check WHATSAPP_HOOK_HMAC_KEY in WAHA)")
        try:
            payload = await request.json()
        except ValueError:
            raise HTTPException(400, "not JSON")
        msgs = whatsapp.waha_parse(payload)
        hub = C()
        for m in msgs:
            asyncio.get_running_loop().create_task(hub.receive("whatsapp", m["from"], m["text"], name=m["name"],
                                                               msg_id=m["msg_id"]))
        return {"ok": True, "messages": len(msgs)}

    # ── phone calls: Twilio ──────────────────────────────────────────────────
    # Each call keeps its language ("en" or "hi"): the caller can press 2 or simply speak Hindi. What they say
    # is put into English (or Hinglish) for the agents (lingo.for_agents) and the answer goes back in their
    # language (lingo.for_caller); both are kept in the call's transcript (calls.note) for its report.
    async def _twilio(request: Request) -> tuple[dict, dict]:
        cfg = C().config()
        v = cfg["voice"]
        if not v["enabled"]:
            raise HTTPException(403, "phone calls are switched off")
        form = dict(await request.form())
        public = cfg["public_url"] or _base(request)
        url = public + request.url.path + (f"?{request.url.query}" if request.url.query else "")
        if not voice.signature_ok(v.get("auth_token") or "", url, form, request.headers.get("x-twilio-signature")):
            raise HTTPException(403, "bad Twilio signature: check the auth token and the public URL")
        return v, form

    def _xml(t: voice.TwiML) -> Response:
        return Response(t.xml(), media_type="text/xml")

    def _url(public: str, path: str, **q) -> str:
        return f"{public}/api/channels/voice/twilio/{path}?" + urllib.parse.urlencode(q)

    def _public(request: Request) -> str:
        return C().config()["public_url"] or _base(request)

    def _lang(conv: dict | None, v: dict) -> str:
        return (conv or {}).get("lang") or voice.first_lang(v)

    def _set_lang(cid: str, lang: str) -> None:
        conv = C().conversation(cid)
        if conv and conv.get("lang") != lang:
            conv["lang"] = lang
            C()._put(conv)

    def _offer(v: dict, lang: str) -> list[tuple[str, str]]:
        """On a line that takes both, an English caller hears how to switch to Hindi."""
        return [(lingo.phrase("press_2", "hi"), "hi")] if v.get("language") == "both" and lang == "en" else []

    def _speak(cid: str, text: str, lang: str) -> str:
        """The agents' words in the caller's language, noted in the transcript."""
        out = lingo.for_caller(text, lang, E().llm)
        calls.note(C(), cid, "agent", out["text"], english=out["english"], lang=lang, via=out["via"])
        return out["text"]

    def _listen(t: voice.TwiML, v: dict, public: str, cid: str, prompt: str, lang: str, first: bool = False) -> voice.TwiML:
        if prompt:
            calls.note(C(), cid, "agent", prompt, lang=lang)
        offer = _offer(v, lang) if first else []
        return t.gather(_url(public, "turn", c=cid), prompt, also=offer, keys=v.get("language") == "both") \
            .redirect(_url(public, "turn", c=cid, quiet=1))

    async def _start_recording(cid: str, sid: str, public: str) -> None:
        """Record a call that is already going; a Twilio trial refuses incoming calls, and the report says so."""
        await asyncio.sleep(voice.RECORD_DELAY)        # the call must be connected before it can be recorded
        hub = C()
        v = hub.config()["voice"]
        try:
            rsid = await asyncio.to_thread(voice.start_recording, v, sid, _url(public, "recording", c=cid))
            rec = {"status": "recording", "sid": rsid or None, "at": time.time()}
        except ChannelError as ex:
            rec = {"status": "failed", "error": str(ex), "at": time.time()}
        conv = hub.conversation(cid)
        if conv:
            conv["recording"] = {**(conv.get("recording") or {}), **rec}
            hub._put(conv)
            if rec["status"] == "failed":
                hub._log(conv, "in", f"Not recorded: {rec['error']}", kind="call", status="not recorded")

    @app.post("/api/channels/voice/twilio/incoming")
    async def tw_incoming(request: Request):
        v, form = await _twilio(request)
        hub = C()
        sid, caller = form.get("CallSid", "") or uuid.uuid4().hex, form.get("From", "")
        conv = hub._conv(f"voice:{sid}", "voice", caller)
        conv["customer_id"] = conv.get("customer_id") or hub.identify(caller)
        conv["call_sid"] = sid
        conv["lang"] = voice.first_lang(v)
        if v.get("record"):
            conv["recording"] = {"status": "starting"}
        hub._log(conv, "in", f"Call from {caller}", kind="call", status="answered")
        lang = conv["lang"]
        t = voice.TwiML(v, lang)
        if not conv["customer_id"] and v.get("accept") == "contacts":
            return _xml(t.say(lingo.phrase("only_customers", lang)).hangup())
        first = (hub.customers().get(conv["customer_id"] or "") or {}).get("name", "").split(" ")[0]
        if lang == "hi":
            hello = lingo.phrase("greeting_named", "hi", name=first) if first else lingo.phrase("greeting", "hi")
        else:
            hello = (f"Hello {first}, this is Nirnaya, the support assistant." if first else
                     "Hello, this is Nirnaya, the support assistant.") + " How can I help you with your payment today?"
        hub._log(conv, "out", hello, kind="greeting", status="spoken")
        public = _public(request)
        if v.get("record"):
            notice = lingo.phrase("recorded", lang)
            t.say(notice)
            calls.note(hub, conv["id"], "agent", notice, lang=lang)
            asyncio.get_running_loop().create_task(_start_recording(conv["id"], sid, public))
        return _xml(_listen(t, v, public, conv["id"], hello, lang, first=True))

    @app.post("/api/channels/voice/twilio/outbound")
    async def tw_outbound(request: Request):
        v, form = await _twilio(request)
        hub = C()
        cid = request.query_params.get("c", "")
        conv = hub.conversation(cid)
        lang = _lang(conv, v)
        t = voice.TwiML(v, lang)
        if not conv:
            return _xml(t.say(lingo.phrase("lost", lang)).hangup())
        opening = (conv.get("opening") or "Hello, this is Nirnaya, the support assistant.").strip()
        hub._log(conv, "out", opening, kind="greeting", status="spoken")
        public = _public(request)
        if v.get("record"):
            notice = lingo.phrase("recorded", lang)
            t.say(notice)
            calls.note(hub, cid, "agent", notice, lang=lang)
        return _xml(_listen(t.say(_speak(cid, opening, lang)), v, public, cid, lingo.phrase("anything_else", lang), lang, first=True))

    @app.post("/api/channels/voice/twilio/turn")
    async def tw_turn(request: Request):
        v, form = await _twilio(request)
        hub = C()
        cid = request.query_params.get("c", "")
        conv = hub.conversation(cid)
        lang = _lang(conv, v)
        public = _public(request)
        if not conv:
            return _xml(voice.TwiML(v, lang).say(lingo.phrase("lost", lang)).hangup())
        speech, digits = (form.get("SpeechResult") or "").strip(), (form.get("Digits") or "").strip()
        # switching language: press 2 (or 1), or ask for it in words
        want = "hi" if digits == "2" or (speech and lingo.ASK_HINDI.search(speech) and len(speech) < 40) else \
            "en" if digits == "1" or (speech and lingo.ASK_ENGLISH.search(speech) and len(speech) < 40) else None
        if want:
            _set_lang(cid, want)
            calls.note(hub, cid, "caller", speech or f"pressed {digits}", lang=want)
            return _xml(_listen(voice.TwiML(v, want), v, public, cid, lingo.phrase("switched" if want == "hi" else "switched_en", "hi" if want == "hi" else "en"), want))
        if not speech:
            conv["silence"] = conv.get("silence", 0) + 1
            hub._put(conv)
            t = voice.TwiML(v, lang)
            if conv["silence"] >= 3:
                hub._log(conv, "out", BYE, kind="bye", status="spoken")
                calls.note(hub, cid, "agent", lingo.phrase("silence_bye", lang), lang=lang)
                return _xml(t.say(lingo.phrase("silence_bye", lang)).hangup())
            return _xml(_listen(t, v, public, cid, lingo.phrase("again", lang), lang))
        conv["silence"] = 0
        hub._put(conv)
        # what they said, for the agents: Hindi (Devanagari) into English or Hinglish; Hinglish as it is
        heard = lingo.for_agents(speech, E().llm, E().tok)
        if heard["lang"] == "hi" and lang != "hi" and v.get("language") != "en-IN":
            lang = "hi"                                  # they spoke Hindi: the agent answers in Hindi from now on
            _set_lang(cid, "hi")
        calls.note(hub, cid, "caller", speech, english=heard["text"], lang=heard["lang"], via=heard["via"])
        t = voice.TwiML(v, lang)
        t0 = time.time()
        r = await hub.receive("voice", conv["address"], heard["text"], conv_id=cid,
                              meta={"confidence": form.get("Confidence"), "original": speech if heard["text"] != speech else None,
                                    "lang": heard["lang"]})
        if r["action"] == "reply":
            said = _speak(cid, r["reply"], lang)
            if r.get("end"):
                _ended(cid)
                return _xml(t.say(said).hangup())
            return _xml(_listen(t.say(said), v, public, cid, "", lang))
        if r["action"] == "ignored":
            return _xml(t.say(lingo.phrase("cannot_help", lang)).hangup())
        o = await hub.wait_reply(cid, after=t0, timeout=7)
        if o:
            return _xml(_spoken(t, v, o, public, cid, lang))
        return _xml(t.say(lingo.phrase("one_moment", lang)).redirect(_url(public, "wait", c=cid, t=f"{t0:.3f}", n=1)))

    def _spoken(t: voice.TwiML, v: dict, o: dict, public: str, cid: str, lang: str) -> voice.TwiML:
        said = _speak(cid, o["text"], lang)
        if o.get("end"):
            _ended(cid)
            return t.say(said).hangup()
        return _listen(t.say(said), v, public, cid, lingo.phrase("anything_else", lang), lang)

    def _ended(cid: str, status: str | None = None, duration: str | None = None) -> None:
        hub = C()
        conv = hub.conversation(cid)
        if not conv:
            return
        conv["ended"] = True
        conv["ended_at"] = conv.get("ended_at") or time.time()
        if duration and str(duration).isdigit():
            conv["duration"] = int(duration)
        if status:
            conv["call_status"] = status
        hub._put(conv)
        calls.save(hub, cid)

    @app.post("/api/channels/voice/twilio/wait")
    async def tw_wait(request: Request):
        v, form = await _twilio(request)
        hub = C()
        cid, n = request.query_params.get("c", ""), int(request.query_params.get("n", "1") or 1)
        after = float(request.query_params.get("t", "0") or 0)
        lang = _lang(hub.conversation(cid), v)
        t = voice.TwiML(v, lang)
        public = _public(request)
        o = await hub.wait_reply(cid, after=after, timeout=9)
        if o:
            return _xml(_spoken(t, v, o, public, cid, lang))
        if n >= 5:
            calls.note(hub, cid, "agent", lingo.phrase("too_long", lang), lang=lang)
            _ended(cid)
            return _xml(t.say(lingo.phrase("too_long", lang)).hangup())
        return _xml(t.say(lingo.phrase("still", lang)).redirect(_url(public, "wait", c=cid, t=f"{after:.3f}", n=n + 1)))

    @app.post("/api/channels/voice/twilio/status")
    async def tw_status(request: Request):
        v, form = await _twilio(request)
        hub = C()
        cid = request.query_params.get("c", "") or f"voice:{form.get('CallSid', '')}"
        conv = hub.conversation(cid)
        st = form.get("CallStatus", "")
        if conv and st in ("completed", "busy", "no-answer", "failed", "canceled"):
            hub._log(conv, "out" if conv["id"].startswith("voice:out-") else "in",
                     f"Call {st.replace('-', ' ')}" + (f" after {form.get('CallDuration')} s" if form.get("CallDuration") else ""),
                     kind="call", status=st)
            _ended(cid, st, form.get("CallDuration"))
        return {"ok": True}

    @app.post("/api/channels/voice/twilio/recording")
    async def tw_recording(request: Request):
        """Twilio says a recording is ready (or that there is none): fetch it and keep it with the report."""
        v, form = await _twilio(request)
        hub = C()
        cid = request.query_params.get("c", "")
        conv = hub.conversation(cid)
        if not conv:
            return {"ok": True}
        st = form.get("RecordingStatus", "")
        rec = {**(conv.get("recording") or {}), "sid": form.get("RecordingSid") or None, "at": time.time()}
        if form.get("RecordingDuration", "").isdigit():
            rec["duration"] = int(form["RecordingDuration"])
        if st == "completed" and form.get("RecordingUrl"):
            rec["status"] = "downloading"
            conv["recording"] = rec
            hub._put(conv)
            asyncio.get_running_loop().create_task(_keep(cid, form["RecordingUrl"], rec["sid"] or "rec"))
        else:
            rec["status"] = "absent" if st == "absent" else "failed"
            rec["error"] = form.get("ErrorCode") and f"Twilio error {form['ErrorCode']}"
            conv["recording"] = rec
            hub._put(conv)
            calls.save(hub, cid)
        return {"ok": True}

    async def _keep(cid: str, url: str, rsid: str) -> None:
        hub = C()
        v = hub.config()["voice"]
        try:
            data = await asyncio.to_thread(voice.download, v, url)
            path = calls.recording_file(E(), cid, rsid)
            await asyncio.to_thread(path.write_bytes, data)
            upd = {"status": "kept", "file": path.name, "bytes": len(data)}
        except (ChannelError, OSError) as ex:
            upd = {"status": "failed", "error": f"could not download the recording: {ex}"}
        conv = hub.conversation(cid)
        if conv:
            conv["recording"] = {**(conv.get("recording") or {}), **upd}
            hub._put(conv)
            hub._log(conv, "in", "Recording kept" if upd["status"] == "kept" else upd["error"], kind="call",
                     status="recorded" if upd["status"] == "kept" else "not recorded")
            calls.save(hub, cid)

    # ── call reports ─────────────────────────────────────────────────────────
    @app.get("/api/channels/call-reports")
    def call_reports(limit: int = 100):
        return calls.listing(C(), max(1, min(limit, 500)))

    @app.get("/api/channels/call-reports/{cid}")
    def call_report(cid: str):
        rep = calls.get(C(), cid)
        if not rep:
            raise HTTPException(404, "no report for that call")
        return rep

    @app.get("/api/channels/call-reports/{cid}/html")
    def call_report_html(cid: str):
        rep = calls.get(C(), cid)
        if not rep:
            raise HTTPException(404, "no report for that call")
        name = re.sub(r"[^\w-]", "_", cid)
        return Response(calls.as_html(rep), media_type="text/html",
                        headers={"Content-Disposition": f'attachment; filename="call-report-{name}.html"'})

    @app.get("/api/channels/call-reports/{cid}/audio")
    def call_audio(cid: str):
        rep = calls.get(C(), cid)
        f = ((rep or {}).get("recording") or {}).get("file")
        path = calls.recordings_dir(E()) / f if f else None
        if not path or not path.is_file():
            raise HTTPException(404, "no recording kept for that call")
        return FileResponse(path, media_type="audio/mpeg", filename=f)

    # ── the browser call page (talk to the agent from any Chrome or Edge) ───
    @app.get("/api/channels/web/customers")
    def web_customers():
        return [{"id": c["id"], "name": c["name"]} for c in E().rails.customers()]

    @app.post("/api/channels/web/start")
    def web_start(body: WebStart):
        hub = C()
        session = uuid.uuid4().hex[:16]
        name = clean_name(body.name, "") if body.name else ""
        cust = body.customer_id if body.customer_id in hub.customers() else None
        lang = "hi" if body.lang == "hi" else "en"
        conv = hub._conv(f"web:{session}", "web", session, name or (hub.customers()[cust]["name"] if cust else "Web caller"))
        conv["customer_id"] = cust
        conv["lang"] = lang
        first = (hub.customers().get(cust or "") or {}).get("name", "").split(" ")[0]
        if lang == "hi":
            hello = lingo.phrase("greeting_named", "hi", name=first) if first else lingo.phrase("greeting", "hi")
        else:
            hello = (f"Hello {first}, this is Nirnaya, the support assistant." if first else
                     "Hello, this is Nirnaya, the support assistant.") + " How can I help you with your payment today?"
        hub._log(conv, "in", "Call started from the call page", kind="call", status="answered")
        hub._log(conv, "out", hello, kind="greeting", status="spoken")
        calls.note(hub, conv["id"], "agent", hello, lang=lang)
        return {"session": session, "greeting": hello, "customer_id": cust, "lang": lang}

    @app.post("/api/channels/web/turn")
    async def web_turn(body: WebTurn):
        hub = C()
        cid = f"web:{body.session}"
        conv = hub.conversation(cid)
        if not conv:
            raise HTTPException(404, "this call has ended; start a new one")
        lang = body.lang if body.lang in ("en", "hi") else conv.get("lang", "en")
        if lang != conv.get("lang"):
            _set_lang(cid, lang)
        heard = lingo.for_agents(body.text, E().llm, E().tok)
        calls.note(hub, cid, "caller", body.text, english=heard["text"], lang=heard["lang"], via=heard["via"])
        t0 = time.time()
        r = await hub.receive("web", body.session, heard["text"], conv_id=cid,
                              meta={"mode": "text" if body.mode == "text" else "voice",
                                    "original": body.text if heard["text"] != body.text else None, "lang": heard["lang"]})
        if r["action"] == "reply":
            if r.get("end"):
                _ended(cid)
            return {"reply": _speak(cid, r["reply"], lang), "english": r["reply"], "end": r.get("end", False), "case_id": None}
        if r["action"] != "case":
            return {"reply": _speak(cid, "Sorry, I can't help with that here.", lang), "end": False, "case_id": None}
        o = await hub.wait_reply(cid, after=t0, timeout=45)
        c = E().store.get_case(r["case_id"])
        english = o["text"] if o else "I'm still checking; this is taking longer than usual."
        if o and o.get("end"):
            _ended(cid)
        return {"reply": _speak(cid, english, lang), "english": english,
                "end": bool(o and o.get("end")), "case_id": r["case_id"],
                "status": (c or {}).get("status"), "route": (c or {}).get("route")}

    @app.post("/api/channels/web/end")
    def web_end(body: WebEnd):
        hub = C()
        cid = f"web:{body.session}"
        conv = hub.conversation(cid)
        if conv and not conv.get("ended"):
            hub._log(conv, "in", "Call ended", kind="call", status="completed")
            _ended(cid, "completed")
        return {"ok": True, "report": f"/api/channels/call-reports/{cid}" if conv else None}

    # ── any other channel, through n8n / Make / Zapier / your own code ───────
    @app.post("/api/channels/hook")
    async def hook_in(body: HookIn, request: Request):
        cfg = C().config()["hook"]
        token = request.headers.get("x-nirnaya-token") or request.query_params.get("token") or ""
        if not cfg["enabled"]:
            raise HTTPException(403, "webhooks are switched off (Channels → Webhooks)")
        if not cfg.get("token") or not hmac.compare_digest(token, cfg["token"]):
            raise HTTPException(403, "wrong or missing token (send it as X-Nirnaya-Token)")
        hub = C()
        source = "".join(ch for ch in body.channel.lower() if ch.isalnum() or ch in "-_")[:24] or "webhook"
        t0 = time.time()
        conv_id = f"hook:{source}:{body.sender.strip().lower()}"
        r = await hub.receive(f"hook:{source}", body.sender.strip().lower(), body.text, name=body.name,
                              conv_id=conv_id, meta={"sync": body.wait})
        if not body.wait or r["action"] not in ("case",):
            return {"action": r["action"], "reply": r.get("reply"), "case_id": r.get("case_id"), "why": r.get("why")}
        o = await hub.wait_reply(conv_id, after=t0, timeout=45)
        c = E().store.get_case(r["case_id"])
        return {"action": "case", "case_id": r["case_id"], "reply": o["text"] if o else None,
                "status": (c or {}).get("status"), "route": (c or {}).get("route")}


def _status(hub: Channels, channel: str, s: dict) -> None:
    """A delivery receipt (sent, delivered, read, failed) lands on the message it is about."""
    if not s.get("msg_id"):
        return
    for conv in hub.conversations(60):
        if conv["channel"] != channel:
            continue
        for m in reversed(conv["messages"]):
            if m.get("msg_id") == s["msg_id"]:
                m["status"] = s.get("status") or m.get("status")
                if s.get("error"):
                    m["error"] = s["error"]
                hub._put(conv)
                hub.E().bus.publish("channel.message", conv=hub._summary(conv), message=m)
                return
