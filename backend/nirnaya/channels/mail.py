"""Email: read a mailbox over IMAP (or take emails a forwarder POSTs), reply in the same thread, forward.

Any mailbox works (Gmail or Outlook with an app password, Zoho, a company server). Hosts that block SMTP
(Render's and Hugging Face's free tiers do) can send through Brevo or Resend over HTTPS instead.

Nirnaya never answers mail that answers itself: auto-replies, bounces, mailing lists and newsletters are
skipped, and so is its own mail. The first time it connects it starts from the newest message, so a
mailbox full of old unread mail does not get a flood of replies.
"""
from __future__ import annotations

import email
import email.policy
import email.utils
import html
import imaplib
import re
import smtplib
import ssl
from email.message import EmailMessage

from .http import ChannelError, request

AUTO_LOCALPARTS = ("mailer-daemon", "postmaster", "noreply", "no-reply", "donotreply", "do-not-reply", "bounce",
                   "notifications", "notification", "newsletter")
QUOTE_STARTS = [
    re.compile(r"^\s*On .{3,300}wrote:\s*$", re.S),                    # Gmail, Apple Mail (may wrap over two lines)
    re.compile(r"^\s*-{2,}\s*Original Message\s*-{2,}\s*$", re.I),     # Outlook
    re.compile(r"^\s*_{10,}\s*$"),                                     # Outlook web
    re.compile(r"^\s*From:\s.+$"),                                     # a forwarded block or an Outlook header
    re.compile(r"^\s*(Sent from my|Get Outlook for)\b", re.I),
]


def _text_of(msg: email.message.EmailMessage) -> str:
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    try:
        body = part.get_content()
    except (LookupError, ValueError):
        body = part.get_payload(decode=True) or b""
        body = body.decode("utf-8", "replace") if isinstance(body, bytes) else str(body)
    if part.get_content_type() == "text/html":
        body = re.sub(r"(?is)<(script|style).*?</\1>", " ", body)
        body = re.sub(r"(?i)<br\s*/?>|</p>|</div>", "\n", body)
        body = html.unescape(re.sub(r"<[^>]+>", " ", body))
    return body.replace("\r\n", "\n")


def strip_quoted(text: str) -> str:
    """The new part of a reply: drop the quoted thread, `>` lines and the signature."""
    lines = text.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    for i, line in enumerate(lines):
        if line.rstrip() == "--" or line == "-- ":
            break
        two = line + " " + (lines[i + 1] if i + 1 < len(lines) else "")
        if any(p.match(line) for p in QUOTE_STARTS) or (line.strip().startswith("On ") and QUOTE_STARTS[0].match(two)):
            if out and any(x.strip() for x in out):
                break
        if line.lstrip().startswith(">"):
            continue
        out.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def is_automatic(msg: email.message.EmailMessage, from_addr: str) -> str | None:
    """Why this message must not be answered (an auto-reply, a list, a bounce), or None."""
    auto = (msg.get("Auto-Submitted") or "").strip().lower()
    if auto and auto != "no":
        return "auto-submitted"
    if msg.get("X-Autoreply") or msg.get("X-Autorespond") or msg.get("X-Auto-Response-Suppress", "").lower() == "all":
        return "an auto-reply"
    if (msg.get("Precedence") or "").strip().lower() in ("bulk", "junk", "list", "auto_reply"):
        return "bulk mail"
    if msg.get("List-Id") or msg.get("List-Unsubscribe"):
        return "a mailing list"
    if (msg.get("Return-Path") or "").strip() == "<>":
        return "a bounce"
    local = from_addr.split("@")[0].lower()
    if any(local == p or local.startswith(p + "+") or local.startswith(p + ".") for p in AUTO_LOCALPARTS):
        return f"from {from_addr}"
    return None


def parse(raw: bytes) -> dict:
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    name, addr = email.utils.parseaddr(str(msg.get("From") or ""))
    addr = addr.strip().lower()
    refs = " ".join(str(msg.get("References") or "").split())
    full = _text_of(msg)
    return {
        "from": addr, "name": name.strip() or addr.split("@")[0], "to": str(msg.get("To") or ""),
        "subject": " ".join(str(msg.get("Subject") or "").split())[:300],
        "msg_id": str(msg.get("Message-ID") or "").strip(), "in_reply_to": str(msg.get("In-Reply-To") or "").strip(),
        "references": refs, "text": strip_quoted(full)[:6000], "full_text": full[:20000],
        "automatic": is_automatic(msg, addr) if addr else "no sender",
    }


def from_json(body: dict) -> dict:
    """An email a forwarder POSTed: either the raw message (`raw`), or its parts."""
    if body.get("raw"):
        raw = body["raw"]
        return parse(raw.encode("utf-8", "surrogateescape") if isinstance(raw, str) else raw)
    name, addr = email.utils.parseaddr(str(body.get("from") or ""))
    text = str(body.get("text") or body.get("body") or "")
    if not text and body.get("html"):
        text = html.unescape(re.sub(r"<[^>]+>", " ", str(body["html"])))
    return {"from": addr.strip().lower(), "name": (body.get("name") or name or addr.split("@")[0]).strip(),
            "to": str(body.get("to") or ""), "subject": str(body.get("subject") or "")[:300],
            "msg_id": str(body.get("message_id") or body.get("msg_id") or "").strip(),
            "in_reply_to": str(body.get("in_reply_to") or "").strip(), "references": str(body.get("references") or ""),
            "text": strip_quoted(text)[:6000], "full_text": text[:20000],
            "automatic": "auto-submitted" if body.get("auto_submitted") else None}


def reply_subject(subject: str, fallback: str) -> str:
    s = (subject or "").strip()
    if not s:
        return fallback
    return s if re.match(r"(?i)^re:", s) else f"Re: {s}"


def build(cfg: dict, to: str, subject: str, text: str, *, in_reply_to: str = "", references: str = "",
          to_name: str = "") -> EmailMessage:
    m = EmailMessage()
    sender = cfg["address"] or cfg["username"]
    m["From"] = email.utils.formataddr((cfg.get("name") or "Nirnaya Support", sender))
    m["To"] = email.utils.formataddr((to_name, to)) if to_name else to
    m["Subject"] = subject
    m["Date"] = email.utils.formatdate(localtime=True)
    m["Message-ID"] = email.utils.make_msgid(domain=(sender.split("@")[-1] or "nirnaya.local"))
    m["Auto-Submitted"] = "auto-replied" if in_reply_to else "auto-generated"  # other robots will not answer it
    if in_reply_to:
        m["In-Reply-To"] = in_reply_to
        m["References"] = (references + " " + in_reply_to).strip() if in_reply_to not in references else references
    m.set_content(text)
    return m


def send(cfg: dict, msg: EmailMessage) -> str:
    """Send through the configured way out. Returns the Message-ID that went out."""
    how = cfg.get("send") or "smtp"
    to = str(msg["To"])
    headers = {k: str(msg[k]) for k in ("In-Reply-To", "References") if msg[k]}
    if how == "smtp":
        host, port, sec = cfg["smtp_host"], int(cfg["smtp_port"]), cfg.get("smtp_security") or "starttls"
        try:
            if sec == "ssl":
                s = smtplib.SMTP_SSL(host, port, timeout=25, context=ssl.create_default_context())
            else:
                s = smtplib.SMTP(host, port, timeout=25)
                if sec == "starttls":
                    s.starttls(context=ssl.create_default_context())
            with s:
                if cfg.get("username") and cfg.get("password"):
                    s.login(cfg["username"], cfg["password"])
                s.send_message(msg)
        except smtplib.SMTPAuthenticationError:
            raise ChannelError("the mail server refused the login. For Gmail, use an app password "
                               "(Google account → Security → 2-Step Verification → App passwords).") from None
        except (smtplib.SMTPException, OSError) as e:
            raise ChannelError(f"could not send through {host}:{port}: {e}") from None
        return str(msg["Message-ID"])
    if not cfg.get("api_key"):
        raise ChannelError(f"set the {how.title()} API key to send through {how.title()}")
    sender = cfg["address"] or cfg["username"]
    body_text = msg.get_content()
    if how == "brevo":
        r = request("POST", "https://api.brevo.com/v3/smtp/email", headers={"api-key": cfg["api_key"]}, json_body={
            "sender": {"email": sender, "name": cfg.get("name") or "Nirnaya Support"},
            "to": [{"email": email.utils.parseaddr(to)[1]}], "subject": str(msg["Subject"]),
            "textContent": body_text, **({"headers": headers} if headers else {})})
        return r.get("messageId") or str(msg["Message-ID"])
    if how == "resend":
        r = request("POST", "https://api.resend.com/emails", headers={"Authorization": f"Bearer {cfg['api_key']}"},
                    json_body={"from": str(msg["From"]), "to": [email.utils.parseaddr(to)[1]],
                               "subject": str(msg["Subject"]), "text": body_text,
                               **({"headers": headers} if headers else {})})
        return r.get("id") or str(msg["Message-ID"])
    raise ChannelError(f"unknown way to send email: {how}")


class Inbox:
    """Polls one IMAP folder. Keeps its connection, and remembers the last message it has seen."""

    def __init__(self):
        self.conn: imaplib.IMAP4 | None = None
        self.key = ""

    def close(self) -> None:
        if self.conn is not None:
            try:
                self.conn.logout()
            except Exception:
                pass
        self.conn = None

    def _connect(self, cfg: dict) -> imaplib.IMAP4:
        host, port = cfg["imap_host"], int(cfg["imap_port"])
        try:
            if port in (993, 3993):
                conn = imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context(), timeout=25)
            else:
                conn = imaplib.IMAP4(host, port, timeout=25)
                if "STARTTLS" in conn.capabilities:
                    conn.starttls(ssl_context=ssl.create_default_context())
            conn.login(cfg["username"], cfg["password"])
        except imaplib.IMAP4.error as e:
            raise ChannelError(f"the mailbox refused the login ({e}). For Gmail, turn on IMAP and use an app password.") from None
        except OSError as e:
            raise ChannelError(f"could not reach {host}:{port}: {e}") from None
        return conn

    def fetch_new(self, cfg: dict, state: dict) -> tuple[list[tuple[int, bytes]], dict]:
        """New messages since the last poll, as (uid, raw). The first poll only remembers where the mailbox is."""
        if not (cfg.get("username") and cfg.get("password")):
            raise ChannelError("set the mailbox username and password")
        key = f"{cfg['imap_host']}|{cfg['username']}|{cfg['folder']}"
        if self.conn is not None and key != self.key:
            self.close()
        try:
            if self.conn is not None:
                self.conn.noop()
        except Exception:
            self.close()
        if self.conn is None:
            self.conn = self._connect(cfg)
            self.key = key
        conn = self.conn
        try:
            typ, _ = conn.select(_quote(cfg["folder"]))
            if typ != "OK":
                raise ChannelError(f"no folder {cfg['folder']} in this mailbox")
            validity = int(_untagged(conn, "UIDVALIDITY") or 0)
            if state.get("key") != key or state.get("uidvalidity") != validity or "last_uid" not in state:
                typ, data = conn.status(_quote(cfg["folder"]), "(UIDNEXT)")
                m = re.search(rb"UIDNEXT (\d+)", data[0] or b"")
                return [], {"key": key, "uidvalidity": validity, "last_uid": int(m.group(1)) - 1 if m else 0}
            last = int(state["last_uid"])
            typ, data = conn.uid("SEARCH", None, f"UID {last + 1}:*")
            uids = sorted(int(u) for u in (data[0] or b"").split() if int(u) > last)
            out = []
            for uid in uids[:25]:
                typ, parts = conn.uid("FETCH", str(uid), "(BODY.PEEK[])")
                raw = next((p[1] for p in parts if isinstance(p, tuple)), None)
                if raw:
                    out.append((uid, raw))
            return out, state
        except imaplib.IMAP4.abort as e:
            self.close()
            raise ChannelError(f"the mailbox dropped the connection: {e}") from None

    def mark_seen(self, uid: int) -> None:
        if self.conn is not None:
            try:
                self.conn.uid("STORE", str(uid), "+FLAGS", r"(\Seen)")
            except Exception:
                pass


def _quote(folder: str) -> str:
    return f'"{folder}"' if " " in folder and not folder.startswith('"') else folder


def _untagged(conn: imaplib.IMAP4, name: str):
    v = conn.untagged_responses.get(name)
    if not v:
        return None
    try:
        return int(v[-1])
    except (TypeError, ValueError):
        m = re.search(rb"\d+", v[-1] if isinstance(v[-1], bytes) else str(v[-1]).encode())
        return int(m.group(0)) if m else None
