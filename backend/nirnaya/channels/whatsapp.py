"""WhatsApp, two ways in.

- **meta**: Meta's official WhatsApp Business Cloud API. Creating the app and using Meta's test number is
  free; replies inside the 24-hour customer-service window are free (see channels.md for the limits).
  Meta calls our webhook (it must be public HTTPS) and we reply through the Graph API.
- **waha**: WAHA, a self-hosted bridge to WhatsApp Web (Apache-2.0, free, runs in Docker). You link a
  number by scanning a QR code, and WAHA POSTs each message to us. It is not an official API: WhatsApp
  may ban numbers it sees behaving like a bot. Use a spare number.
"""
from __future__ import annotations

import hashlib
import hmac
import re

from .http import ChannelError, request


def digits(addr: str) -> str:
    return re.sub(r"\D", "", addr or "")


# ── Meta Cloud API ──────────────────────────────────────────────────────────
def meta_verify(cfg: dict, params) -> str | None:
    """The webhook handshake: echo the challenge when the verify token matches."""
    if params.get("hub.mode") == "subscribe" and cfg.get("verify_token") and \
            hmac.compare_digest(params.get("hub.verify_token") or "", cfg["verify_token"]):
        return params.get("hub.challenge") or ""
    return None


def meta_signature_ok(app_secret: str, body: bytes, header: str | None) -> bool:
    if not app_secret or not header or not header.startswith("sha256="):
        return False
    want = hmac.new(app_secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, header.split("=", 1)[1])


def _meta_text(m: dict) -> str:
    t = m.get("type")
    if t == "text":
        return (m.get("text") or {}).get("body", "")
    if t == "button":
        return (m.get("button") or {}).get("text", "")
    if t == "interactive":
        it = m.get("interactive") or {}
        return ((it.get("button_reply") or it.get("list_reply") or {}).get("title")) or ""
    if t in ("image", "video", "document", "audio", "sticker"):
        cap = (m.get(t) or {}).get("caption")
        return cap or f"[{t}]"
    if t == "location":
        return "[location]"
    return f"[{t or 'message'}]"


def meta_parse(payload: dict) -> tuple[list[dict], list[dict]]:
    """Incoming messages and delivery statuses from a webhook call."""
    msgs, statuses = [], []
    for entry in payload.get("entry") or []:
        for ch in entry.get("changes") or []:
            v = ch.get("value") or {}
            names = {c.get("wa_id"): (c.get("profile") or {}).get("name") for c in v.get("contacts") or []}
            for m in v.get("messages") or []:
                msgs.append({"from": digits(m.get("from")), "name": names.get(m.get("from")) or "",
                             "text": _meta_text(m).strip(), "msg_id": m.get("id") or "", "type": m.get("type")})
            for s in v.get("statuses") or []:
                err = (s.get("errors") or [{}])[0]
                statuses.append({"msg_id": s.get("id"), "status": s.get("status"),
                                 "error": err.get("title") or err.get("message") if s.get("errors") else None})
    return msgs, statuses


def meta_send(cfg: dict, to: str, text: str) -> str:
    if not (cfg.get("phone_number_id") and cfg.get("token")):
        raise ChannelError("set the WhatsApp phone number ID and access token")
    url = f"{cfg['graph_url'].rstrip('/')}/{cfg.get('graph_version') or 'v23.0'}/{cfg['phone_number_id']}/messages"
    body: dict = {"messaging_product": "whatsapp", "recipient_type": "individual", "to": digits(to), "type": "text",
                  "text": {"preview_url": False, "body": text[:4096]}}
    # "template:hello_world" (or "template:<name>:<language>") sends an approved template: the only way to
    # write first, before the customer has messaged you in the last 24 hours
    t = re.match(r"^template:([a-z0-9_]+)(?::([A-Za-z_]{2,8}))?$", text.strip())
    if t:
        body = {"messaging_product": "whatsapp", "recipient_type": "individual", "to": digits(to), "type": "template",
                "template": {"name": t.group(1), "language": {"code": t.group(2) or "en_US"}}}
    try:
        r = request("POST", url, headers={"Authorization": f"Bearer {cfg['token']}"}, json_body=body)
    except ChannelError as e:
        msg = str(e)
        if "131047" in msg or "24 hours" in msg.lower():
            raise ChannelError("WhatsApp only allows free-form replies within 24 hours of the customer's last "
                               "message; after that a pre-approved template is needed") from None
        if "131030" in msg:
            raise ChannelError("this number is not on the test number's allowed list: add it under WhatsApp → "
                               "API Setup → To") from None
        raise
    return ((r.get("messages") or [{}])[0]).get("id") or ""


def meta_mark_read(cfg: dict, msg_id: str) -> None:
    url = f"{cfg['graph_url'].rstrip('/')}/{cfg.get('graph_version') or 'v23.0'}/{cfg['phone_number_id']}/messages"
    try:
        request("POST", url, headers={"Authorization": f"Bearer {cfg['token']}"},
                json_body={"messaging_product": "whatsapp", "status": "read", "message_id": msg_id}, timeout=8)
    except ChannelError:
        pass  # blue ticks are a courtesy


# ── WAHA (self-hosted) ──────────────────────────────────────────────────────
def waha_signature_ok(key: str, body: bytes, header: str | None) -> bool:
    if not key:
        return True  # signing is optional in WAHA; without a key there is nothing to check
    if not header:
        return False
    want = hmac.new(key.encode(), body, hashlib.sha512).hexdigest()
    return hmac.compare_digest(want, header.strip())


def waha_parse(payload: dict) -> list[dict]:
    if payload.get("event") not in ("message", "message.any"):
        return []
    p = payload.get("payload") or {}
    chat = str(p.get("from") or "")
    if p.get("fromMe") or not chat.endswith(("@c.us", "@s.whatsapp.net")) or chat.startswith("status@"):
        return []  # our own messages, groups, broadcasts and status updates are not conversations
    text = (p.get("body") or "").strip() or ("[media]" if p.get("hasMedia") else "")
    name = ((p.get("_data") or {}).get("notifyName")) or ""
    return [{"from": digits(chat.split("@")[0]), "name": name, "text": text, "msg_id": str(p.get("id") or "")}]


def waha_send(cfg: dict, to: str, text: str) -> str:
    base = (cfg.get("waha_url") or "").rstrip("/")
    if not base:
        raise ChannelError("set the WAHA address, e.g. http://localhost:3000")
    headers = {"X-Api-Key": cfg["waha_api_key"]} if cfg.get("waha_api_key") else {}
    r = request("POST", f"{base}/api/sendText", headers=headers, json_body={
        "session": cfg.get("waha_session") or "default", "chatId": f"{digits(to)}@c.us", "text": text[:4096]})
    rid = r.get("id")
    return (rid.get("_serialized") if isinstance(rid, dict) else rid) or ""


def send(cfg: dict, to: str, text: str) -> str:
    return waha_send(cfg, to, text) if cfg.get("provider") == "waha" else meta_send(cfg, to, text)
