"""The hub: every real channel (email, WhatsApp, a phone call, the browser call page, a webhook from n8n)
becomes a conversation, and every customer message in it goes through the same ten-step pipeline as a
case from the office. The pipeline's replies come back out on the channel they arrived on.

- Who is writing: a contact you linked (Channels → Contacts), a registered mobile number, or a customer
  ID / number the sender gives when asked. Senders who are none of these are asked who they are, or
  ignored when the channel only accepts contacts (the default for email and WhatsApp, so a personal
  inbox never sends a reply to a newsletter).
- Small talk ("thanks", "bye", "any update?") is answered without opening a case.
- Replies are sent by a background worker, so a slow mail server never holds up a case.
- An escalation can be forwarded by email to a supervisor, who can reply APPROVE or REJECT to it.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from typing import Callable

from ..team import clean_name
from . import config as cfgmod
from . import mail, voice, whatsapp
from .http import ChannelError, request

log = logging.getLogger("nirnaya.channels")
CONVS, CASE_MAP, CONTACTS, SEEN, IMAP_STATE, FORWARDS = (
    "channel_convs", "channel_case", "contacts", "channel_seen", "imap_state", "channel_forwards")
MAX_CONVS, MAX_MSGS = 300, 120
ENGINE_CHANNEL = {"email": "email", "whatsapp": "whatsapp", "voice": "voice", "web": "voice"}
LABEL = {"email": "Email", "whatsapp": "WhatsApp", "voice": "Phone", "web": "Web call", "hook": "Webhook"}

ASK_ID = ("Hello, I'm Nirnaya, the support assistant. To look into a payment for you, please reply with your "
          "registered mobile number or your customer ID (for example C-1001).")
ASK_ID_SPOKEN = ("To look into a payment for you, please tell me your registered mobile number, "
                 "or your customer ID, for example C 1 0 0 1.")
LINKED = "Thank you, {name}. I've found your account."
THANKS = "You're welcome! If anything else comes up with a payment, just message me here."
BYE = "Thank you for contacting us. Goodbye!"
STATUS_PARKED = ("Your case {id} is with a specialist for approval. I'll update you here as soon as it's done.")
STATUS_RUNNING = "I'm still checking case {id}. You'll have my answer here in a moment."
RE_THANKS = re.compile(r"^\s*(thanks?|thank you( so much)?|thx|ty|ok(ay)?|great|cool|got it|fine|noted|perfect|"
                       r"shukriya|dhanyavaad|dhanyavad|👍|🙏)[\s!.🙏👍]*$", re.I)
RE_BYE = re.compile(r"^\s*(bye|goodbye|good bye|that'?s all|that is all|that'?s it|nothing else|no,? thanks?|"
                    r"no thank you|i'?m good|all good|that will be all)\b", re.I)
# on a call, "no" answers "is there anything else?"
RE_NO = re.compile(r"^\s*(no|nope|nah|nahi|no no)\b[\s,.!]*((that'?s|that is) (all|it)|thanks?|thank you|"
                   r"nothing( else)?|i'?m (good|fine)|all good)?[\s.!]*$", re.I)
RE_STATUS = re.compile(r"\b(any update|status|update on|what happened|still waiting|where is my (case|refund|money)|"
                       r"kab tak|kitna time)\b", re.I)
RE_CUSTOMER_ID = re.compile(r"\bC-?(\d{4})\b", re.I)
RE_MOBILE = re.compile(r"(?<!\d)(?:\+?91[\s-]?)?([6-9]\d{9})(?!\d)")
RE_APPROVE = re.compile(r"^\s*(approve|approved|yes|ok to approve)\b", re.I)
RE_REJECT = re.compile(r"^\s*(reject|rejected|no|decline)\b", re.I)


def phone_key(addr: str) -> str:
    d = whatsapp.digits(addr)
    return d[-10:] if len(d) >= 10 else d


RE_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
RE_PHONEISH = re.compile(r"^\+?[\d\s().-]+$")


def contact_key(addr: str) -> str:
    """email:…, phone:<last 10 digits>, or id:… for anything else (a Telegram handle from n8n, a chat id)."""
    a = (addr or "").strip().lower()
    if RE_EMAIL.match(a):
        return f"email:{a}"
    if RE_PHONEISH.match(a):
        return f"phone:{phone_key(a)}"
    return f"id:{a}"


class Channels:
    def __init__(self, get_engine: Callable, get_flows: Callable = lambda: None):
        self.E = get_engine
        self.F = get_flows
        self.loop: asyncio.AbstractEventLoop | None = None
        self.queue: asyncio.Queue | None = None
        self.tasks: list[asyncio.Task] = []
        self.inbox = mail.Inbox()
        self.status: dict[str, dict] = {ch: {"ok": None, "error": None, "last": None, "received": 0, "sent": 0,
                                             "failed": 0} for ch in ("email", "whatsapp", "voice", "web", "hook")}
        self._wake: dict[str, asyncio.Event] = {}
        self._hooked = None
        self._polling = asyncio.Lock()

    # ── lifecycle ────────────────────────────────────────────────────────────
    def hook(self, bus) -> None:
        if self._hooked is bus:
            return
        self._hooked = bus
        bus.listen(self._on_event)

    async def start(self, background: bool = True) -> None:
        self.loop = asyncio.get_running_loop()
        self.queue = asyncio.Queue()
        self.tasks.append(self.loop.create_task(self._worker()))
        if background:
            self.tasks.append(self.loop.create_task(self._email_loop()))

    def stop(self) -> None:
        for t in self.tasks:
            t.cancel()
        self.tasks = []
        self.inbox.close()

    # ── settings ─────────────────────────────────────────────────────────────
    def config(self) -> dict:
        return cfgmod.load(self.E().store)

    def customers(self) -> dict[str, dict]:
        return {c["id"]: c for c in self.E().rails.customers()}

    def update(self, patch: dict) -> dict:
        cfg = cfgmod.update(self.E().store, patch, set(self.customers()))
        if "email" in patch:
            self.inbox.close()  # reconnect with the new settings on the next poll
        self.E().bus.publish("channels.changed")
        return cfg

    def webhooks(self, base: str) -> dict:
        b = (self.config()["public_url"] or base).rstrip("/")
        return {"whatsapp": f"{b}/api/channels/whatsapp/webhook", "waha": f"{b}/api/channels/waha/webhook",
                "voice": f"{b}/api/channels/voice/twilio/incoming", "voice_status": f"{b}/api/channels/voice/twilio/status",
                "email": f"{b}/api/channels/email/inbound",
                "hook": f"{b}/api/channels/hook", "call_page": f"{b}/call"}

    def snapshot(self, base: str) -> dict:
        cfg = self.config()
        return {"config": cfgmod.public(cfg), "status": self.status, "webhooks": self.webhooks(base),
                "contacts": self.contacts(), "customers": [{"id": c["id"], "name": c["name"], "phone": c["phone"]}
                                                           for c in self.customers().values()],
                "conversations": [self._summary(c) for c in self.conversations(40)]}

    # ── contacts ─────────────────────────────────────────────────────────────
    def contacts(self) -> list[dict]:
        cs = self.customers()
        return [{"key": k, "address": k.split(":", 1)[1], "kind": k.split(":", 1)[0], "customer_id": v,
                 "customer": (cs.get(v) or {}).get("name", v)} for k, v in (self.E().store.kv_get(CONTACTS) or {}).items()]

    def link(self, address: str, customer_id: str, strict: bool = True) -> dict:
        """Remember whose address this is. `strict` (a person typing it): an email address, a mobile number
        or an @handle; otherwise (someone said who they are) any address the channel gave us."""
        if customer_id not in self.customers():
            raise ValueError(f"no customer {customer_id}")
        key = contact_key(address)
        kind, value = key.split(":", 1)
        if (kind == "phone" and len(value) < 10) or not value or (strict and kind == "id" and not re.match(r"^@[\w.]{2,}$", value)):
            raise ValueError("give an email address, a mobile number with at least 10 digits, or a handle that starts with @")
        all_ = self.E().store.kv_get(CONTACTS) or {}
        all_[key] = customer_id
        self.E().store.kv_set(CONTACTS, all_)
        return {"key": key, "customer_id": customer_id}

    def unlink(self, address: str) -> None:
        all_ = self.E().store.kv_get(CONTACTS) or {}
        all_.pop(contact_key(address), None)
        all_.pop(address, None)
        self.E().store.kv_set(CONTACTS, all_)

    def identify(self, address: str) -> str | None:
        contacts = self.E().store.kv_get(CONTACTS) or {}
        hit = contacts.get(contact_key(address))
        if hit:
            return hit
        if contact_key(address).startswith("phone:"):
            pk = phone_key(address)
            if len(pk) == 10:
                for c in self.customers().values():
                    if phone_key(c["phone"]) == pk:
                        return c["id"]
        return None

    def _from_text(self, text: str) -> str | None:
        cs = self.customers()
        # spoken numbers arrive with spaces ("98765 43210", "C 1 0 0 1"): close the gaps between digits first
        text = re.sub(r"(?<=\d)[\s-]+(?=\d)", "", text or "")
        text = re.sub(r"\b[cC][\s-]+(?=\d{4}\b)", "C-", text)
        m = RE_CUSTOMER_ID.search(text or "")
        if m and f"C-{m.group(1)}" in cs:
            return f"C-{m.group(1)}"
        for num in RE_MOBILE.findall(text or ""):
            for c in cs.values():
                if phone_key(c["phone"]) == num:
                    return c["id"]
        return None

    # ── conversations ────────────────────────────────────────────────────────
    def _all(self) -> dict:
        return self.E().store.kv_get(CONVS) or {}

    def conversations(self, limit: int = 100) -> list[dict]:
        return sorted(self._all().values(), key=lambda c: c.get("updated_at", 0), reverse=True)[:limit]

    def conversation(self, cid: str) -> dict | None:
        return self._all().get(cid)

    def _put(self, conv: dict) -> None:
        all_ = self._all()
        conv["updated_at"] = time.time()
        conv["messages"] = conv["messages"][-MAX_MSGS:]
        all_[conv["id"]] = conv
        if len(all_) > MAX_CONVS:
            for old in sorted(all_.values(), key=lambda c: c.get("updated_at", 0))[: len(all_) - MAX_CONVS]:
                all_.pop(old["id"], None)
        self.E().store.kv_set(CONVS, all_)

    def _conv(self, cid: str, channel: str, address: str, name: str = "") -> dict:
        conv = self.conversation(cid)
        if conv is None:
            conv = {"id": cid, "channel": channel, "address": address, "name": name or address, "customer_id": None,
                    "case_ids": [], "subject": "", "last_in_id": "", "refs": "", "messages": [], "outbox": [],
                    "pending_text": "", "ended": False, "created_at": time.time(), "updated_at": time.time()}
        elif name and conv.get("name") in ("", conv.get("address")):
            conv["name"] = name
        return conv

    def _summary(self, conv: dict) -> dict:
        last = conv["messages"][-1] if conv["messages"] else None
        cust = self.customers().get(conv.get("customer_id") or "")
        return {"id": conv["id"], "channel": conv["channel"], "address": conv["address"], "name": conv["name"],
                "customer_id": conv.get("customer_id"), "customer": (cust or {}).get("name"),
                "case_ids": conv["case_ids"][-10:], "updated_at": conv["updated_at"], "count": len(conv["messages"]),
                "last": last, "subject": conv.get("subject", ""), "ended": conv.get("ended", False)}

    def _log(self, conv: dict, direction: str, text: str, **extra) -> dict:
        msg = {"dir": direction, "text": text[:4000], "ts": time.time(), **{k: v for k, v in extra.items() if v is not None}}
        conv["messages"].append(msg)
        self._put(conv)
        self.E().bus.publish("channel.message", conv=self._summary(conv), message=msg)
        return msg

    def case_conversation(self, case_id: str) -> dict | None:
        cid = (self.E().store.kv_get(CASE_MAP) or {}).get(case_id)
        return self.conversation(cid) if cid else None

    def _map_case(self, case_id: str, conv_id: str) -> None:
        m = self.E().store.kv_get(CASE_MAP) or {}
        m[case_id] = conv_id
        if len(m) > 2000:
            for k in list(m)[:500]:
                m.pop(k, None)
        self.E().store.kv_set(CASE_MAP, m)

    def _seen(self, msg_id: str) -> bool:
        if not msg_id:
            return False
        seen = self.E().store.kv_get(SEEN) or []
        if msg_id in seen:
            return True
        self.E().store.kv_set(SEEN, (seen + [msg_id])[-800:])
        return False

    # ── a message arrives ────────────────────────────────────────────────────
    async def receive(self, channel: str, address: str, text: str, *, name: str = "", msg_id: str = "",
                      conv_id: str | None = None, meta: dict | None = None) -> dict:
        """One message from a customer. Returns what happened: a case was opened, a reply was given, or why not."""
        meta = meta or {}
        text = (text or "").strip()
        if msg_id and self._seen(f"{channel}:{msg_id}"):
            return {"action": "duplicate"}
        cfg = self.config()
        st = self.status["web" if channel == "web" else channel.split(":")[0]]
        st["received"] += 1
        st["last"] = time.time()
        conv = self._conv(conv_id or f"{channel}:{address}", channel.split(":")[0] if channel.startswith("hook") else channel,
                          address, clean_name(name, "") if name else "")
        if channel.startswith("hook:"):
            conv["source"] = channel.split(":", 1)[1]
        for k in ("sync", "mode"):
            if k in meta:
                conv[k] = meta[k]
        if conv["channel"] == "email":
            conv["subject"] = meta.get("subject") or conv.get("subject", "")
            if meta.get("msg_id"):
                conv["last_in_id"] = meta["msg_id"]
                conv["refs"] = " ".join(x for x in ((meta.get("references") or conv.get("refs") or "").split()
                                                   + [meta["msg_id"]]) if x)[-1800:]
        self._log(conv, "in", text or "(empty)", msg_id=msg_id or None, original=meta.get("original"),
                  lang=meta.get("lang") if meta.get("original") else None)
        if not text:
            return {"action": "ignored", "why": "empty message", "conv_id": conv["id"]}

        chan_cfg = cfg.get(conv["channel"], {}) if conv["channel"] in cfgmod.CHANNELS else {}
        cust = conv.get("customer_id") or self.identify(address)
        linked_now = False
        if not cust:
            # the call page has no address to check or remember: "someone new" says who they are each call
            web = conv["channel"] == "web"
            if not web and chan_cfg.get("accept") == "contacts":
                return {"action": "ignored", "why": f"{address} is not a contact (Channels → Contacts)", "conv_id": conv["id"]}
            cust = self._from_text(text)
            if cust:
                linked_now = True
                if not web:
                    try:
                        self.link(address, cust, strict=False)
                    except ValueError:
                        pass  # an address we cannot remember (a short chat id): they say who they are next time too
            elif not web and cfg.get("unknown") and cfg["unknown"] != "ask":
                cust = cfg["unknown"]
        if not cust:
            if not RE_CUSTOMER_ID.search(text) and not RE_MOBILE.search(text) and len(text) > 12:
                conv["pending_text"] = text
            return await self._say(conv, ASK_ID_SPOKEN if conv["channel"] in ("voice", "web") else ASK_ID, kind="ask")
        conv["customer_id"] = cust
        todo = text
        prefix = ""
        if linked_now:
            prefix = LINKED.format(name=self.customers()[cust]["name"].split()[0]) + " "
            todo = conv.pop("pending_text", "") or ""
            conv["pending_text"] = ""
            leftover = RE_MOBILE.sub("", RE_CUSTOMER_ID.sub("", text)).strip(" .,:-")
            if not todo and len(leftover) > 12:
                todo = leftover
            if not todo:
                return await self._say(conv, prefix + "How can I help you with your payment?", kind="linked")
            self._put(conv)

        open_case = self._open_case(conv)
        if RE_THANKS.match(todo) and len(todo) < 40:
            return await self._say(conv, prefix + THANKS, kind="smalltalk")
        if RE_BYE.match(todo) or (conv["channel"] in ("voice", "web") and RE_NO.match(todo)):
            conv["ended"] = conv["channel"] in ("voice", "web")
            return await self._say(conv, prefix + BYE, kind="bye", end=conv["ended"])
        if open_case and RE_STATUS.search(todo) and len(todo) < 120:
            c = self.E().store.get_case(open_case)
            msg = (STATUS_PARKED if c and c.get("pending") else STATUS_RUNNING).format(id=open_case)
            return await self._say(conv, prefix + msg, kind="status")

        e = self.E()
        label = LABEL.get(conv["channel"], conv["channel"].title())
        if conv.get("source"):
            label = conv["source"].title()
        engine_channel = ENGINE_CHANNEL.get(conv["channel"], "chat")
        if conv["channel"] == "web" and conv.get("mode") == "text":
            engine_channel = "chat"
        case = e.create_case(cust, todo, engine_channel, by=f"{label} · {conv['name'] or address}"[:32])
        conv["case_ids"].append(case["id"])
        # "I've found your account" goes out on its own on WhatsApp; a call, the call page, a webhook
        # waiting for its answer and an email say it together with the case's answer, which they wait for
        together = bool(prefix) and conv["channel"] != "whatsapp"
        if together:
            conv["say_first"] = prefix.strip()
        self._put(conv)
        self._map_case(case["id"], conv["id"])
        if prefix and not together:
            await self._say(conv, prefix.strip(), kind="linked")
        e.start(case["id"])
        return {"action": "case", "case_id": case["id"], "conv_id": conv["id"]}

    def _open_case(self, conv: dict) -> str | None:
        for cid in reversed(conv["case_ids"][-5:]):
            c = self.E().store.get_case(cid)
            if c and (c.get("pending") or c["status"] == "running"):
                return cid
        return None

    async def _say(self, conv: dict, text: str, *, kind: str = "reply", case_id: str | None = None,
                   end: bool = False) -> dict:
        """Answer in this conversation: queued for email/WhatsApp/webhooks, spoken or shown for calls."""
        self._put(conv)  # deliver() reads the conversation back from the store: what we learnt must be in it
        self.deliver(conv["id"], text, case_id=case_id, kind=kind, end=end)
        return {"action": "reply", "reply": text, "kind": kind, "conv_id": conv["id"], "end": end}

    def deliver(self, conv_id: str, text: str, *, case_id: str | None = None, kind: str = "reply",
                end: bool = False, by: str | None = None) -> None:
        conv = self.conversation(conv_id)
        if conv is None:
            return
        if conv.get("say_first") and case_id:
            text = f"{conv.pop('say_first')} {text}"
            self._put(conv)
        if conv["channel"] in ("voice", "web") or conv.get("sync"):
            conv.setdefault("outbox", []).append({"text": text, "ts": time.time(), "case_id": case_id, "end": end})
            conv["outbox"] = conv["outbox"][-20:]
            self._log(conv, "out", text, case_id=case_id, kind=kind, status="spoken" if conv["channel"] == "voice" else "shown", by=by)
            ev = self._wake.get(conv_id)
            if ev:
                ev.set()
            return
        self._enqueue({"type": "send", "conv_id": conv_id, "text": text, "case_id": case_id, "kind": kind, "by": by})

    def _enqueue(self, job: dict) -> None:
        if self.loop is None or self.queue is None:
            log.warning("channels not started; dropping %s", job.get("type"))
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self.loop:
            self.queue.put_nowait(job)
        else:
            self.loop.call_soon_threadsafe(self.queue.put_nowait, job)

    # ── the pipeline's replies come back out ─────────────────────────────────
    def _on_event(self, ev: dict) -> None:
        kind = ev.get("kind")
        if kind == "reply.sent":
            conv = self.case_conversation(ev.get("case_id") or "")
            if conv:
                self.deliver(conv["id"], ev.get("text") or "", case_id=ev.get("case_id"), kind="reply")
        elif kind == "case.finished":
            c = ev.get("case") or {}
            conv = self.case_conversation(c.get("id") or "")
            if conv:
                self._enqueue({"type": "finished", "case": c, "conv_id": conv["id"]})

    async def _worker(self) -> None:
        while True:
            job = await self.queue.get()
            try:
                if job["type"] == "send":
                    await self._send_job(job)
                elif job["type"] == "finished":
                    await self._finished(job)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("channel job %s failed", job.get("type"))

    async def _send_job(self, job: dict) -> None:
        conv = self.conversation(job["conv_id"])
        if conv is None:
            return
        ch = conv["channel"]
        cfg = self.config()
        st = self.status.get(ch) or self.status["hook"]
        text = job["text"]
        try:
            if ch == "email":
                c = cfg["email"]
                if not c["enabled"]:
                    raise ChannelError("email is switched off (Channels → Email)")
                body = text
                if job.get("case_id"):
                    body += f"\n\n—\nCase {job['case_id']} · reply to this email to continue."
                # "Re:" only when answering mail we received; a new email (a flow, a test) keeps its subject
                fallback = f"Your case {job.get('case_id') or ''}".strip()
                subject = mail.reply_subject(conv.get("subject", ""), fallback) if conv.get("last_in_id") else (conv.get("subject") or fallback)
                msg = mail.build(c, conv["address"], subject, body, in_reply_to=conv.get("last_in_id", ""),
                                 references=conv.get("refs", ""), to_name=conv["name"] if conv["name"] != conv["address"] else "")
                sent_id = await asyncio.to_thread(mail.send, c, msg)
                if not conv.get("subject"):
                    conv["subject"] = subject
            elif ch == "whatsapp":
                c = cfg["whatsapp"]
                if not c["enabled"]:
                    raise ChannelError("WhatsApp is switched off (Channels → WhatsApp)")
                sent_id = await asyncio.to_thread(whatsapp.send, c, conv["address"], text)
            elif ch == "hook":
                c = cfg["hook"]
                if not c.get("url"):
                    raise ChannelError("no reply URL set for webhooks (Channels → Webhooks)")
                await asyncio.to_thread(self._post_hook, {"type": "reply", "channel": conv.get("source") or "hook",
                                                          "to": conv["address"], "text": text, "case_id": job.get("case_id"),
                                                          "conversation": conv["id"]})
                sent_id = ""
            else:
                raise ChannelError(f"cannot send on {ch}")
            st["sent"] += 1
            st["ok"], st["error"], st["last"] = True, None, time.time()
            conv = self.conversation(job["conv_id"]) or conv
            self._log(conv, "out", text, case_id=job.get("case_id"), kind=job.get("kind"), status="sent",
                      msg_id=sent_id or None, by=job.get("by"))
        except Exception as e:
            st["failed"] += 1
            st["ok"], st["error"], st["last"] = False, str(e), time.time()
            conv = self.conversation(job["conv_id"]) or conv
            self._log(conv, "out", text, case_id=job.get("case_id"), kind=job.get("kind"), status="failed",
                      error=str(e), by=job.get("by"))
            self.E().bus.publish("channel.error", channel=ch, error=str(e), conv_id=conv["id"])

    async def _finished(self, job: dict) -> None:
        """A channel case is done (or parked): forward it if it waits for a person, tell n8n, and run any
        flow that starts on a message. (Only now: the case is saved, its seal and its reply are in it.)"""
        c, conv = job["case"], self.conversation(job["conv_id"])
        if conv is None:
            return
        mail_cfg = self.config()["email"]
        stored = self.E().store.get_case(c.get("id") or "") or {}
        if stored.get("pending") and mail_cfg.get("enabled") and mail_cfg.get("forward_to"):
            try:
                await self.forward(stored["id"], mail_cfg["forward_to"], auto=True)
            except Exception as ex:  # the forward is logged on the conversation; the case still waits in Approvals
                log.warning("auto-forward of %s failed: %s", stored["id"], ex)
        reply = next((m["text"] for m in reversed(conv["messages"]) if m["dir"] == "out"), "")
        first_in = next((m["text"] for m in reversed(conv["messages"]) if m["dir"] == "in"), "")
        ctx = {"ok": c.get("status") == "resolved" and c.get("route") != "REFUSE", "case_id": c.get("id"),
               "route": c.get("route"), "status": c.get("status"), "amount": c.get("amount"),
               "result": f"{c.get('id')} {c.get('status')} · {c.get('route')}" + (f" · “{reply[:140]}”" if reply else ""),
               "channel": conv["channel"] if conv["channel"] != "hook" else conv.get("source", "hook"),
               "from": conv["address"], "name": conv["name"], "text": first_in, "customer_id": conv.get("customer_id")}
        hook = self.config()["hook"]
        if hook.get("enabled") and hook.get("url"):
            await asyncio.to_thread(self._post_hook, {"type": "case.finished", **ctx})
        flows = self.F()
        if flows is not None:
            try:
                flows.on_message(ctx)
            except Exception:
                log.exception("flows on_message failed")

    def _post_hook(self, payload: dict) -> None:
        hook = self.config()["hook"]
        if not hook.get("url"):
            return
        headers = {"X-Nirnaya-Token": hook["token"]} if hook.get("token") else {}
        try:
            request("POST", hook["url"], json_body=payload, headers=headers, timeout=15)
            self.status["hook"].update(ok=True, error=None, last=time.time())
            self.status["hook"]["sent"] += 1
        except ChannelError as e:
            self.status["hook"].update(ok=False, error=str(e), last=time.time())
            self.status["hook"]["failed"] += 1

    # ── outbound, started by a person or a flow ──────────────────────────────
    async def send(self, channel: str, to: str, text: str, *, subject: str = "", case_id: str | None = None,
                   by: str | None = None, wait: bool = True) -> dict:
        """A new message to someone (a flow's Send node, a test, a person writing from the case view)."""
        to = (to or "").strip()
        if not to or not text.strip():
            raise ValueError("say who to send it to and what to say")
        if channel == "email" and "@" not in to:
            raise ValueError(f"{to} is not an email address")
        if channel == "whatsapp" and len(whatsapp.digits(to)) < 10:
            raise ValueError(f"{to} is not a WhatsApp number (country code and number, e.g. 919876543210)")
        if channel not in ("email", "whatsapp"):
            raise ValueError(f"cannot send a message on {channel}")
        addr = to.lower() if channel == "email" else whatsapp.digits(to)
        conv = self._conv(f"{channel}:{addr}", channel, addr)
        if subject and channel == "email":
            conv["subject"] = subject
            conv["last_in_id"], conv["refs"] = "", ""
        if not conv.get("customer_id"):
            conv["customer_id"] = self.identify(addr)
        if case_id and case_id not in conv["case_ids"]:
            conv["case_ids"].append(case_id)
        self._put(conv)
        if not wait:
            self.deliver(conv["id"], text, case_id=case_id, kind="message", by=by)
            return {"conv_id": conv["id"], "queued": True}
        job = {"type": "send", "conv_id": conv["id"], "text": text, "case_id": case_id, "kind": "message", "by": by}
        await self._send_job(job)
        last = (self.conversation(conv["id"]) or conv)["messages"][-1]
        if last.get("status") == "failed":
            raise ChannelError(last.get("error") or "could not send")
        return {"conv_id": conv["id"], "status": last.get("status"), "msg_id": last.get("msg_id")}

    async def reply(self, conv_id: str, text: str, by: str | None = None) -> dict:
        """A person answers in an existing conversation (from the Channels view)."""
        conv = self.conversation(conv_id)
        if conv is None:
            raise KeyError(conv_id)
        if conv["channel"] in ("voice", "web"):
            raise ValueError("a call is answered by the agent while it is live")
        job = {"type": "send", "conv_id": conv_id, "text": text, "case_id": (conv["case_ids"] or [None])[-1],
               "kind": "person", "by": by}
        await self._send_job(job)
        last = (self.conversation(conv_id) or conv)["messages"][-1]
        if last.get("status") == "failed":
            raise ChannelError(last.get("error") or "could not send")
        return last

    async def forward(self, case_id: str, to: str, note: str = "", by: str | None = None, auto: bool = False) -> dict:
        """Email a case to someone: what the customer said, what the agents found, what waits for a person."""
        e = self.E()
        case = e.store.get_case(case_id)
        if not case:
            raise KeyError(case_id)
        cfg = self.config()
        c = cfg["email"]
        if not c["enabled"]:
            raise ChannelError("email is switched off (Channels → Email)")
        if "@" not in (to or ""):
            raise ValueError("forward to an email address")
        s = e.summary(case)
        conv = self.case_conversation(case_id)
        said = next((m["text"] for m in (case.get("conversation") or []) if m["role"] == "customer"), "")
        lines = [f"{'Needs your approval' if case.get('pending') else 'Forwarded'}: case {case_id}",
                 f"Customer: {case.get('customer_name')} ({case['customer_id']}) via {conv['channel'] if conv else case['channel']}"
                 + (f" · {conv['address']}" if conv else ""),
                 f"About: {s.get('intent') or 'unknown'}" + (f" · ₹{s['amount']:,.0f}" if s.get("amount") else "")
                 + f" · route {s.get('route') or '—'} · {s.get('status')}"]
        if case.get("pending"):
            acts = ", ".join(f"{a['type']}" + (f" ₹{a['amount']:,.0f}" if a.get("amount") else "")
                             for a in case["pending"].get("actions", []))
            lines.append(f"Waiting for: {acts} (sealed {str(case['pending'].get('seal') or '')[:14]}…)")
            lines.append("")
            lines.append("Reply APPROVE or REJECT (with a reason on the same line) to decide from your mailbox, "
                         "or decide in Nirnaya → Approvals.")
        if note:
            lines += ["", f"Note from {by or 'the team'}: {note}"]
        lines += ["", "What the customer wrote:", *[f"> {x}" for x in said.splitlines()]]
        last_reply = next((m["text"] for m in reversed(case.get("conversation") or []) if m["role"] == "nirnaya"), "")
        if last_reply:
            lines += ["", "What Nirnaya replied:", *[f"> {x}" for x in last_reply.splitlines()]]
        if cfg["public_url"]:
            lines += ["", f"Open Nirnaya: {cfg['public_url']}/"]
        subject = (f"[Nirnaya] {case_id} needs approval" if case.get("pending") else f"Fwd: case {case_id}") + \
                  f" · {case.get('customer_name')}" + (f" · ₹{s['amount']:,.0f}" if s.get("amount") else "")
        msg = mail.build(c, to.strip(), subject, "\n".join(lines))
        try:
            sent = await asyncio.to_thread(mail.send, c, msg)
        except ChannelError as ex:
            self.status["email"].update(ok=False, error=str(ex), last=time.time())
            self.status["email"]["failed"] += 1
            if conv:
                self._log(conv, "out", f"Forward to {to} failed: {ex}", case_id=case_id, kind="forward", status="failed",
                          error=str(ex))
            raise
        fw = e.store.kv_get(FORWARDS) or {}
        fw[sent] = {"case_id": case_id, "to": to.strip().lower(), "ts": time.time()}
        e.store.kv_set(FORWARDS, dict(list(fw.items())[-300:]))
        self.status["email"]["sent"] += 1
        self.status["email"].update(ok=True, error=None, last=time.time())
        if conv:
            self._log(conv, "out", f"Forwarded to {to}" + (" for approval" if case.get("pending") else ""),
                      case_id=case_id, kind="forward", status="sent", by=by or ("auto" if auto else None))
        e.trail.append(case_id, "case.forwarded", by or "channels", {"to": to.strip(), "auto": auto})
        return {"to": to, "msg_id": sent}

    async def call(self, to: str, text: str, *, case_id: str | None = None, by: str | None = None, base: str = "") -> dict:
        """Phone a customer: the agent says `text`, then the call carries on as a conversation."""
        cfg = self.config()
        v = cfg["voice"]
        if not v["enabled"]:
            raise ChannelError("phone calls are switched off (Channels → Calls)")
        public = cfg["public_url"] or base
        if not public.startswith("https://"):
            raise ChannelError("set the public URL (Channels → Public URL): Twilio fetches the call's script from it")
        number = voice.e164(to)
        if len(number) < 11:
            raise ValueError(f"{to} is not a phone number")
        conv_id = f"voice:out-{uuid.uuid4().hex[:12]}"
        conv = self._conv(conv_id, "voice", number)
        conv["customer_id"] = self.identify(number)
        conv["opening"] = text
        conv["lang"] = voice.first_lang(v)
        if v.get("record"):
            conv["recording"] = {"status": "recording"}
        if case_id:
            conv["case_ids"].append(case_id)
        self._put(conv)
        url = f"{public}/api/channels/voice/twilio/outbound?c={conv_id}"
        rec_url = f"{public}/api/channels/voice/twilio/recording?c={conv_id}" if v.get("record") else None
        sid = await asyncio.to_thread(voice.call, v, number, url, f"{public}/api/channels/voice/twilio/status?c={conv_id}",
                                      rec_url)
        conv = self.conversation(conv_id) or conv
        conv["call_sid"] = sid
        self._log(conv, "out", f"Calling {number}…", kind="call", status="ringing", by=by, case_id=case_id)
        self.status["voice"].update(ok=True, error=None, last=time.time())
        return {"conv_id": conv_id, "sid": sid}

    # ── calls and the call page wait for the agent's answer ──────────────────
    async def wait_reply(self, conv_id: str, after: float, timeout: float = 25.0) -> dict | None:
        """The first reply written to this conversation after `after`, waiting up to `timeout` seconds."""
        deadline = time.time() + timeout
        while True:
            conv = self.conversation(conv_id)
            for o in (conv or {}).get("outbox", []):
                if o["ts"] > after:
                    return o
            left = deadline - time.time()
            if left <= 0:
                return None
            ev = self._wake.setdefault(conv_id, asyncio.Event())
            ev.clear()
            try:
                await asyncio.wait_for(ev.wait(), timeout=min(left, 2.0))
            except asyncio.TimeoutError:
                pass

    # ── email in ─────────────────────────────────────────────────────────────
    async def _email_loop(self) -> None:
        while True:
            cfg = self.config()["email"]
            try:
                if cfg["enabled"] and cfg["receive"] == "imap":
                    await self.poll_email()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.status["email"].update(ok=False, error=str(e), last=time.time())
            await asyncio.sleep(max(5, int(cfg.get("poll_seconds") or 20)))

    async def poll_email(self) -> dict:
        """Read new mail now. Returns how many messages were read and what happened to each."""
        async with self._polling:
            cfg = self.config()["email"]
            e = self.E()
            state = e.store.kv_get(IMAP_STATE) or {}
            first = "last_uid" not in state
            try:
                msgs, state = await asyncio.to_thread(self.inbox.fetch_new, cfg, state)
            except ChannelError as ex:
                self.status["email"].update(ok=False, error=str(ex), last=time.time())
                raise
            e.store.kv_set(IMAP_STATE, state)
            self.status["email"].update(ok=True, error=None, last=time.time(), last_poll=time.time())
            results = []
            for uid, raw in msgs:
                try:
                    results.append(await self.receive_email(mail.parse(raw)))
                except Exception as ex:
                    log.exception("email %s failed", uid)
                    results.append({"action": "error", "why": str(ex)})
                await asyncio.to_thread(self.inbox.mark_seen, uid)
                state["last_uid"] = max(int(state.get("last_uid", 0)), uid)
                e.store.kv_set(IMAP_STATE, state)
            return {"read": len(msgs), "started_fresh": first, "results": results}

    async def receive_email(self, m: dict) -> dict:
        cfg = self.config()["email"]
        own = {x.lower() for x in (cfg.get("address"), cfg.get("username")) if x}
        if m["from"] in own:
            return {"action": "ignored", "why": "our own message"}
        if m.get("automatic"):
            return {"action": "ignored", "why": f"automatic mail ({m['automatic']})"}
        decided = await self._approval_by_email(m, cfg)
        if decided:
            return decided
        return await self.receive("email", m["from"], m["text"], name=m["name"], msg_id=m.get("msg_id", ""),
                                  meta={"subject": m["subject"], "msg_id": m.get("msg_id"), "references": m.get("references")})

    async def _approval_by_email(self, m: dict, cfg: dict) -> dict | None:
        """The supervisor replies APPROVE or REJECT to a forwarded escalation."""
        fw = self.E().store.kv_get(FORWARDS) or {}
        ids = [m.get("in_reply_to", "")] + (m.get("references") or "").split()
        hit = next((fw[i] for i in ids if i in fw), None)
        if not hit or m["from"] != hit["to"] or m["from"] != (cfg.get("forward_to") or "").strip().lower():
            return None
        e = self.E()
        case = e.store.get_case(hit["case_id"])
        first_line = (m["text"].strip().splitlines() or [""])[0]
        who = f"{m['name'] or m['from']} (email)"[:32]
        if not case or not case.get("pending"):
            outcome = f"Case {hit['case_id']} is no longer waiting for approval; nothing was changed."
        elif RE_APPROVE.match(first_line):
            try:
                await e.approve(hit["case_id"], by=who, note="approved by email")
                outcome = f"Approved: {hit['case_id']} has been completed and the customer has been told."
            except Exception as ex:
                outcome = f"Could not approve {hit['case_id']}: {ex}. Please decide in Nirnaya → Approvals."
        elif RE_REJECT.match(first_line):
            note = RE_REJECT.sub("", first_line).strip(" :,-") or "rejected by email"
            await e.reject(hit["case_id"], by=who, note=note)
            outcome = f"Rejected: {hit['case_id']} is closed and the customer has been told a specialist will follow up."
        else:
            outcome = (f"I didn't see APPROVE or REJECT at the start of your reply, so {hit['case_id']} is still "
                       "waiting. Reply with APPROVE, or REJECT and a reason.")
        reply = mail.build(cfg, m["from"], mail.reply_subject(m["subject"], f"Case {hit['case_id']}"), outcome,
                           in_reply_to=m.get("msg_id", ""), references=m.get("references", ""))
        try:
            await asyncio.to_thread(mail.send, cfg, reply)
        except ChannelError as ex:
            self.status["email"].update(ok=False, error=str(ex), last=time.time())
        return {"action": "approval", "case_id": hit["case_id"], "outcome": outcome}
