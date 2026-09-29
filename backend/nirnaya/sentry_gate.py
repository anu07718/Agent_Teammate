"""Sentry: the ingress risk cascade. Rules only, no model on this path, so it answers in well under 200 ms.

Verdicts: pass (continue), adjudicate (continue, but the case can never be auto-actioned),
block (refuse politely; the attempt is logged).
"""
from __future__ import annotations

import re
import time

INJECTION = [
    r"ignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|rules|prompts?)",
    r"disregard (?:your|all|the) (?:rules|instructions|policy)",
    r"\byou are now\b", r"\bsystem prompt\b", r"\bdeveloper mode\b", r"\bjailbreak\b",
    r"\bact as (?:an? )?(?:admin|administrator|bank manager|developer)\b",
    r"\b(?:bypass|skip|override) (?:the )?(?:verification|checks?|policy|limits?|approval)\b",
    r"without (?:any )?(?:verification|checks?|approval)",
    r"<\s*/?\s*(?:system|assistant|tool)\s*>", r"\[\s*(?:system|admin)\s*\]",
]
CREDENTIAL_ASK = [
    r"\b(?:share|send|tell|give)\b.{0,20}\b(?:otp|pin|cvv|password|mpin)\b",
    r"\bmy (?:otp|pin|mpin|cvv) is\b", r"\b(?:otp|pin|mpin|cvv)\s*[:=]?\s*\d{4,6}\b",
]
ABUSE = [r"\b(?:idiot|stupid|useless|cheat(?:ers|s)?|scam(?:mers)?)\b", r"\b(?:sue|legal notice|police complaint|consumer court)\b"]
COMMAND_CREDIT = r"\b(?:credit|transfer|send|refund|pay)\b.{0,25}(?:₹|rs\.?|inr)\s?([\d,]+)"


def _amount(text: str) -> float:
    m = re.search(COMMAND_CREDIT, text, re.I)
    return float(m.group(1).replace(",", "")) if m else 0.0


class Sentry:
    def __init__(self, velocity_limit: int = 5, velocity_window_s: float = 600):
        self.velocity_limit = velocity_limit
        self.velocity_window_s = velocity_window_s
        self._recent: dict[str, list[float]] = {}

    def check(self, customer_id: str, text: str) -> dict:
        t0 = time.perf_counter()
        low = text.lower()
        reasons: list[dict] = []
        risk = 0.05

        hits = [p for p in INJECTION if re.search(p, low)]
        if hits:
            reasons.append({"rule": "prompt_injection", "detail": "instruction-override language in the message"})
            risk = max(risk, 0.97)
        if any(re.search(p, low) for p in CREDENTIAL_ASK):
            reasons.append({"rule": "credential", "detail": "OTP / PIN / CVV mentioned; never stored or repeated"})
            risk = max(risk, 0.6)
        if any(re.search(p, low) for p in ABUSE):
            reasons.append({"rule": "escalation_language", "detail": "abusive or legal-threat language"})
            risk = max(risk, 0.45)
        amt = _amount(text)
        if hits and amt:
            reasons.append({"rule": "commanded_credit", "detail": f"message orders a credit of ₹{amt:,.0f}"})
        elif amt >= 100_000:
            reasons.append({"rule": "large_amount", "detail": f"₹{amt:,.0f} is above the auto-handling band"})
            risk = max(risk, 0.5)

        now = time.time()
        window = [t for t in self._recent.get(customer_id, []) if now - t < self.velocity_window_s] + [now]
        self._recent[customer_id] = window
        if len(window) > self.velocity_limit:
            reasons.append({"rule": "velocity", "detail": f"{len(window)} messages in {self.velocity_window_s / 60:.0f} min"})
            risk = max(risk, 0.55)

        verdict = "block" if risk >= 0.9 else ("adjudicate" if risk >= 0.45 else "pass")
        return {"verdict": verdict, "risk": round(risk, 3), "reasons": reasons,
                "latency_ms": round((time.perf_counter() - t0) * 1000, 3)}
