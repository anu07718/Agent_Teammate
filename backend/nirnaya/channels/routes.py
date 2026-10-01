"""HTTP routes for the channels: provider webhooks (each checks its own signature), the phone-call loop,
the browser call page, the generic webhook for n8n and friends, and the settings the app edits."""
from __future__ import annotations

import asyncio
import hmac
import ipaddress
import time
import urllib.parse
import uuid
from typing import Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field

from ..team import clean_name
from . import mail, voice, whatsapp
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


class WebTurn(BaseModel):
    session: str = Field(min_length=6, max_length=40)
    text: str = Field(min_length=1, max_length=2000)
    mode: str = "voice"


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
        return {**C()._summary(conv), "messages": conv["messages"]}

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

    @app.post("/api/channels/voice/twilio/incoming")
    async def tw_incoming(request: Request):
        v, form = await _twilio(request)
        hub = C()
        sid, caller = form.get("CallSid", "") or uuid.uuid4().hex, form.get("From", "")
        conv = hub._conv(f"voice:{sid}", "voice", caller)
        conv["customer_id"] = conv.get("customer_id") or hub.identify(caller)
        conv["call_sid"] = sid
        hub._log(conv, "in", f"Call from {caller}", kind="call", status="answered")
        t = voice.TwiML(v)
        if not conv["customer_id"] and v.get("accept") == "contacts":
            return _xml(t.say("Sorry, this line only takes calls from registered customers. Goodbye.").hangup())
        first = (hub.customers().get(conv["customer_id"] or "") or {}).get("name", "").split(" ")[0]
        hello = (f"Hello {first}, this is Nirnaya, the support assistant." if first else
                 "Hello, this is Nirnaya, the support assistant.") + " How can I help you with your payment today?"
        hub._log(conv, "out", hello, kind="greeting", status="spoken")
        public = _public(request)
        return _xml(t.gather(_url(public, "turn", c=conv["id"]), hello).redirect(_url(public, "turn", c=conv["id"], quiet=1)))

    @app.post("/api/channels/voice/twilio/outbound")
    async def tw_outbound(request: Request):
        v, form = await _twilio(request)
        hub = C()
        cid = request.query_params.get("c", "")
        conv = hub.conversation(cid)
        t = voice.TwiML(v)
        if not conv:
            return _xml(t.say("Sorry, something went wrong with this call. Goodbye.").hangup())
        opening = (conv.get("opening") or "Hello, this is Nirnaya, the support assistant.").strip()
        hub._log(conv, "out", opening, kind="greeting", status="spoken")
        public = _public(request)
        return _xml(t.say(opening).gather(_url(public, "turn", c=cid), "Is there anything else I can help you with?")
                    .redirect(_url(public, "turn", c=cid, quiet=1)))

    @app.post("/api/channels/voice/twilio/turn")
    async def tw_turn(request: Request):
        v, form = await _twilio(request)
        hub = C()
        cid = request.query_params.get("c", "")
        conv = hub.conversation(cid)
        t = voice.TwiML(v)
        public = _public(request)
        if not conv:
            return _xml(t.say("Sorry, I lost track of this call. Please call again. Goodbye.").hangup())
        speech = (form.get("SpeechResult") or "").strip()
        if not speech:
            conv["silence"] = conv.get("silence", 0) + 1
            hub._put(conv)
            if conv["silence"] >= 3:
                hub._log(conv, "out", BYE, kind="bye", status="spoken")
                return _xml(t.say("I can't hear anything, so I'll end the call now. " + BYE).hangup())
            return _xml(t.gather(_url(public, "turn", c=cid), "Sorry, I didn't catch that. Could you say it again?")
                        .redirect(_url(public, "turn", c=cid, quiet=1)))
        conv["silence"] = 0
        hub._put(conv)
        t0 = time.time()
        r = await hub.receive("voice", conv["address"], speech, conv_id=cid, meta={"confidence": form.get("Confidence")})
        if r["action"] == "reply":
            if r.get("end"):
                return _xml(t.say(r["reply"]).hangup())
            return _xml(t.gather(_url(public, "turn", c=cid), r["reply"]).redirect(_url(public, "turn", c=cid, quiet=1)))
        if r["action"] == "ignored":
            return _xml(t.say("Sorry, I can't help on this line. Goodbye.").hangup())
        o = await hub.wait_reply(cid, after=t0, timeout=7)
        if o:
            return _xml(_spoken(t, o, public, cid))
        return _xml(t.say("One moment, I'm checking that for you.").redirect(_url(public, "wait", c=cid, t=f"{t0:.3f}", n=1)))

    def _spoken(t: voice.TwiML, o: dict, public: str, cid: str) -> voice.TwiML:
        if o.get("end"):
            return t.say(o["text"]).hangup()
        return t.say(o["text"]).gather(_url(public, "turn", c=cid), "Is there anything else I can help you with?") \
            .redirect(_url(public, "turn", c=cid, quiet=1))

    @app.post("/api/channels/voice/twilio/wait")
    async def tw_wait(request: Request):
        v, form = await _twilio(request)
        hub = C()
        cid, n = request.query_params.get("c", ""), int(request.query_params.get("n", "1") or 1)
        after = float(request.query_params.get("t", "0") or 0)
        t = voice.TwiML(v)
        public = _public(request)
        o = await hub.wait_reply(cid, after=after, timeout=9)
        if o:
            return _xml(_spoken(t, o, public, cid))
        if n >= 5:
            return _xml(t.say("This is taking a little longer than usual. I'll send you the answer by message. "
                              + BYE).hangup())
        return _xml(t.say("Still checking.").redirect(_url(public, "wait", c=cid, t=f"{after:.3f}", n=n + 1)))

    @app.post("/api/channels/voice/twilio/status")
    async def tw_status(request: Request):
        v, form = await _twilio(request)
        hub = C()
        conv = hub.conversation(request.query_params.get("c", ""))
        st = form.get("CallStatus", "")
        if conv and st in ("completed", "busy", "no-answer", "failed", "canceled"):
            conv["ended"] = True
            hub._log(conv, "out" if conv["id"].startswith("voice:out-") else "in",
                     f"Call {st.replace('-', ' ')}" + (f" after {form.get('CallDuration')} s" if form.get("CallDuration") else ""),
                     kind="call", status=st)
        return {"ok": True}

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
        conv = hub._conv(f"web:{session}", "web", session, name or (hub.customers()[cust]["name"] if cust else "Web caller"))
        conv["customer_id"] = cust
        first = (hub.customers().get(cust or "") or {}).get("name", "").split(" ")[0]
        hello = (f"Hello {first}, this is Nirnaya, the support assistant." if first else
                 "Hello, this is Nirnaya, the support assistant.") + " How can I help you with your payment today?"
        hub._log(conv, "in", "Call started from the call page", kind="call", status="answered")
        hub._log(conv, "out", hello, kind="greeting", status="spoken")
        return {"session": session, "greeting": hello, "customer_id": cust}

    @app.post("/api/channels/web/turn")
    async def web_turn(body: WebTurn):
        hub = C()
        cid = f"web:{body.session}"
        if not hub.conversation(cid):
            raise HTTPException(404, "this call has ended; start a new one")
        t0 = time.time()
        r = await hub.receive("web", body.session, body.text, conv_id=cid, meta={"mode": "text" if body.mode == "text" else "voice"})
        if r["action"] == "reply":
            return {"reply": r["reply"], "end": r.get("end", False), "case_id": None}
        if r["action"] != "case":
            return {"reply": "Sorry, I can't help with that here.", "end": False, "case_id": None}
        o = await hub.wait_reply(cid, after=t0, timeout=45)
        c = E().store.get_case(r["case_id"])
        return {"reply": o["text"] if o else "I'm still checking; this is taking longer than usual.",
                "end": bool(o and o.get("end")), "case_id": r["case_id"],
                "status": (c or {}).get("status"), "route": (c or {}).get("route")}

    @app.post("/api/channels/web/end")
    def web_end(body: WebEnd):
        hub = C()
        conv = hub.conversation(f"web:{body.session}")
        if conv and not conv.get("ended"):
            conv["ended"] = True
            hub._log(conv, "in", "Call ended", kind="call", status="completed")
        return {"ok": True}

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
