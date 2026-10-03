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

from .http import ChannelError, fetch_bytes, request


def signature(auth_token: str, url: str, params: dict) -> str:
    """Twilio's scheme: the full URL, then each POST parameter's name and value in name order, HMAC-SHA1."""
    s = url + "".join(f"{k}{params[k]}" for k in sorted(params))
    return base64.b64encode(hmac.new(auth_token.encode(), s.encode(), hashlib.sha1).digest()).decode()


def signature_ok(auth_token: str, url: str, params: dict, header: str | None) -> bool:
    if not auth_token or not header:
        return False
    return hmac.compare_digest(signature(auth_token, url, params), header)


RECORD_DELAY = 1.5          # seconds after answering before an incoming call can be recorded (tests set 0)
LANG_CODE = {"en": "en-IN", "hi": "hi-IN"}
# what helps the recogniser on a payments line (Twilio's speech hints)
HINTS = {"en": "UPI, refund, failed, debited, payment, transaction, customer ID, NEFT, IMPS, card, block, twice",
         "hi": "पेमेंट, रिफंड, फेल, पैसा कट गया, यूपीआई, ट्रांजैक्शन, कस्टमर आईडी, कार्ड, ब्लॉक, दो बार, रुपये"}


def first_lang(cfg: dict) -> str:
    """The language a call starts in: Hindi only when the line is set to Hindi."""
    return "hi" if cfg.get("language") == "hi-IN" else "en"


class TwiML:
    """A tiny builder: TwiML(cfg).say("Hello").gather(...).xml(). Each line is spoken in its own language:
    English in the English voice, Hindi in the Hindi one (Polly.Aditi speaks Hindi and Indian English)."""

    def __init__(self, cfg: dict, lang: str = "en"):
        self.cfg = cfg
        self.lang = lang
        self.parts: list[str] = []

    def _say(self, text: str, lang: str | None = None) -> str:
        lang = lang or self.lang
        voice = (self.cfg.get("hindi_voice") or "Polly.Aditi") if lang == "hi" else (self.cfg.get("voice") or "Polly.Raveena")
        return f"<Say voice={quoteattr(voice)} language={quoteattr(LANG_CODE[lang])}>{escape(text)}</Say>"

    def say(self, text: str, lang: str | None = None) -> "TwiML":
        if text:
            self.parts.append(self._say(text, lang))
        return self

    def gather(self, action: str, prompt: str = "", timeout: int = 6, *, also: list[tuple[str, str]] | None = None,
               keys: bool = False) -> "TwiML":
        """Listen in the call's language. `also` adds lines in other languages (the "press 2 for Hindi" offer);
        `keys` lets the caller press a key as well as speak."""
        inner = (self._say(prompt) if prompt else "") + "".join(self._say(t, lg) for t, lg in (also or []) if t)
        what = "dtmf speech" if keys else "speech"
        num = ' numDigits="1"' if keys else ""
        self.parts.append(f'<Gather input="{what}"{num} action={quoteattr(action)} method="POST" '
                          f'language={quoteattr(LANG_CODE[self.lang])} hints={quoteattr(HINTS[self.lang])} '
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


def _api(cfg: dict, path: str) -> str:
    return f"{cfg['api_url'].rstrip('/')}/2010-04-01/Accounts/{cfg['account_sid']}/{path}"


def call(cfg: dict, to: str, url: str, status_url: str | None = None, recording_url: str | None = None) -> str:
    """Start an outbound call; Twilio fetches its first instructions from `url`. With `recording_url` the whole
    call is recorded (both sides, one per channel) and Twilio says where the file is when it is ready."""
    if not (cfg.get("account_sid") and cfg.get("auth_token") and cfg.get("from_number")):
        raise ChannelError("set the Twilio account SID, auth token and phone number")
    form = {"To": to, "From": cfg["from_number"], "Url": url, "Method": "POST"}
    if status_url:
        form.update({"StatusCallback": status_url, "StatusCallbackMethod": "POST"})
    if recording_url:
        form.update({"Record": "true", "RecordingChannels": "dual", "RecordingStatusCallback": recording_url,
                     "RecordingStatusCallbackMethod": "POST", "RecordingStatusCallbackEvent": "completed absent"})
    r = request("POST", _api(cfg, "Calls.json"), form=form, basic=(cfg["account_sid"], cfg["auth_token"]))
    return r.get("sid") or ""


def start_recording(cfg: dict, call_sid: str, recording_url: str) -> str:
    """Record a call that is already going (an incoming call). A Twilio trial cannot record incoming calls;
    Twilio says so and the call goes on unrecorded."""
    r = request("POST", _api(cfg, f"Calls/{call_sid}/Recordings.json"),
                form={"RecordingChannels": "dual", "RecordingStatusCallback": recording_url,
                      "RecordingStatusCallbackMethod": "POST", "RecordingStatusCallbackEvent": "completed absent"},
                basic=(cfg["account_sid"], cfg["auth_token"]))
    return r.get("sid") or ""


def download(cfg: dict, recording_url: str) -> bytes:
    """The recording as an MP3, fetched with the account's own credentials (Twilio keeps it until deleted)."""
    if not recording_url.startswith(("https://", "http://")):
        raise ChannelError("not a recording URL")
    data, _ = fetch_bytes(recording_url + ".mp3", basic=(cfg["account_sid"], cfg["auth_token"]))
    return data


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
