"""Customer replies built only from case facts, in English or Hinglish. The Promise Guard checks each one."""
from __future__ import annotations


def rs(v: float) -> str:
    """Indian digit grouping: ₹1,25,000 and ₹2,450.50."""
    v = float(v)
    whole, frac = f"{abs(v):.2f}".split(".")
    head, tail = whole[:-3], whole[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    grouped = ",".join(groups + [tail]) if groups else tail
    return f"{'-' if v < 0 else ''}₹{grouped}" + ("" if frac == "00" else f".{frac}")


T = {
    "en": {
        "refuse_injection": "I can't act on instructions written into a message. If something went wrong with a "
                            "payment, tell me what happened and I'll check it for you.",
        "refuse_credential": "Please never share your OTP, PIN or CVV with anyone, including us. If you shared it with "
                             "someone, block your card or UPI ID in the app now. Tell me what happened and I'll help.",
        "need_utr": "I couldn't find a matching payment on your account. Could you share the 12-digit UTR, or the "
                    "amount and the date of the payment?",
        "one_charge": "I can see only one charge for this payment. If you were charged twice, please share the UTR of "
                      "the second debit.",
        "no_refund": "The merchant hasn't started a refund for this payment yet. Please ask them to initiate it; once "
                     "they do, it shows here within 5 working days.",
        "unclear": "Could you tell me a little more about the problem: which payment, the amount, and what went wrong?",
        "succeeded": "Your payment of {amount} to {merchant} went through (UTR {utr}) and the merchant was credited. If "
                     "they say it hasn't reached them, share this UTR with them.",
        "already_reversed": "Good news: the {amount} from this payment has already been reversed to your account "
                            "(ref {rrn}).",
        "pending": "Your payment of {amount} (UTR {utr}) is still waiting for a final status from the UPI switch. If it "
                   "fails, the money comes back to your account automatically.",
        "within_tat": "Your payment of {amount} to {merchant} failed at the UPI switch. The money comes back to your "
                      "account automatically by {due}. No action is needed from you.",
        "refund_processed": "{merchant} processed your refund of {amount} (ARN {arn}). Refunds take up to 5 working "
                            "days to show after processing.",
        "refund_pending": "{merchant} has started your refund of {amount}. It is still within the 5-working-day window.",
        "balance": "Your available balance is {balance}.",
        "kyc": "You can complete re-KYC in the app under Profile → KYC. It takes about 5 minutes.",
        "reverse_failed_debit": "I've reversed {amount} to your account for the failed payment to {merchant}.",
        "tat_compensation": "Because it took longer than it should have, I've also added {amount} as compensation.",
        "refund_duplicate": "I've refunded the duplicate charge of {amount} from {merchant}.",
        "raise_dispute": "I've raised a dispute for this payment; you'll get updates here as it progresses.",
        "block_instrument": "I've blocked your {instrument} so it can't be used again.",
        "chargeback_credit": "A provisional credit of {amount} has been added while the dispute is investigated.",
        "hedge": "If this doesn't look right, reply UNDO and I'll reverse it.",
        "escalate": "I've checked your payment and prepared the next step: {what}. A specialist is confirming it before "
                    "anything moves on your account, and you'll hear back here.",
        "escalate_generic": "I've passed your case to a specialist with everything I found so far. You'll hear back here.",
    },
    "hinglish": {
        "refuse_injection": "Message ke andar likhe instructions par main action nahi le sakta. Agar payment mein koi "
                            "problem hai, to batayein kya hua, main check karta hoon.",
        "refuse_credential": "Apna OTP, PIN ya CVV kabhi kisi ko na batayein, humein bhi nahi. Agar share ho gaya hai to "
                             "abhi app mein card ya UPI ID block karein. Batayein kya hua, main madad karta hoon.",
        "need_utr": "Aapke account par matching payment nahi mila. Kya aap 12-digit UTR, ya payment ka amount aur date "
                    "bata sakte hain?",
        "within_tat": "Aapka {amount} ka payment {merchant} ko UPI switch par fail hua. Paisa {due} tak apne aap aapke "
                      "account mein wapas aa jayega. Aapko kuch karne ki zaroorat nahi hai.",
        "already_reversed": "Achhi khabar: is payment ke {amount} aapke account mein wapas aa chuke hain (ref {rrn}).",
        "succeeded": "Aapka {amount} ka payment {merchant} ko successful hua (UTR {utr}) aur merchant ko mil gaya. Agar "
                     "woh kahein ki nahi mila, to unhe yeh UTR dein.",
        "reverse_failed_debit": "Maine {merchant} ke failed payment ke {amount} aapke account mein wapas kar diye hain.",
        "tat_compensation": "Der hone ki wajah se maine {amount} compensation bhi add kar diya hai.",
        "hedge": "Agar kuch galat lage, to UNDO reply karein, main ise wapas kar dunga.",
        "escalate": "Maine aapka payment check kar liya hai aur agla step taiyaar hai: {what}. Account par kuch bhi hone "
                    "se pehle ek specialist ise confirm kar raha hai; aapko yahin update milega.",
    },
}
WHAT = {"reverse_failed_debit": "a reversal of {amount}", "refund_duplicate": "a refund of {amount}",
        "tat_compensation": "compensation of {amount}", "chargeback_credit": "a provisional credit of {amount}",
        "raise_dispute": "a dispute with the other bank", "block_instrument": "a block on your {instrument}"}


def _t(lang: str, key: str) -> str:
    return T.get(lang, T["en"]).get(key) or T["en"][key]


def compose(case: dict) -> str:
    lang = case.get("understanding", {}).get("entities", {}).get("language", "en")
    sentry = case.get("sentry", {})
    if case.get("route") == "REFUSE":
        rules = {r["rule"] for r in sentry.get("reasons", [])}
        return _t(lang, "refuse_injection" if "prompt_injection" in rules else "refuse_credential")
    if case.get("route") == "ESCALATE" and not case.get("decisions"):
        return _t(lang, "escalate_generic")
    txn = case.get("txn") or {}
    base = {"merchant": txn.get("merchant", "the merchant"), "utr": txn.get("utr", ""),
            "amount": rs(txn.get("amount", 0)) if txn else ""}
    parts, escalated = [], []
    for d in case.get("decisions", []):
        a = d["action"]
        vars_ = {**base, **{k: (rs(v) if k == "balance" else v) for k, v in (a.get("vars") or {}).items()}}
        if a["type"] in ("share_status", "request_info"):
            parts.append(_t(lang, a.get("key", "unclear")).format(**vars_))
            continue
        vars_ = {**vars_, "amount": rs(a["amount"]) if a["amount"] else base["amount"],
                 "instrument": "card" if a.get("instrument") == "card" else "UPI ID"}
        if d["route"] in ("ACT", "HEDGE") and d.get("committed"):
            parts.append(_t(lang, a["type"]).format(**vars_))
        elif d["route"] == "ESCALATE":
            escalated.append(WHAT[a["type"]].format(**vars_))
    if escalated:
        parts.append(_t(lang, "escalate").format(what=" and ".join(escalated)))
    if any(d["route"] == "HEDGE" and d.get("committed") for d in case.get("decisions", [])):
        parts.append(_t(lang, "hedge"))
    return " ".join(p for p in parts if p) or _t(lang, "unclear")
