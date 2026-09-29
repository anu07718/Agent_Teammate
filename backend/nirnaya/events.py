"""In-process event bus. The web app subscribes over Server-Sent Events; tests read the history."""
from __future__ import annotations

import asyncio
import itertools
import time
from collections import deque
from typing import Any


class EventBus:
    def __init__(self, history: int = 500):
        self.subscribers: set[asyncio.Queue] = set()
        self.history: deque[dict] = deque(maxlen=history)
        self._ids = itertools.count(1)

    def publish(self, kind: str, **data: Any) -> dict:
        event = {"id": next(self._ids), "ts": time.time(), "kind": kind, **data}
        self.history.append(event)
        for q in list(self.subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass  # a slow client misses events; it re-syncs from /api/state
        return event

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)

    def recent(self, n: int = 100, kinds: set[str] | None = None) -> list[dict]:
        items = [e for e in self.history if kinds is None or e["kind"] in kinds]
        return items[-n:]
