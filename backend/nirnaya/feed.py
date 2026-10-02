"""Feeding your own data: customers and UPI transactions from a CSV, checked before anything is kept.

Every row is validated on its own and the file as a whole:
- shape: known columns only, at most 2,000 rows and 1 MB, the same header the template has;
- values: a 12-digit UTR, a real UPI ID (name@handle), a 10-digit Indian mobile number, an amount above
  ₹0 and within the UPI limit (₹1,00,000 unless NIRNAYA_IMPORT_MAX_AMOUNT says otherwise), a date that is
  not in the future nor more than two years old, a known status;
- uniqueness: a UTR or transaction id that is already in the ledger, or twice in the file, is refused;
- safety: cells that a spreadsheet would run as a formula (=, +, -, @) and text that reads like
  instructions to the agents ("ignore previous instructions…") are refused, not cleaned;
- provenance: each row is kept with where it came from (the file name and an import id), so the ledger,
  the cases and the audit trail show it was imported, and the whole import can be removed again.

Preview checks a file and changes nothing; Import keeps the rows that pass and lists the ones that did not.
"""
from __future__ import annotations

import csv
import io
import os
import re
import time
from datetime import datetime, timezone

from .sentry_gate import INJECTION

MAX_BYTES = 1_000_000
MAX_ROWS = 2_000
TXN_COLUMNS = ["txn_id", "customer", "amount", "merchant", "date", "utr", "status", "debited", "refund_status"]
CUSTOMER_COLUMNS = ["customer_id", "name", "phone", "upi_id", "email", "segment"]
REQUIRED = {"transactions": {"customer", "amount", "merchant", "date", "utr", "status"},
            "customers": {"name", "phone"}}
STATUS = {"success": "SUCCESS", "successful": "SUCCESS", "completed": "SUCCESS", "paid": "SUCCESS",
          "failed": "FAILED", "failure": "FAILED", "declined": "FAILED",
          "pending": "PENDING", "processing": "PENDING", "deemed": "PENDING"}
REFUND = {"": "NONE", "none": "NONE", "no": "NONE", "pending": "PENDING", "initiated": "PENDING",
          "processed": "PROCESSED", "refunded": "PROCESSED", "done": "PROCESSED"}
YES = {"yes", "y", "true", "1", "debited"}
NO = {"no", "n", "false", "0", "not debited", "not_debited"}
VPA = re.compile(r"^[A-Za-z0-9.\-_]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$")
NAME = re.compile(r"^[A-Za-z][A-Za-z .'\-]{1,59}$")
MERCHANT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 .&'()\-_/@]{0,59}$")
EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,}$")
TXN_ID = re.compile(r"^[A-Za-z0-9_\-]{3,40}$")
CID = re.compile(r"^C-\d{3,6}$")
SEGMENTS = {"retail", "premium", "business"}
DATE_FORMATS = ("%Y-%m-%d", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%d-%m-%Y", "%d/%m/%Y",
                "%d-%m-%Y %H:%M", "%d/%m/%Y %H:%M")


def max_amount() -> float:
    try:
        return float(os.environ.get("NIRNAYA_IMPORT_MAX_AMOUNT", "100000"))
    except ValueError:
        return 100_000.0


def template(kind: str) -> str:
    if kind == "customers":
        return ("customer_id,name,phone,upi_id,email,segment\n"
                ",Kavya Rao,9845012345,kavya.rao@okaxis,kavya@example.com,retail\n")
    return ("txn_id,customer,amount,merchant,date,utr,status,debited,refund_status\n"
            "UPI-0001,9845012345,1499.00,QuickMart,2026-09-30 18:20,512345678901,FAILED,yes,none\n"
            "UPI-0002,9845012345,349.00,CafeBrew,2026-10-01 09:05,512345678902,SUCCESS,yes,none\n"
            "UPI-0003,9845012345,349.00,CafeBrew,2026-10-01 09:06,512345678903,SUCCESS,yes,none\n")


def _phone(v: str) -> str | None:
    d = re.sub(r"[\s\-()]", "", v)
    d = re.sub(r"^(\+?91|0)(?=\d{10}$)", "", d)
    return d if re.fullmatch(r"[6-9]\d{9}", d) else None


def _date(v: str) -> float | None:
    v = v.strip()
    for f in DATE_FORMATS:
        try:
            return datetime.strptime(v, f).timestamp()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
    except ValueError:
        return None


def _unsafe(v: str) -> str | None:
    if v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "starts like a spreadsheet formula (=, +, -, @)"
    low = v.lower()
    if any(re.search(p, low) for p in INJECTION):
        return "reads like instructions to the agents, not data"
    return None


def parse(text: str, kind: str) -> tuple[list[dict], list[str]]:
    """The rows as dicts, and problems with the file as a whole."""
    if kind not in REQUIRED:
        return [], ["the kind is transactions or customers"]
    if len(text.encode()) > MAX_BYTES:
        return [], [f"the file is over {MAX_BYTES // 1000} KB; split it"]
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    head = [h.strip().lower() for h in (reader.fieldnames or [])]
    known = TXN_COLUMNS if kind == "transactions" else CUSTOMER_COLUMNS
    unknown = [h for h in head if h not in known]
    missing = sorted(REQUIRED[kind] - set(head))
    problems = []
    if unknown:
        problems.append(f"unknown column(s): {', '.join(unknown)}; the template has {', '.join(known)}")
    if missing:
        problems.append(f"missing column(s): {', '.join(missing)}")
    if problems:
        return [], problems
    rows = []
    for raw in reader:
        rows.append({(k or "").strip().lower(): (v or "").strip() for k, v in raw.items() if k})
        if len(rows) > MAX_ROWS:
            return [], [f"more than {MAX_ROWS} rows; split the file"]
    if not rows:
        problems.append("there are no rows under the header")
    return rows, problems


def check(rails, text: str, kind: str) -> dict:
    """Validate a file against the ledger as it is now. Changes nothing."""
    rows, problems = parse(text, kind)
    out = []
    seen_ids, seen_utr, seen_phone = set(), set(), set()
    ledger_utr = {t["utr"] for t in rails.state["txns"].values() if t.get("utr")}
    now = time.time()
    by_phone = {c.get("phone", "")[-10:]: c["id"] for c in rails.customers() if c.get("phone")}
    for i, r in enumerate(rows, start=2):  # line numbers as a spreadsheet shows them
        errs: list[str] = []
        for col, v in r.items():
            if v:
                bad = _unsafe(v)
                plain = (col == "amount" and re.fullmatch(r"-?[\d,.]+", v)) or (col in ("phone", "customer") and _phone(v))
                if bad and not plain:  # "+91 98…" and "-5" are data; the value checks below judge them
                    errs.append(f"{col}: {bad}")
        if kind == "customers":
            name, phone = r.get("name", ""), _phone(r.get("phone", ""))
            if not NAME.match(name):
                errs.append("name: 2 to 60 letters, spaces, dots, apostrophes or hyphens")
            if not phone:
                errs.append("phone: a 10-digit Indian mobile number (6–9 first)")
            elif phone in seen_phone or phone in by_phone:
                errs.append(f"phone: {phone} is already a customer" + (f" ({by_phone[phone]})" if phone in by_phone else " in this file"))
            vpa = r.get("upi_id", "")
            if vpa and not VPA.match(vpa):
                errs.append("upi_id: a UPI ID looks like name@bank")
            email = r.get("email", "")
            if email and not EMAIL.match(email):
                errs.append("email: not an email address")
            seg = (r.get("segment") or "retail").lower()
            if seg not in SEGMENTS:
                errs.append(f"segment: one of {', '.join(sorted(SEGMENTS))}")
            cid = r.get("customer_id", "")
            if cid and (not CID.match(cid) or rails.customer(cid) or cid in seen_ids):
                errs.append("customer_id: C- and digits, not already used (or leave it empty)")
            value = {"customer_id": cid or None, "name": name, "phone": phone, "vpa": vpa, "email": email.lower(),
                     "segment": seg}
            if phone:
                seen_phone.add(phone)
            if cid:
                seen_ids.add(cid)
        else:
            cust = r.get("customer", "")
            cid = cust if rails.customer(cust) else by_phone.get(_phone(cust) or "")
            if not cid:
                errs.append("customer: a customer id (C-1001) or the phone number of a customer already in the ledger")
            try:
                amount = round(float(r.get("amount", "").replace(",", "").replace("₹", "")), 2)
            except ValueError:
                amount = None
            if amount is None or amount <= 0:
                errs.append("amount: a number of rupees above 0")
            elif amount > max_amount():
                errs.append(f"amount: above ₹{max_amount():,.0f}, the UPI limit for one payment")
            merchant = r.get("merchant", "")
            if not (MERCHANT.match(merchant) or VPA.match(merchant)):
                errs.append("merchant: a name (letters, digits, spaces) or a UPI ID")
            ts = _date(r.get("date", ""))
            if ts is None:
                errs.append("date: YYYY-MM-DD (or DD-MM-YYYY), optionally with HH:MM")
            elif ts > now + 86_400:
                errs.append("date: in the future")
            elif ts < now - 730 * 86_400:
                errs.append("date: more than two years ago")
            utr = re.sub(r"\s", "", r.get("utr", ""))
            if not re.fullmatch(r"\d{12}", utr):
                errs.append("utr: the 12-digit UPI reference number")
            elif utr in ledger_utr or utr in seen_utr:
                errs.append(f"utr: {utr} is already " + ("in the ledger" if utr in ledger_utr else "in this file"))
            status = STATUS.get(r.get("status", "").lower())
            if not status:
                errs.append("status: SUCCESS, FAILED or PENDING")
            deb = r.get("debited", "").lower()
            if deb and deb not in YES | NO:
                errs.append("debited: yes or no")
            if status == "FAILED" and not deb:
                errs.append("debited: say yes or no for a failed payment (was the money taken?)")
            refund = REFUND.get(r.get("refund_status", "").lower())
            if refund is None:
                errs.append("refund_status: none, pending or processed")
            elif refund != "NONE" and status != "SUCCESS":
                errs.append("refund_status: only a payment that went through can be refunded")
            tid = r.get("txn_id", "") or (f"IMP-{utr}" if re.fullmatch(r"\d{12}", utr) else "")
            if tid and (not TXN_ID.match(tid) or rails.txn(tid) or tid in seen_ids):
                errs.append("txn_id: letters, digits, - or _, not already used (or leave it empty)")
            value = {"txn_id": tid, "customer_id": cid, "amount": amount, "merchant": merchant, "created_at": ts,
                     "utr": utr, "npci_status": status, "debited": deb in YES if deb else status != "FAILED",
                     "refund": refund}
            if utr:
                seen_utr.add(utr)
            if tid:
                seen_ids.add(tid)
        out.append({"line": i, "ok": not errs, "errors": errs, "value": value if not errs else None, "raw": r})
    ok = sum(1 for x in out if x["ok"])
    return {"kind": kind, "rows": out, "ok": ok, "rejected": len(out) - ok, "problems": problems}


def commit(rails, text: str, kind: str, filename: str = "import.csv") -> dict:
    """Keep the rows that pass; nothing else changes."""
    res = check(rails, text, kind)
    if res["problems"]:
        return {**res, "batch": None, "imported": 0}
    batch = f"IMP-{int(time.time() * 1000) % 10**10:010d}"
    src = re.sub(r"[^A-Za-z0-9 ._\-]", "", filename)[:60] or "import.csv"
    n = 0
    for row in res["rows"]:
        v = row["value"]
        if not v:
            continue
        if kind == "customers":
            c = rails.add_customer(name=v["name"], phone=v["phone"], vpa=v["vpa"], email=v["email"],
                                   segment=v["segment"], source="import", cid=v["customer_id"])
            rails.state["customers"][c["id"]].update(batch=batch, file=src)
        else:
            refund = {"status": v["refund"]}
            if v["refund"] == "PROCESSED":
                refund.update(amount=v["amount"], at=v["created_at"], arn="")
            elif v["refund"] == "PENDING":
                refund.update(initiated_at=v["created_at"])
            rails.upsert_external(v["txn_id"], {
                "customer_id": v["customer_id"], "utr": v["utr"], "amount": v["amount"], "merchant": v["merchant"],
                "created_at": v["created_at"], "npci_status": v["npci_status"],
                "debit_status": "DEBITED" if v["debited"] else "NOT_DEBITED",
                "beneficiary_credited": v["npci_status"] == "SUCCESS", "refund": refund,
                "source": "import", "batch": batch, "file": src})
        n += 1
    if kind == "transactions" and n:
        _mark_duplicates(rails, batch)
    rails._save()
    return {**res, "batch": batch if n else None, "imported": n}


def _mark_duplicates(rails, batch: str) -> None:
    """Two successful payments of the same amount to the same merchant within 15 minutes: the later is a
    duplicate (what "charged twice" means)."""
    rows = sorted((t for t in rails.state["txns"].values() if t.get("batch") == batch and t["npci_status"] == "SUCCESS"),
                  key=lambda t: t["created_at"])
    for i, t in enumerate(rows):
        for o in rows[:i]:
            if o["customer_id"] == t["customer_id"] and o["merchant"] == t["merchant"] \
                    and abs(o["amount"] - t["amount"]) < 0.01 and t["created_at"] - o["created_at"] <= 900:
                rails.upsert_external(t["id"], {"duplicate_of": o["id"]})
                break


def batches(rails) -> list[dict]:
    out: dict[str, dict] = {}
    for kind, items in (("customers", rails.state["customers"].values()), ("transactions", rails.state["txns"].values())):
        for x in items:
            b = x.get("batch")
            if b:
                d = out.setdefault(b, {"batch": b, "file": x.get("file"), "customers": 0, "transactions": 0})
                d[kind] += 1
    return sorted(out.values(), key=lambda d: d["batch"], reverse=True)
