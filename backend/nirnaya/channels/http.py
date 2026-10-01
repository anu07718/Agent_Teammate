"""Small HTTPS client on the standard library (no extra packages, so the Windows build stays the same)."""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.parse
import urllib.request


class ChannelError(Exception):
    """A provider refused or could not be reached; the message is fit to show a person."""


def request(method: str, url: str, *, json_body=None, form=None, headers: dict | None = None,
            basic: tuple[str, str] | None = None, timeout: float = 20) -> dict:
    data = None
    h = {"User-Agent": "Nirnaya/0.1", "Accept": "application/json", **(headers or {})}
    if json_body is not None:
        data = json.dumps(json_body).encode()
        h["Content-Type"] = "application/json"
    elif form is not None:
        data = urllib.parse.urlencode(form).encode()
        h["Content-Type"] = "application/x-www-form-urlencoded"
    if basic:
        h["Authorization"] = "Basic " + base64.b64encode(f"{basic[0]}:{basic[1]}".encode()).decode()
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        raise ChannelError(_explain(e.code, body)) from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        reason = getattr(e, "reason", e)
        raise ChannelError(f"could not reach {urllib.parse.urlsplit(url).netloc}: {reason}") from None
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        return {"raw": raw.decode("utf-8", "replace")[:2000]}


def _explain(code: int, body: str) -> str:
    """Pull the provider's own message out of an error body (Graph API, Twilio, Brevo and Resend all differ)."""
    msg = body.strip()[:400]
    try:
        j = json.loads(body)
        err = j.get("error") if isinstance(j, dict) else None
        if isinstance(err, dict):
            msg = err.get("error_user_msg") or err.get("message") or msg
            if err.get("code"):
                msg = f"{msg} (code {err['code']})"
        elif isinstance(j, dict):
            msg = j.get("message") or j.get("detail") or j.get("error") or msg
            if j.get("code") and isinstance(j.get("code"), (int, str)):
                msg = f"{msg} (code {j['code']})"
    except ValueError:
        pass
    return f"HTTP {code}: {msg}"
