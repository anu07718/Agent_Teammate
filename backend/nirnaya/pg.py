"""Real UPI payments from a payment gateway's free test mode: Razorpay.

Razorpay's test mode is free and needs no KYC. Its payments, refunds and webhooks are the real API with
real objects (pay_…, rfnd_…): only the money is not real, and nothing reaches NPCI. That is the honest
"real" a prototype can show without being a bank or a licensed payment aggregator. How the same code goes
live is in docs/upi.md.

- Payments come into the ledger as transactions marked "Razorpay test", by Sync (the API) or by Razorpay's
  signed webhooks: payment.authorized, .captured, .failed, refund.created, .processed, .failed and
  payment_link.paid. Each is matched to a customer by the notes we set, the phone number or the email,
  or becomes a new customer.
- The agents read the live payment before they decide (evidence) and again just before anything commits
  (the Seal): if it changed on Razorpay in between, the approval no longer applies.
- A refund on a real payment goes to Razorpay's Refunds API through the sealed Tool Gateway. It is never
  more than what is captured and not yet refunded, never twice (a receipt and a note carry the idempotency
  key, and the payment's refunds are checked first), and always approved by a person: a gateway refund
  cannot be undone.

Guardrails on the keys: only test keys (rzp_test_…) are accepted; the secret and the webhook secret are
kept on the server and never shown again. Stdlib only: HTTPS with Basic auth, HMAC-SHA256 for webhooks.
Environment overrides: NIRNAYA_RAZORPAY_KEY_ID, NIRNAYA_RAZORPAY_KEY_SECRET, NIRNAYA_RAZORPAY_WEBHOOK_SECRET.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from fastapi import Body, HTTPException, Request

KEY = "pg"
SOURCE = "razorpay_test"
LABEL = "Razorpay (test)"
DEFAULTS = {"enabled": False, "key_id": "", "key_secret": "", "webhook_secret": "",
            "api_url": "https://api.razorpay.com"}
SECRETS = ("key_secret", "webhook_secret")
TEST_KEY = re.compile(r"^rzp_test_[A-Za-z0-9]{6,40}$")
STATUS = {"captured": "SUCCESS", "refunded": "SUCCESS", "authorized": "PENDING", "created": "PENDING", "failed": "FAILED"}
DUPLICATE_WINDOW_S = 15 * 60
ENV = {"key_id": "NIRNAYA_RAZORPAY_KEY_ID", "key_secret": "NIRNAYA_RAZORPAY_KEY_SECRET",
       "webhook_secret": "NIRNAYA_RAZORPAY_WEBHOOK_SECRET", "api_url": "NIRNAYA_RAZORPAY_API_URL"}


class PGError(Exception):
    pass


def paise(rupees: float) -> int:
    return int(round(float(rupees) * 100))


class Razorpay:
    def __init__(self, cfg: dict):
        self.base = cfg["api_url"].rstrip("/")
        token = base64.b64encode(f"{cfg['key_id']}:{cfg['key_secret']}".encode()).decode()
        self.auth = f"Basic {token}"

    def _req(self, method: str, path: str, body: dict | None = None, timeout: float = 20.0) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Authorization": self.auth, "Content-Type": "application/json",
                                              "Accept": "application/json", "User-Agent": "Nirnaya"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read() or b"{}").get("error") or {}
                msg = err.get("description") or err.get("code") or e.reason
            except (json.JSONDecodeError, AttributeError):
                msg = e.reason
            if e.code == 401:
                raise PGError("Razorpay refused the keys: copy the test Key Id and Key Secret again")
            raise PGError(f"Razorpay answered {e.code}: {msg}")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise PGError(f"cannot reach Razorpay: {getattr(e, 'reason', e)}")

    def payments(self, count: int = 50) -> list[dict]:
        return self._req("GET", f"/v1/payments?count={max(1, min(count, 100))}").get("items", [])

    def payment(self, pid: str) -> dict:
        return self._req("GET", f"/v1/payments/{urllib.parse.quote(pid)}")

    def refunds(self, pid: str) -> list[dict]:
        return self._req("GET", f"/v1/payments/{urllib.parse.quote(pid)}/refunds").get("items", [])

    def refund(self, pid: str, amount_paise: int, receipt: str, notes: dict) -> dict:
        return self._req("POST", f"/v1/payments/{urllib.parse.quote(pid)}/refund",
                         {"amount": amount_paise, "speed": "normal", "receipt": receipt[:40], "notes": notes})

    def payment_link(self, body: dict) -> dict:
        return self._req("POST", "/v1/payment_links", body)


class PG:
    def __init__(self, store, rails, bus):
        self.store, self.rails, self.bus = store, rails, bus
        self.last_sync: dict | None = None

    # ── settings ────────────────────────────────────────────────────────────
    def config(self) -> dict:
        cfg = {**DEFAULTS, **{k: v for k, v in (self.store.kv_get(KEY) or {}).items() if k in DEFAULTS}}
        for k, name in ENV.items():
            if os.environ.get(name):
                cfg[k] = os.environ[name].strip()
        if os.environ.get(ENV["key_id"]):
            cfg["enabled"] = True
        return cfg

    def public(self) -> dict:
        cfg = self.config()
        out = {k: v for k, v in cfg.items() if k not in SECRETS}
        out.update({f"{k}_set": bool(cfg[k]) for k in SECRETS})
        out["locked"] = sorted(k for k, name in ENV.items() if os.environ.get(name))
        out["ready"] = self.ready()
        out["payments"] = sum(1 for t in self.rails.state["txns"].values() if t.get("source") == SOURCE)
        out["last_sync"] = self.last_sync
        return out

    def update(self, patch: dict) -> dict:
        """A secret sent as "" keeps the saved one; null clears it. Only test keys are accepted."""
        saved = dict(self.store.kv_get(KEY) or {})
        if patch.get("key_id") is not None:
            kid = str(patch["key_id"]).strip()
            if kid.startswith("rzp_live_"):
                raise ValueError("That is a live key. Nirnaya only uses Razorpay's test mode (rzp_test_…): no real money moves.")
            if kid and not TEST_KEY.match(kid):
                raise ValueError("A Razorpay test Key Id looks like rzp_test_XXXXXXXXXXXXXX (Dashboard → Account & Settings → API Keys, in Test mode).")
            saved["key_id"] = kid
        for k in SECRETS:
            if k in patch:
                if patch[k] is None:
                    saved.pop(k, None)
                elif str(patch[k]).strip():
                    saved[k] = str(patch[k]).strip()
        if patch.get("enabled") is not None:
            saved["enabled"] = bool(patch["enabled"])
        if patch.get("api_url") is not None:
            u = str(patch["api_url"]).strip().rstrip("/")
            if u and not re.match(r"^https?://[^\s/]+", u):
                raise ValueError("The API address starts with https://")
            saved["api_url"] = u or DEFAULTS["api_url"]
        self.store.kv_set(KEY, saved)
        return self.public()

    def ready(self) -> bool:
        c = self.config()
        return bool(c["enabled"] and TEST_KEY.match(c["key_id"] or "") and c["key_secret"])

    def client(self) -> Razorpay:
        c = self.config()
        if not TEST_KEY.match(c["key_id"] or ""):
            raise PGError("Set up Razorpay's test keys first (Ledger → Real payments)")
        if not c["key_secret"]:
            raise PGError("The Razorpay Key Secret is missing")
        return Razorpay(c)

    def test(self) -> dict:
        self.client().payments(count=1)
        return {"ok": True}

    # ── payments into the ledger ────────────────────────────────────────────
    def _customer_for(self, p: dict) -> str:
        notes = p.get("notes") or {}
        if isinstance(notes, list):  # Razorpay sends [] when there are none
            notes = {}
        cid = notes.get("customer_id")
        if cid and self.rails.customer(cid):
            return cid
        phone = re.sub(r"\D", "", str(p.get("contact") or ""))[-10:]
        email = str(p.get("email") or "").strip().lower()
        for c in self.rails.customers():
            if phone and c.get("phone", "")[-10:] == phone:
                return c["id"]
            if email and c.get("email", "").lower() == email:
                return c["id"]
        name = str(notes.get("customer_name") or "").strip()[:60] or \
            (f"Razorpay customer …{phone[-4:]}" if phone else "Razorpay customer")
        return self.rails.add_customer(name=name, phone=phone, vpa=str(p.get("vpa") or ""), email=email,
                                       source=SOURCE)["id"]

    def _apply_payment(self, p: dict) -> bool:
        """One Razorpay payment → one ledger transaction (created or brought up to date). True if it changed."""
        if not isinstance(p, dict) or not str(p.get("id", "")).startswith("pay_"):
            return False
        status = p.get("status", "created")
        cid = (self.rails.txn(p["id"]) or {}).get("customer_id") or self._customer_for(p)
        notes = p.get("notes") if isinstance(p.get("notes"), dict) else {}
        acq = p.get("acquirer_data") if isinstance(p.get("acquirer_data"), dict) else {}
        rrn = str(acq.get("rrn") or "")
        refunded = (p.get("amount_refunded") or 0) / 100
        fields = {
            "utr": rrn if re.fullmatch(r"\d{12}", rrn) else "",
            "customer_id": cid,
            "amount": round((p.get("amount") or 0) / 100, 2),
            "merchant": str(notes.get("merchant") or p.get("description") or "Razorpay test merchant")[:60],
            "created_at": float(p.get("created_at") or time.time()),
            "debit_status": "NOT_DEBITED" if status == "failed" else "DEBITED",
            "npci_status": STATUS.get(status, "PENDING"),
            "beneficiary_credited": status in ("captured", "refunded"),
            "source": SOURCE,
            "pg": {"id": p["id"], "status": status, "method": p.get("method"), "vpa": p.get("vpa"), "rrn": rrn,
                   "order_id": p.get("order_id"), "amount_refunded": refunded, "refund_status": p.get("refund_status"),
                   "error_code": p.get("error_code"), "error_description": p.get("error_description"),
                   "contact": p.get("contact"), "email": p.get("email")},
        }
        prev = (self.rails.txn(p["id"]) or {}).get("refund") or {"status": "NONE"}
        if refunded > 0:
            fields["refund"] = {**prev, "status": "PROCESSED", "amount": refunded, "at": prev.get("at") or time.time(),
                                "arn": prev.get("arn") or prev.get("ref") or ""}
        elif prev.get("status") not in ("NONE", None):
            fields["refund"] = prev
        else:
            fields["refund"] = {"status": "NONE"}
        changed = self.rails.upsert_external(p["id"], fields)
        if changed and status == "captured":
            self._mark_duplicate(p["id"])
        return changed

    def _mark_duplicate(self, tid: str) -> None:
        """Two captured payments of the same amount to the same merchant within 15 minutes: the later one is
        the duplicate (what "charged twice" means)."""
        t = self.rails.txn(tid)
        for o in self.rails.txns_for(t["customer_id"]):
            if o["id"] == tid or o.get("source") != SOURCE or (o.get("pg") or {}).get("status") != "captured":
                continue
            if abs(o["amount"] - t["amount"]) < 0.01 and o["merchant"] == t["merchant"] \
                    and abs(o["created_at"] - t["created_at"]) <= DUPLICATE_WINDOW_S:
                later, earlier = (t, o) if t["created_at"] >= o["created_at"] else (o, t)
                if not later.get("duplicate_of"):
                    self.rails.upsert_external(later["id"], {"duplicate_of": earlier["id"]})

    def sync(self, count: int = 50) -> dict:
        items = self.client().payments(count)
        changed = sum(1 for p in items if self._apply_payment(p))
        self.last_sync = {"at": time.time(), "seen": len(items), "changed": changed}
        if changed:
            self.bus.publish("rail.event", txn_id=None, event="pg.sync", by="Razorpay (test)")
        return self.last_sync

    def refresh(self, tid: str) -> bool:
        """Bring one transaction up to date from Razorpay (before evidence, and before a commit)."""
        t = self.rails.txn(tid)
        if not t or t.get("source") != SOURCE:
            return False
        changed = self._apply_payment(self.client().payment(tid))
        if changed:
            self.bus.publish("rail.event", txn_id=tid, event="pg.refresh", by="Razorpay (test)")
        return changed

    # ── webhooks ────────────────────────────────────────────────────────────
    def verify(self, raw: bytes, signature: str) -> bool:
        secret = self.config()["webhook_secret"]
        if not secret or not signature:
            return False
        good = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
        return hmac.compare_digest(good, signature.strip())

    def webhook(self, raw: bytes, signature: str, event_id: str) -> dict:
        if not self.verify(raw, signature):
            raise PGError("bad signature")
        seen = self.store.kv_get("pg_events") or []
        if event_id and event_id in seen:
            return {"ok": True, "duplicate": True}
        ev = json.loads(raw or b"{}")
        kind = ev.get("event", "")
        payload = ev.get("payload") or {}
        pay = ((payload.get("payment") or {}).get("entity")) or None
        ref = ((payload.get("refund") or {}).get("entity")) or None
        changed = False
        if pay:
            changed = self._apply_payment(pay) or changed
        if ref and ref.get("payment_id"):
            changed = self._apply_refund(ref) or changed
        if event_id:
            self.store.kv_set("pg_events", (seen + [event_id])[-500:])
        if changed:
            self.bus.publish("rail.event", txn_id=(pay or {}).get("id") or (ref or {}).get("payment_id"),
                             event=f"pg.{kind}", by="Razorpay (test)")
        return {"ok": True, "event": kind, "changed": changed}

    def _apply_refund(self, r: dict) -> bool:
        t = self.rails.txn(r["payment_id"])
        if not t:
            try:
                return self._apply_payment(self.client().payment(r["payment_id"]))
            except PGError:
                return False
        st = {"processed": "PROCESSED", "pending": "PENDING", "created": "PENDING", "failed": "FAILED"}.get(r.get("status"), "PENDING")
        refund = {**(t.get("refund") or {}), "status": st, "amount": (r.get("amount") or 0) / 100,
                  "ref": r.get("id"), "arn": (r.get("acquirer_data") or {}).get("arn") or r.get("id"),
                  "at": float(r.get("created_at") or time.time()), "initiated_at": float(r.get("created_at") or time.time())}
        return self.rails.upsert_external(t["id"], {"refund": refund})

    # ── a refund, through the sealed Tool Gateway only ──────────────────────
    def refund_for(self, tid: str, amount: float, idem: str, case_id: str) -> dict:
        t = self.rails.txn(tid)
        if not t or t.get("source") != SOURCE:
            raise PGError(f"{tid} is not a Razorpay payment")
        rz = self.client()
        for r in rz.refunds(tid):                    # exactly once, even if our own record of it was lost
            if (r.get("notes") or {}).get("nirnaya_idem") == idem or r.get("receipt") == idem[:40]:
                self._apply_refund(r)
                return {"id": r["id"], "status": r.get("status"), "amount": (r.get("amount") or 0) / 100,
                        "gateway": LABEL, "replayed": True}
        live = rz.payment(tid)
        self._apply_payment(live)
        if live.get("status") not in ("captured", "refunded"):
            raise PGError(f"Razorpay says {tid} is {live.get('status')}: nothing was captured, so there is nothing to refund")
        refundable = (live.get("amount") or 0) - (live.get("amount_refunded") or 0)
        want = paise(amount)
        if want <= 0:
            raise PGError("a refund must be more than ₹0")
        if want > refundable:
            raise PGError(f"only ₹{refundable / 100:,.2f} of {tid} can still be refunded")
        r = rz.refund(tid, want, idem, {"nirnaya_idem": idem, "case_id": case_id})
        self._apply_refund(r)
        try:                                         # so the ledger shows what Razorpay now has refunded
            self._apply_payment(rz.payment(tid))
        except PGError:
            pass                                     # the next sync or webhook catches it up
        return {"id": r.get("id"), "status": r.get("status"), "amount": (r.get("amount") or 0) / 100, "gateway": LABEL}

    # ── test payments people can make ───────────────────────────────────────
    def link_for(self, customer_id: str, amount: float, merchant: str, description: str = "") -> dict:
        c = self.rails.customer(customer_id)
        if not c:
            raise PGError(f"no customer {customer_id}")
        merchant = re.sub(r"[\x00-\x1f<>]", "", merchant or "").strip()[:40] or "Test merchant"
        if not 1 <= float(amount) <= 100_000:
            raise PGError("a test payment is between ₹1 and ₹1,00,000 (UPI's usual limit)")
        body = {"amount": paise(amount), "currency": "INR",
                "description": (description or f"{merchant} order")[:200],
                "customer": {"name": c["name"], **({"contact": f"+91{c['phone'][-10:]}"} if c.get("phone") else {}),
                             **({"email": c["email"]} if c.get("email") else {})},
                "notify": {"sms": False, "email": False}, "reminder_enable": False,
                "notes": {"customer_id": customer_id, "customer_name": c["name"], "merchant": merchant},
                "expire_by": int(time.time()) + 24 * 3600}
        link = self.client().payment_link(body)
        return {"id": link.get("id"), "short_url": link.get("short_url"), "status": link.get("status"),
                "amount": amount, "customer_id": customer_id}


def register(app, E) -> None:
    def P() -> PG:
        return E().pg

    def wrap(fn):
        try:
            return fn()
        except (PGError, ValueError) as ex:
            raise HTTPException(400, str(ex))

    @app.get("/api/pg")
    def pg_get():
        return P().public()

    @app.put("/api/pg")
    def pg_put(body: dict = Body(...)):
        return wrap(lambda: P().update(body))

    @app.post("/api/pg/test")
    def pg_test():
        return wrap(lambda: P().test())

    def regraph():
        e = E()
        e.graph.rebuild(e.rails, lambda v: e.tok.tokenise(v)[0])

    @app.post("/api/pg/sync")
    def pg_sync():
        out = wrap(lambda: P().sync())
        if out.get("changed"):
            regraph()
        return out

    @app.post("/api/pg/link")
    def pg_link(body: dict = Body(...)):
        return wrap(lambda: P().link_for(str(body.get("customer_id") or ""), float(body.get("amount") or 0),
                                         str(body.get("merchant") or ""), str(body.get("description") or "")))

    @app.post("/api/pg/razorpay/webhook")
    async def pg_webhook(request: Request):
        raw = await request.body()
        try:
            out = P().webhook(raw, request.headers.get("x-razorpay-signature", ""),
                              request.headers.get("x-razorpay-event-id", ""))
            if out.get("changed"):
                regraph()
            return out
        except PGError as ex:
            raise HTTPException(401 if "signature" in str(ex) else 400, str(ex))
        except (ValueError, json.JSONDecodeError):
            raise HTTPException(400, "not a Razorpay event")

