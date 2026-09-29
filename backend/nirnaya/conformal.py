"""Risk-controlled thresholds: the guarantee behind "wrong autonomous actions ≤ α".

For every action type and amount band, Learn-then-Test picks the lowest score threshold λ such that,
with probability ≥ 1 − δ, the share of wrong actions among the cases acted on stays ≤ α. Hypotheses
H₀(λ): risk(λ) > α are tested with an exact binomial tail in a fixed sequence from strict to loose;
the sequence stops at the first threshold that cannot be certified. Bigger amount bands get a smaller
α (the "rupee-weighted" part), so a ₹50,000 reversal needs far more evidence than a ₹500 one.
If nothing can be certified the threshold is ∞: that action never runs on its own (fail closed).
"""
from __future__ import annotations

import math

import numpy as np

from .policy import BANDS, CONFIDENCE, ActionType, band_of


def binom_cdf(k: int, n: int, p: float) -> float:
    if n == 0:
        return 1.0
    if p <= 0:
        return 1.0
    if p >= 1:
        return 1.0 if k >= n else 0.0
    lp, lq = math.log(p), math.log1p(-p)
    terms = [math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1) + i * lp + (n - i) * lq
             for i in range(0, k + 1)]
    m = max(terms)
    return min(1.0, math.exp(m) * sum(math.exp(t - m) for t in terms))


def min_samples(alpha: float, delta: float) -> int:
    """Fewest acted cases for which even zero errors could certify risk ≤ α."""
    return math.ceil(math.log(delta) / math.log1p(-alpha))


def ltt_threshold(scores: np.ndarray, wrong: np.ndarray, alpha: float, delta: float, grid: int = 80) -> dict:
    n_min = min_samples(alpha, delta)
    if len(scores) < n_min:
        return {"lambda": math.inf, "acted": 0.0, "error": None, "certified": False, "n": int(len(scores)),
                "n_needed": n_min}
    order = np.sort(scores)[::-1]
    # candidate thresholds from strict to loose, only where enough cases sit above to be testable at all
    cands = np.unique(np.quantile(order, np.linspace(0, 1, grid)))[::-1]
    lam_hat, acted, err = math.inf, 0.0, None
    for lam in cands:
        m = scores >= lam
        n = int(m.sum())
        if n < n_min:
            continue
        k = int(wrong[m].sum())
        if binom_cdf(k, n, alpha) <= delta:
            lam_hat, acted, err = float(lam), n / len(scores), k / n
        else:
            break
    return {"lambda": lam_hat, "acted": round(acted, 4), "error": None if err is None else round(err, 5),
            "certified": math.isfinite(lam_hat), "n": int(len(scores)), "n_needed": n_min}


class RiskControl:
    """Thresholds per (action, band) for ACT, and a looser one for HEDGE where the action can be undone."""

    def __init__(self, delta: float = 1 - CONFIDENCE):
        self.delta = delta
        self.table: dict[str, dict[str, dict]] = {}
        self.curves: dict[str, list[dict]] = {}

    def fit(self, rows: list[dict], scores: np.ndarray, y: np.ndarray, actions: dict[str, ActionType],
            alpha_scale: float = 1.0) -> None:
        wrong = 1.0 - y
        acts = np.array([r["action"] for r in rows])
        bands = np.array([band_of(r["amount"])[0] for r in rows])
        self.table, self.curves = {}, {}
        for aid, a in actions.items():
            self.table[aid] = {}
            ma = acts == aid
            for bname, _lo, _hi, factor in BANDS:
                m = ma & (bands == bname)
                if not a.moves_money and bname != "small":
                    self.table[aid][bname] = self.table[aid]["small"]
                    continue
                alpha = max(1e-4, a.alpha * factor * alpha_scale)
                act = ltt_threshold(scores[m], wrong[m], alpha, self.delta)
                hedge = {"lambda": math.inf, "certified": False}
                if a.reversible:
                    hedge = ltt_threshold(scores[m], wrong[m], min(0.25, 5 * alpha), self.delta)
                self.table[aid][bname] = {"alpha": round(alpha, 5), "act": act, "hedge": hedge}
            m = ma
            if m.sum():
                s, w = scores[m], wrong[m]
                pts = []
                for lam in np.linspace(0, 1, 41):
                    sel = s >= lam
                    if sel.sum() == 0:
                        continue
                    pts.append({"lambda": round(float(lam), 3), "deflection": round(float(sel.mean()), 4),
                                "precision": round(float(1 - w[sel].mean()), 4)})
                self.curves[aid] = pts

    def thresholds(self, action: str, amount: float) -> dict:
        """The thresholds for one action and amount; an uncertifiable threshold comes back as None."""
        band, _ = band_of(amount)
        return {"band": band, **_finite(self.table[action][band])}


def _finite(v):
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _finite(x) for k, x in v.items()}
    return v
