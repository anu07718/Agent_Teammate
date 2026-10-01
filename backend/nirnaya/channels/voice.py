"""Phone calls through Twilio: the agent answers, listens, and talks back, turn by turn.

Twilio turns the caller's speech into text (<Gather input="speech">) and reads our reply aloud (<Say>);
Nirnaya only ever sees and writes text, so the same pipeline handles a call, an email or a chat. A trial
account comes with free minutes and calls verified numbers in your own country (see channels.md).

Every request from Twilio carries X-Twilio-Signature; it is checked against the auth token and the public
URL Twilio called, so nobody else can put words in a caller's mouth.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
from xml.sax.saxutils import escape, quoteattr

from .http import ChannelError, request


def signature(auth_token: str, url: str, params: dict) -> str:
    """Twilio's scheme: the full URL, then each POST parameter's name and value in name order, HMAC-SHA1."""
    s = url + "".join(f"{k}{params[k]}" for k in sorted(params))
    return base64.b64encode(hmac.new(auth_token.encode(), s.encode(), hashlib.sha1).digest()).decode()


def signature_ok(auth_token: str, url: str, params: dict, header: str | None) -> bool:
    if not auth_token or not header:
        return False
    return hmac.compare_digest(signature(auth_token, url, params), header)


class TwiML:
    """A tiny builder: TwiML().say("Hello").gather(...).xml()."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.parts: list[str] = []

    def _say(self, text: str) -> str:
        attrs = f" voice={quoteattr(self.cfg.get('voice') or 'Polly.Raveena')} language={quoteattr(self.cfg.get('language') or 'en-IN')}"
        return f"<Say{attrs}>{escape(text)}</Say>"

    def say(self, text: str) -> "TwiML":
        if text:
            self.parts.append(self._say(text))
        return self

    def gather(self, action: str, prompt: str = "", timeout: int = 6) -> "TwiML":
        lang = quoteattr(self.cfg.get("language") or "en-IN")
        inner = self._say(prompt) if prompt else ""
        self.parts.append(f'<Gather input="speech" action={quoteattr(action)} method="POST" language={lang} '
                          f'speechTimeout="auto" timeout="{timeout}" actionOnEmptyResult="true">{inner}</Gather>')
        return self

    def pause(self, seconds: int = 1) -> "TwiML":
        self.parts.append(f'<Pause length="{int(seconds)}"/>')
        return self

    def redirect(self, url: str) -> "TwiML":
        self.parts.append(f'<Redirect method="POST">{escape(url)}</Redirect>')
        return self

    def hangup(self) -> "TwiML":
        self.parts.append("<Hangup/>")
        return self

    def xml(self) -> str:
        return '<?xml version="1.0" encoding="UTF-8"?><Response>' + "".join(self.parts) + "</Response>"


def call(cfg: dict, to: str, url: str, status_url: str | None = None) -> str:
    """Start an outbound call; Twilio fetches its first instructions from `url`."""
    if not (cfg.get("account_sid") and cfg.get("auth_token") and cfg.get("from_number")):
        raise ChannelError("set the Twilio account SID, auth token and phone number")
    form = {"To": to, "From": cfg["from_number"], "Url": url, "Method": "POST"}
    if status_url:
        form.update({"StatusCallback": status_url, "StatusCallbackMethod": "POST"})
    r = request("POST", f"{cfg['api_url'].rstrip('/')}/2010-04-01/Accounts/{cfg['account_sid']}/Calls.json",
                form=form, basic=(cfg["account_sid"], cfg["auth_token"]))
    return r.get("sid") or ""


def e164(number: str, default_cc: str = "91") -> str:
    """+91XXXXXXXXXX from what a person typed (10 digits get the default country code)."""
    d = "".join(c for c in (number or "") if c.isdigit())
    if (number or "").strip().startswith("+"):
        return "+" + d
    if len(d) == 10:
        return f"+{default_cc}{d}"
    if len(d) == 11 and d.startswith("0"):
        return f"+{default_cc}{d[1:]}"
    return "+" + d if d else ""
