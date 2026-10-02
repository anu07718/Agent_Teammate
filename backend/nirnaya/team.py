"""The team: who is in the office, where they are, and one chat everyone sees.

- Presence comes from the live event stream. Each browser connects to /api/events?who=<name>&client=<id>,
  so everyone sees who else is working, and on which view, the moment they arrive or leave.
- The office chat is shared. What anyone asks an agent, the agent's answer, and every approval, rejection
  or undo (with who did it) land in that agent's chat for the whole team, and survive a restart.
"""
from __future__ import annotations

import hashlib
import re
import time
from typing import Callable

CHAT_KEY = "office_chat"
PER_AGENT = 120
COLORS = ["#5b7cfa", "#e0719a", "#2fa98c", "#d98a1c", "#8f6fe0", "#3c9bd6", "#c2413b", "#6b8e23"]


def clean_name(name: str | None, fallback: str = "Someone") -> str:
    name = re.sub(r"[\x00-\x1f<>]", "", (name or "")).strip()
    return re.sub(r"\s+", " ", name)[:32] or fallback


def color_for(name: str) -> str:
    return COLORS[int(hashlib.sha1(name.lower().encode()).hexdigest(), 16) % len(COLORS)]


class Team:
    def __init__(self, get_engine: Callable):
        self.E = get_engine
        self.people: dict[str, dict] = {}  # client id → person
        self._hooked = None

    # ── presence ─────────────────────────────────────────────────────────────
    def join(self, client: str, name: str, view: str | None = None) -> dict:
        name = clean_name(name)
        p = self.people.get(client)
        if p:
            p.update(name=name, color=color_for(name), conns=p["conns"] + 1, last=time.time())
            if view:
                p["view"] = view
        else:
            p = self.people[client] = {"client": client, "name": name, "color": color_for(name), "since": time.time(),
                                       "last": time.time(), "view": view or "office", "focus": None, "conns": 1}
        self._publish()
        return p

    def leave(self, client: str) -> None:
        p = self.people.get(client)
        if not p:
            return
        p["conns"] -= 1
        if p["conns"] <= 0:
            del self.people[client]
        self._publish()

    def update(self, client: str, *, name: str | None = None, view: str | None = None,
               focus: str | None = None) -> dict | None:
        p = self.people.get(client)
        if not p:
            return None
        if name is not None:
            p["name"] = clean_name(name)
            p["color"] = color_for(p["name"])
        if view is not None:
            p["view"] = view[:40]
        p["focus"] = (focus or None) and focus[:60]
        p["last"] = time.time()
        self._publish()
        return p

    def online(self) -> list[dict]:
        return sorted(({k: v for k, v in p.items() if k != "conns"} for p in self.people.values()),
                      key=lambda p: p["since"])

    def remote(self, client: str, name: str | None, view: str | None, focus: str | None, via: str) -> None:
        """Someone who joined the shared workspace with its code (relay.py), from wherever they are."""
        name = clean_name(name)
        new = {"name": name, "color": color_for(name), "view": (view or "office")[:40],
               "focus": (focus or None) and str(focus)[:60], "via": str(via)[:12], "remote": True}
        p = self.people.get(client)
        if p and all(p.get(k) == v for k, v in new.items()):
            p["last"] = time.time()
            return
        if p:
            p.update(new, last=time.time())
        else:
            self.people[client] = {"client": client, "since": time.time(), "last": time.time(), "conns": 1, **new}
        self._publish()

    def remote_gone(self, client: str) -> None:
        if self.people.pop(client, None):
            self._publish()

    def _publish(self) -> None:
        self.E().bus.publish("presence", people=self.online())

    # ── the shared chat ──────────────────────────────────────────────────────
    def chats(self) -> dict[str, list[dict]]:
        return self.E().store.kv_get(CHAT_KEY, {}) or {}

    def post(self, agent: str, who: str, text: str, *, by: str | None = None, icon: str | None = None,
             ref: str | None = None) -> dict:
        """who: "user" (a person wrote it), "agent" (the agent answered), "work" (a note of what happened)."""
        e = self.E()
        all_ = self.chats()
        seq = e.store.kv_get("office_chat_seq", 0) + 1
        e.store.kv_set("office_chat_seq", seq)
        msg = {"id": seq, "agent": agent, "who": who, "text": text[:4000], "by": clean_name(by) if by else None,
               "icon": icon, "ref": ref, "ts": time.time()}
        all_[agent] = (all_.get(agent) or [])[-(PER_AGENT - 1):] + [msg]
        e.store.kv_set(CHAT_KEY, all_)
        e.bus.publish("chat.message", message=msg)
        return msg

    # ── notes on what people decided, in the owning agent's chat ────────────
    def hook(self, bus) -> None:
        """Listen once per bus (a restart keeps the bus)."""
        if self._hooked is bus:
            return
        self._hooked = bus
        bus.listen(self._on_event)

    def _owner(self, case_id: str) -> str:
        c = self.E().store.get_case(case_id) or {}
        return (c.get("plan") or {}).get("specialist") or "triage"

    def _on_event(self, ev: dict) -> None:
        k = ev["kind"]
        if k == "approval.granted":
            who = ev.get("by") or "Someone"
            self.post(self._owner(ev["case_id"]), "work", f"{who} approved {ev['case_id']}"
                      + (" with an edit" if ev.get("edited") else "")
                      + ". The gateway checked the seal against the live ledger and committed it exactly once."
                      + (f" Note: “{ev['note']}”" if ev.get("note") else ""), icon="✅", ref=ev["case_id"], by=who)
        elif k == "approval.rejected":
            who = ev.get("by") or "Someone"
            self.post(self._owner(ev["case_id"]), "work", f"{who} rejected {ev['case_id']}."
                      + (f" Note: “{ev['note']}”" if ev.get("note") else "")
                      + " The customer is told a specialist will follow up, and the decision became a label.",
                      icon="❌", ref=ev["case_id"], by=who)
        elif k == "seal.rejected_approval":
            self.post(self._owner(ev["case_id"]), "work", f"The ledger moved after {ev['case_id']} was sealed, so the "
                      "approval was not applied. The case was checked again against the live ledger.",
                      icon="🔓", ref=ev["case_id"])
        elif k == "action.undone" and ev.get("by") not in (None, "customer"):
            self.post(self._owner(ev["case_id"]), "work", f"{ev['by']} undid the hedged action on {ev['case_id']}; "
                      "the customer was told.", icon="↩", ref=ev["case_id"], by=ev["by"])
