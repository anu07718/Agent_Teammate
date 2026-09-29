"""Drift Monitor: when live cases stop looking like the ones the thresholds were certified on, fail closed.

It watches the population stability index (PSI) between calibration scores and recent live scores, and
the error rate humans find on autonomous actions. On alarm every α is halved and autonomy is capped at
HEDGE until a person clears it: a degrading model makes Nirnaya more cautious, never less.
"""
from __future__ import annotations

from collections import deque

import numpy as np

EDGES = np.array([0, 0.5, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99, 1.0001])


def psi(expected: np.ndarray, actual: np.ndarray) -> float:
    e = np.histogram(expected, EDGES)[0] / max(1, len(expected))
    a = np.histogram(actual, EDGES)[0] / max(1, len(actual))
    e, a = np.clip(e, 1e-4, None), np.clip(a, 1e-4, None)
    return float(np.sum((a - e) * np.log(a / e)))


class DriftMonitor:
    def __init__(self, reference: np.ndarray, window: int = 40, psi_alarm: float = 0.25):
        self.reference = reference
        self.recent: deque[float] = deque(maxlen=window)
        self.audits: deque[bool] = deque(maxlen=window)
        self.psi_alarm = psi_alarm
        self.alarm = False
        self.reason: str | None = None
        self.history: list[dict] = []

    def observe(self, score: float) -> None:
        self.recent.append(score)

    def audit(self, autonomous_was_right: bool) -> None:
        self.audits.append(autonomous_was_right)

    def check(self) -> dict:
        value = psi(self.reference, np.array(self.recent)) if len(self.recent) >= 15 else 0.0
        err = (1 - np.mean(self.audits)) if len(self.audits) >= 5 else 0.0
        tripped = None
        if value > self.psi_alarm:
            tripped = f"score distribution shifted (PSI {value:.2f} > {self.psi_alarm})"
        elif err > 0.1:
            tripped = f"humans overturned {err:.0%} of recent autonomous actions"
        if tripped and not self.alarm:
            self.alarm, self.reason = True, tripped
        status = {"psi": round(value, 3), "audit_error": round(float(err), 3), "window": len(self.recent),
                  "alarm": self.alarm, "reason": self.reason, "alpha_scale": 0.5 if self.alarm else 1.0,
                  "rung_cap": 1 if self.alarm else 2}
        self.history.append({"psi": status["psi"], "alarm": self.alarm})
        self.history = self.history[-120:]
        return status

    def clear(self) -> None:
        self.alarm, self.reason = False, None
        self.recent.clear()
        self.audits.clear()
