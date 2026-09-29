"""PII Tokeniser: raw identifiers are swapped for format-preserving tokens before any model sees the text.

Digits are enciphered with a 10-round Feistel network keyed by HMAC-SHA256, so a token has the same
length and shape as the original (a phone number still looks like a phone number) and is reversible
only with the key. Only the Tool Gateway detokenises, at the moment a tool actually runs.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re

from .store import Store

ROUNDS = 10


def _round(key: bytes, r: int, value: int, width: int) -> int:
    mac = hmac.new(key, f"{r}:{value}:{width}".encode(), hashlib.sha256).digest()
    return int.from_bytes(mac[:8], "big") % (10 ** width)


def fpe_encrypt(key: bytes, digits: str) -> str:
    n = len(digits)
    if n < 2:
        return digits
    u, v = n // 2, n - n // 2
    a, b = int(digits[:u]), int(digits[u:])
    for r in range(ROUNDS):
        if r % 2 == 0:
            a = (a + _round(key, r, b, v)) % (10 ** u)
        else:
            b = (b + _round(key, r, a, u)) % (10 ** v)
    return f"{a:0{u}d}{b:0{v}d}"


def fpe_decrypt(key: bytes, digits: str) -> str:
    n = len(digits)
    if n < 2:
        return digits
    u, v = n // 2, n - n // 2
    a, b = int(digits[:u]), int(digits[u:])
    for r in reversed(range(ROUNDS)):
        if r % 2 == 0:
            a = (a - _round(key, r, b, v)) % (10 ** u)
        else:
            b = (b - _round(key, r, a, u)) % (10 ** v)
    return f"{a:0{u}d}{b:0{v}d}"


def luhn_ok(num: str) -> bool:
    total, alt = 0, False
    for ch in reversed(num):
        d = int(ch)
        if alt:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
        alt = not alt
    return total % 10 == 0


TXN_REF = r"(?:utr|rrn|ref(?:erence)?|txn|transaction)\s*(?:id|no\.?|number)?\s*[:#]?\s*"
PATTERNS = [
    ("email", re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b")),
    ("vpa", re.compile(r"\b[\w.-]{2,}@[a-zA-Z]{2,}\b")),
    ("pan", re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")),
    ("card", re.compile(r"\b(?:\d[ -]?){12,18}\d\b")),
    ("account", re.compile(r"(?i)(?<=a/c )\d{9,18}|(?<=account )\d{9,18}|(?<=acct )\d{9,18}|(?<=account no )\d{9,18}")),
    ("aadhaar", re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b")),
    ("phone", re.compile(r"(?:\+91[\s-]?)?\b[6-9]\d{9}\b")),
]


class Tokeniser:
    def __init__(self, store: Store, key: bytes | None = None):
        self.store = store
        self.key = key or os.environ.get("NIRNAYA_PII_KEY", "nirnaya-demo-key").encode()

    def _digits_token(self, raw: str) -> str:
        digits = re.sub(r"\D", "", raw)
        enc = iter(fpe_encrypt(self.key, digits))
        return "".join(next(enc) if ch.isdigit() else ch for ch in raw)

    def _token(self, kind: str, raw: str) -> str:
        if kind in ("email", "vpa"):
            handle, domain = raw.split("@", 1)
            h = hmac.new(self.key, raw.lower().encode(), hashlib.sha256).hexdigest()[:6]
            tok = f"{kind}_{h}@{domain}"
        elif kind == "pan":
            h = hmac.new(self.key, raw.encode(), hashlib.sha256).hexdigest()
            letters = "".join(chr(65 + int(h[i:i + 2], 16) % 26) for i in range(0, 10, 2))
            tok = f"{letters}{fpe_encrypt(self.key, raw[5:9])}{raw[-1]}"
        else:
            tok = self._digits_token(raw)
        self.store.execute("INSERT OR IGNORE INTO pii_vault VALUES(?,?,?)", (tok, kind, raw))
        return tok

    def tokenise(self, text: str) -> tuple[str, list[dict]]:
        """Return the tokenised text and what was replaced (kind + token, never the raw value)."""
        found: list[dict] = []
        protected: list[tuple[int, int]] = [m.span() for m in re.finditer(TXN_REF + r"\d{12}", text, re.I)]

        def overlaps(span):
            return any(s < span[1] and span[0] < e for s, e in protected)

        spans: list[tuple[int, int, str]] = []
        for kind, pat in PATTERNS:
            for m in pat.finditer(text):
                span = m.span()
                if overlaps(span) or any(s < span[1] and span[0] < e for s, e, _ in spans):
                    continue
                raw = m.group(0)
                if kind == "card" and not luhn_ok(re.sub(r"\D", "", raw)):
                    continue
                spans.append((span[0], span[1], kind))
        out, last = [], 0
        for s, e, kind in sorted(spans):
            tok = self._token(kind, text[s:e])
            out.append(text[last:s])
            out.append(tok)
            found.append({"kind": kind, "token": tok})
            last = e
        out.append(text[last:])
        return "".join(out), found

    def detokenise(self, token: str) -> str | None:
        rows = self.store.query("SELECT value FROM pii_vault WHERE token=?", (token,))
        return rows[0]["value"] if rows else None
