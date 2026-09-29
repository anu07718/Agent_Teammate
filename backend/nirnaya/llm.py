"""Optional Claude layer. Everything works without it; with a key it refines understanding and drafts replies.

The model only ever sees tokenised text. Its output is advisory: intent labels feed the same calibrated
router, and every drafted reply still passes the Promise Guard, which falls back to the template on any
violation. Enable with ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN); disable with NIRNAYA_LLM=off.
"""
from __future__ import annotations

import json
import logging
import os

log = logging.getLogger("nirnaya.llm")
MODEL = os.environ.get("NIRNAYA_MODEL", "claude-opus-5-5")
INTENTS = ["failed_debit", "refund_status", "duplicate_charge", "wrong_beneficiary", "unauthorized",
           "block_request", "kyc", "balance", "other"]

EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "intent": {"type": "string", "enum": INTENTS},
        "amount": {"type": ["number", "null"]},
        "days_ago": {"type": ["integer", "null"]},
        "merchant": {"type": ["string", "null"]},
        "language": {"type": "string", "enum": ["en", "hinglish", "hi", "other"]},
    },
    "required": ["intent", "amount", "days_ago", "merchant", "language"],
    "additionalProperties": False,
}


class LLM:
    def __init__(self):
        self.client = None
        self.error: str | None = None
        wanted = os.environ.get("NIRNAYA_LLM", "auto").lower()
        has_key = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
        if wanted == "off" or (wanted == "auto" and not has_key):
            return
        try:
            import anthropic
            self._anthropic = anthropic
            self.client = anthropic.Anthropic(timeout=30.0, max_retries=2)
        except Exception as e:  # SDK missing or no credentials
            self.error = str(e)
            self.client = None

    @property
    def enabled(self) -> bool:
        return self.client is not None

    def _call(self, system: str, user: str, *, effort: str = "low", schema: dict | None = None,
              max_tokens: int = 2048) -> str | None:
        if not self.client:
            return None
        kwargs = {}
        if schema:
            kwargs["output_config"] = {"effort": effort, "format": {"type": "json_schema", "schema": schema}}
        else:
            kwargs["output_config"] = {"effort": effort}
        try:
            resp = self.client.beta.messages.create(
                model=MODEL, max_tokens=max_tokens, system=system,
                messages=[{"role": "user", "content": user}],
                betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
        except self._anthropic.RateLimitError as e:
            self.error = f"rate limited: {e}"
            return None
        except self._anthropic.APIStatusError as e:
            self.error = f"API error {e.status_code}: {e.message}"
            return None
        except self._anthropic.APIConnectionError as e:
            self.error = f"connection error: {e}"
            return None
        if resp.stop_reason == "refusal":
            self.error = "declined by the model"
            return None
        return next((b.text for b in resp.content if b.type == "text"), None)

    def extract(self, tokenised_text: str) -> dict | None:
        out = self._call(
            "You read one customer message to an Indian bank or payments app and classify it. "
            "Identifiers have already been replaced by tokens; never try to guess them. "
            "failed_debit = money left the account but the payment failed or is stuck; refund_status = a merchant "
            "refund the customer is waiting for; duplicate_charge = charged twice; wrong_beneficiary = sent to the "
            "wrong UPI ID or account; unauthorized = a transaction the customer did not make; block_request = "
            "wants a card or UPI ID blocked; kyc = KYC or limits; balance = balance or statement.",
            tokenised_text, schema=EXTRACT_SCHEMA, max_tokens=1024)
        if not out:
            return None
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            return None

    def draft_reply(self, facts: list[str], template: str, language: str) -> str | None:
        lang = "Hinglish (Hindi in Latin script, mixed with English)" if language == "hinglish" else "English"
        return self._call(
            "You write the reply a payments support teammate sends to a customer. Use only the facts given; "
            "do not add amounts, dates, reference numbers or promises that are not in them. Keep it under 90 "
            f"words, warm and plain. Write in {lang}.",
            "Facts:\n- " + "\n- ".join(facts) + f"\n\nA correct but plain version:\n{template}",
            effort="low", max_tokens=1024)

    def ask_agent(self, persona: str, context: str, question: str) -> str | None:
        return self._call(persona + "\n\nAnswer from the activity log below only. If it is not there, say so.",
                          f"Activity log:\n{context}\n\nQuestion: {question}", effort="low", max_tokens=1024)
