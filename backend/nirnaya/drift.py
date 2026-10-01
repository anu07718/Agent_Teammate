"""Drift Monitor: when live cases stop looking like the ones the thresholds were certified on, fail closed.

It watches the population stability index (PSI) between each action's calibration scores and its recent
live scores, when the live cases score less certain (a new kind of case arriving), and the error rate
humans find on autonomous actions. On alarm every α is halved and autonomy is capped at
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
    """Scores are compared like with like: each action's live scores against that action's calibration
    scores, once there are enough of them (PSI on a handful of scores is noise). Scores observed without an
    action go against the pooled calibration scores."""

    MIN_PER_ACTION = 20

    def __init__(self, reference: np.ndarray, window: int = 40, psi_alarm: float = 0.25,
                 by_action: dict[str, np.ndarray] | None = None):
        self.reference = reference
        self.by_action = by_action or {}
        self.window = window
        self.recent: dict[str, deque[float]] = {}
        self.audits: deque[bool] = deque(maxlen=window)
        self.psi_alarm = psi_alarm
        self.alarm = False
        self.reason: str | None = None
        self.history: list[dict] = []

    def observe(self, score: float, action: str | None = None) -> None:
        key = action if action in self.by_action else "*"
        self.recent.setdefault(key, deque(maxlen=self.window)).append(score)

    def audit(self, autonomous_was_right: bool) -> None:
        self.audits.append(autonomous_was_right)

    def _psi(self) -> tuple[float, str | None]:
        """The worst per-action PSI among actions with enough live scores whose cases look *less* certain
        than the ones the thresholds were certified on (a new kind of case). Cases that score more
        certain than calibration keep the thresholds conservative; if those turn out wrong, people
        overturning them trips the audit signal instead."""
        worst, which = 0.0, None
        for key, live in self.recent.items():
            if len(live) < self.MIN_PER_ACTION:
                continue
            ref = self.by_action.get(key, self.reference) if key != "*" else self.reference
            arr = np.array(live)
            if arr.mean() >= float(np.mean(ref)) - 0.02:
                continue
            v = psi(ref, arr)
            if v > worst:
                worst, which = v, key
        return worst, which

    def check(self) -> dict:
        value, which = self._psi()
        err = (1 - np.mean(self.audits)) if len(self.audits) >= 5 else 0.0
        tripped = None
        if value > self.psi_alarm:
            where = f" for {which}" if which and which != "*" else ""
            tripped = f"score distribution shifted{where} (PSI {value:.2f} > {self.psi_alarm})"
        elif err > 0.1:
            tripped = f"humans overturned {err:.0%} of recent autonomous actions"
        if tripped and not self.alarm:
            self.alarm, self.reason = True, tripped
        status = {"psi": round(value, 3), "audit_error": round(float(err), 3),
                  "window": sum(len(v) for v in self.recent.values()),
                  "alarm": self.alarm, "reason": self.reason, "alpha_scale": 0.5 if self.alarm else 1.0,
                  "rung_cap": 1 if self.alarm else 2}
        self.history.append({"psi": status["psi"], "alarm": self.alarm})
        self.history = self.history[-120:]
        return status

    def clear(self) -> None:
        self.alarm, self.reason = False, None
        self.recent.clear()
        self.audits.clear()
