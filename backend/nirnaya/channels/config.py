"""What Nirnaya is connected to: a mailbox, WhatsApp, a phone line, and webhooks for tools like n8n.

The settings live in the store (kv "channels") and are edited in the app. Any field can also come from the
environment, which wins and is read-only in the app: NIRNAYA_PUBLIC_URL, NIRNAYA_EMAIL_PASSWORD,
NIRNAYA_WHATSAPP_TOKEN, NIRNAYA_VOICE_AUTH_TOKEN and so on (NIRNAYA_<CHANNEL>_<FIELD>). That is how a cloud
deploy keeps its secrets out of the database. Secrets never go back to the browser: the app only learns
whether each one is set.
"""
from __future__ import annotations

import copy
import os
import re

KEY = "channels"

DEFAULTS: dict = {
    # where the outside world reaches this server (a tunnel or a cloud host); webhooks are built from it
    "public_url": "",
    # a sender we cannot match to a customer: "ask" them to identify, or treat them as this demo customer
    "unknown": "ask",
    "email": {
        "enabled": False,
        "address": "",            # the support mailbox, e.g. you@gmail.com
        "name": "Nirnaya Support",
        "receive": "imap",        # imap (poll a mailbox) | webhook (a forwarder POSTs each email to us)
        "send": "smtp",           # smtp | brevo | resend (HTTPS APIs, for hosts that block SMTP)
        "imap_host": "imap.gmail.com", "imap_port": 993,
        "smtp_host": "smtp.gmail.com", "smtp_port": 587, "smtp_security": "starttls",  # starttls | ssl | none
        "username": "", "password": "",
        "api_key": "",            # Brevo or Resend
        "folder": "INBOX", "poll_seconds": 20,
        "accept": "contacts",     # contacts (only people linked to a customer) | anyone
        "forward_to": "",         # escalations are forwarded here, with the sealed summary
        "inbound_token": "",      # guards POST /api/channels/email/inbound
    },
    "whatsapp": {
        "enabled": False,
        "provider": "meta",       # meta (official Cloud API) | waha (self-hosted WhatsApp Web bridge)
        "phone_number_id": "", "token": "", "app_secret": "", "verify_token": "",
        "graph_url": "https://graph.facebook.com", "graph_version": "v23.0",
        "waha_url": "http://localhost:3000", "waha_session": "default", "waha_api_key": "", "waha_hmac_key": "",
        "accept": "contacts",
    },
    "voice": {
        "enabled": False,
        "provider": "twilio",
        "account_sid": "", "auth_token": "", "from_number": "",
        "api_url": "https://api.twilio.com",
        "language": "en-IN", "voice": "Polly.Raveena",
        "accept": "anyone",
    },
    "hook": {
        "enabled": False,
        "token": "",              # callers send it as X-Nirnaya-Token (or ?token=)
        "url": "",                # replies and case events are POSTed here (an n8n Webhook node, say)
    },
}

SECRETS = {
    "email": {"password", "api_key", "inbound_token"},
    "whatsapp": {"token", "app_secret", "waha_api_key", "waha_hmac_key"},
    "voice": {"auth_token"},
    "hook": {"token"},
}
CHOICES = {
    ("email", "receive"): {"imap", "webhook"},
    ("email", "send"): {"smtp", "brevo", "resend"},
    ("email", "smtp_security"): {"starttls", "ssl", "none"},
    ("email", "accept"): {"contacts", "anyone"},
    ("whatsapp", "provider"): {"meta", "waha"},
    ("whatsapp", "accept"): {"contacts", "anyone"},
    ("voice", "provider"): {"twilio"},
    ("voice", "accept"): {"contacts", "anyone"},
}
CHANNELS = ("email", "whatsapp", "voice", "hook")


def _env_name(*path: str) -> str:
    return "NIRNAYA_" + "_".join(p.upper() for p in path)


def _coerce(default, value):
    if isinstance(default, bool):
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)
    if isinstance(default, int):
        try:
            return int(value)
        except (TypeError, ValueError):
            raise ValueError(f"expected a number, got {value!r}")
    return "" if value is None else str(value).strip()


def env_overrides() -> dict:
    """Fields set in the environment, as {"email": {"password": "..."}, "public_url": "..."}."""
    out: dict = {}
    for k in ("public_url", "unknown"):
        v = os.environ.get(_env_name(k))
        if v is not None:
            out[k] = v.strip()
    for ch in CHANNELS:
        for field, default in DEFAULTS[ch].items():
            v = os.environ.get(_env_name(ch, field))
            if v is not None:
                out.setdefault(ch, {})[field] = _coerce(default, v)
    return out


def load(store) -> dict:
    """The settings in force: defaults, then what was saved in the app, then the environment."""
    cfg = copy.deepcopy(DEFAULTS)
    saved = store.kv_get(KEY) or {}
    for k in ("public_url", "unknown"):
        if k in saved:
            cfg[k] = saved[k]
    for ch in CHANNELS:
        for field, v in (saved.get(ch) or {}).items():
            if field in cfg[ch]:
                cfg[ch][field] = v
    env = env_overrides()
    for k in ("public_url", "unknown"):
        if k in env:
            cfg[k] = env[k]
    for ch in CHANNELS:
        cfg[ch].update(env.get(ch, {}))
    cfg["public_url"] = (cfg["public_url"] or "").rstrip("/")
    return cfg


def public(cfg: dict) -> dict:
    """For the browser: secrets blanked (with `<field>_set`), and which fields the environment fixed."""
    out = copy.deepcopy(cfg)
    env = env_overrides()
    locked = [k for k in ("public_url", "unknown") if k in env]
    for ch in CHANNELS:
        for field in SECRETS.get(ch, ()):
            out[ch][f"{field}_set"] = bool(cfg[ch].get(field))
            out[ch][field] = ""
        locked += [f"{ch}.{f}" for f in env.get(ch, {})]
    out["locked"] = locked
    return out


def update(store, patch: dict, customers: set[str]) -> dict:
    """Apply a change from the app. A secret sent as "" keeps the saved one; null clears it."""
    saved = store.kv_get(KEY) or {}
    if "public_url" in patch:
        url = (patch["public_url"] or "").strip().rstrip("/")
        if url and not re.match(r"^https?://[^\s/]+", url):
            raise ValueError("The public URL starts with https:// (for example https://abc.trycloudflare.com).")
        saved["public_url"] = url
    if "unknown" in patch:
        u = (patch["unknown"] or "ask").strip()
        if u != "ask" and u not in customers:
            raise ValueError(f"Unknown senders are either asked who they are, or treated as one of {sorted(customers)}.")
        saved["unknown"] = u
    for ch in CHANNELS:
        if ch not in patch:
            continue
        cur = saved.setdefault(ch, {})
        for field, value in (patch[ch] or {}).items():
            if field not in DEFAULTS[ch]:
                continue  # *_set flags and unknown keys from an older app
            if field in SECRETS.get(ch, ()):
                if value is None:
                    cur.pop(field, None)
                elif str(value).strip():
                    cur[field] = str(value).strip()
                continue
            v = _coerce(DEFAULTS[ch][field], value)
            allowed = CHOICES.get((ch, field))
            if allowed and v not in allowed:
                raise ValueError(f"{ch} {field} is one of: {', '.join(sorted(allowed))}.")
            if field in ("imap_port", "smtp_port") and not 0 < v < 65536:
                raise ValueError(f"{field.replace('_', ' ')} must be a port number.")
            if field == "poll_seconds":
                v = max(5, min(3600, v))
            cur[field] = v
    store.kv_set(KEY, saved)
    return load(store)
