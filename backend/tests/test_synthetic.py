"""The demo bank's synthetic UPI payments, and answers that follow the question: an amount said any way is
read, the payment's own state decides the answer, and when nothing matches the customer hears their own
nearest payments (all of them in the case facts, so the Promise Guard passes the reply)."""
import asyncio

import pytest

from nirnaya import rails as rails_mod
from nirnaya.rails import Rails
from nirnaya.understand import extract_entities


@pytest.mark.parametrize("text,amount", [
    ("mera 1000 ka payment", 1000), ("meri 2,000 wali payment", 2000), ("payment of 2000 failed", 2000),
    ("paid 500 to Zomato", 500), ("My 1500 IRCTC payment failed", 1500), ("my 500 recharge is stuck", 500),
    ("Uber charged me twice 750", 750), ("I paid ₹2,450 to FreshMart", 2450),
    ("3 din pehle", None), ("my number is 98765 43210", None), ("9876543210", None), ("UTR 412345678901 failed", None),
    ("customer ID C-1001", None), ("call me at 10:30", None), ("in 2024 I paid", None), ("charged 2 times", None),
])
def test_an_amount_is_read_however_it_is_said_and_nothing_else_is(text, amount):
    assert extract_entities(text).get("amount") == amount


def test_the_demo_bank_has_a_payment_for_every_kind_of_answer(engine):
    t = engine.rails.state["txns"]
    assert len(t) == 40 and engine.rails.state["seed_version"] == rails_mod.SEED_VERSION
    kinds = {"failed and debited": lambda x: x["npci_status"] == "FAILED" and x["debit_status"] == "DEBITED",
             "not debited": lambda x: x["debit_status"] == "NOT_DEBITED", "pending": lambda x: x["npci_status"] == "PENDING",
             "reversed": lambda x: x["reversal"]["status"] == "REVERSED", "refund pending": lambda x: x["refund"]["status"] == "PENDING",
             "refund processed": lambda x: x["refund"]["status"] == "PROCESSED", "duplicate": lambda x: bool(x.get("duplicate_of")),
             "unrecognised": lambda x: bool(x.get("unrecognised")), "wrong beneficiary": lambda x: bool(x.get("wrong_beneficiary"))}
    for name, fits in kinds.items():
        assert sum(1 for x in t.values() if fits(x)) >= 2, name
    assert all(x["source"] == "demo" for x in t.values())


def test_an_older_demo_bank_is_topped_up_once_and_nothing_else_changes(store):
    old = rails_mod._seed(0)
    old["txns"] = {k: v for k, v in old["txns"].items() if k < "T-5100"}
    old["txns"]["T-5001"]["reversal"] = {"status": "REVERSED", "amount": 2450.0, "rrn": "R1"}   # something that happened
    old.pop("seed_version")
    store.kv_set("rails", old)
    r = Rails(store)
    assert len(r.state["txns"]) == 40 and r.state["txns"]["T-5001"]["reversal"]["rrn"] == "R1"
    assert len(Rails(store).state["txns"]) == 40                     # once
    off = rails_mod._seed(0)
    off.pop("seed_version")
    off["txns"] = {k: v for k, v in off["txns"].items() if k < "T-5100"}
    off["demo"] = False
    store.kv_set("rails", off)
    assert len(Rails(store).state["txns"]) == 9                      # demo switched off: no demo payments added


@pytest.mark.parametrize("cust,text,txn,reply", [
    ("C-1001", "mera 1000 ka payment", "T-5101", "wapas aa jayega"),
    ("C-1001", "mera 2000 ka payment fail ho gaya hai mujhe refund chahiye", "T-5102", "₹2,000"),   # done, or for a person: in Hinglish
    ("C-1001", "My 1500 IRCTC payment failed", "T-5104", "already been reversed"),
    ("C-1001", "my 500 recharge is stuck", "T-5103", "still waiting for a final status"),
    ("C-1001", "my 750 BigBasket payment failed", "T-5106", "before any money was taken"),
    ("C-1004", "Starbucks charged me twice 750", "T-5405", "duplicate charge of ₹750"),
    ("C-1004", "where is my refund of 15000 from MakeMyTrip", "T-5403", "processed your refund of ₹15,000"),
    ("C-1002", "my 2500 Flipkart refund has not come for days", "T-5204", "dispute"),
])
def test_each_question_is_answered_about_its_own_payment(run_case, cust, text, txn, reply):
    c = asyncio.run(run_case(cust, text))
    assert c["plan"]["txn_id"] == txn
    assert c["guard"]["ok"]
    said = next(m["text"] for m in reversed(c["conversation"]) if m["role"] == "nirnaya")
    assert reply in said, said


def test_no_match_names_the_customers_own_nearest_payments(run_case):
    c = asyncio.run(run_case("C-1001", "my payment of 4000 failed"))
    said = next(m["text"] for m in reversed(c["conversation"]) if m["role"] == "nirnaya")
    assert c["plan"]["txn_id"] is None and c["guard"]["ok"]
    assert said.startswith("I couldn't find a payment of ₹4,000") and "₹1,000 to Zomato" in said and "Is it one of these?" in said
    c = asyncio.run(run_case("C-1001", "something is wrong with a payment"))
    said = next(m["text"] for m in reversed(c["conversation"]) if m["role"] == "nirnaya")
    assert said.startswith("I couldn't tell which payment you mean") or said.startswith("Could you tell me")
