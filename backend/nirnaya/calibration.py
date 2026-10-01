"""Calibrated confidence: a logistic model over case features, then isotonic calibration on held-out labels.

"Stated" confidence is what a model says about itself; it is typically overconfident. Nirnaya never
routes on it. It routes on the calibrated score, whose meaning is checked: among cases scored 0.9,
about 90% were right. Until pilot data exists the labels are synthetic; every human decision adds a
real one (`Calibrator.fit(extra_labels=...)`).
"""
from __future__ import annotations

import math

import numpy as np

from .policy import default_actions

ACTION_IDS = list(default_actions().keys())
FEATURES = ["intent_conf", "evidence_agree", "log_amount", "prior_disputes", "memory_support", "sentry_risk",
            "novelty", "voice"]
# How hard each action type is to get right, all else equal (latent truth for the synthetic world).
ACTION_BIAS = {"share_status": 1.6, "request_info": 1.8, "reverse_failed_debit": 1.8, "refund_duplicate": 1.5,
               "tat_compensation": 1.2, "raise_dispute": 0.4, "block_instrument": 0.9, "chargeback_credit": -0.6}


def feature_vector(f: dict, action: str) -> np.ndarray:
    base = [f.get(k, 0.0) for k in FEATURES]
    onehot = [1.0 if a == action else 0.0 for a in ACTION_IDS]
    return np.array(base + onehot, dtype=float)


def log_amount(amount: float) -> float:
    return math.log10(1 + max(0.0, amount)) / 5.0      # ₹1 lakh → 1.0


def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


def synthetic_labels(n: int, seed: int = 7) -> tuple[list[dict], np.ndarray, np.ndarray]:
    """Labelled outcomes from a known latent process: features → P(the proposed action was right)."""
    rng = np.random.default_rng(seed)
    acts = rng.choice(ACTION_IDS, size=n, p=[0.24, 0.08, 0.2, 0.1, 0.1, 0.1, 0.08, 0.1])
    amount = np.where(np.isin(acts, ["share_status", "request_info", "raise_dispute", "block_instrument"]),
                      0.0, np.exp(rng.normal(7.4, 1.4, n)))
    intent_conf = np.clip(rng.beta(6, 1.6, n), 0, 1)
    evidence = rng.choice([0.0, 0.5, 1.0], size=n, p=[0.12, 0.18, 0.7])
    prior = np.clip(rng.poisson(0.5, n) / 5.0, 0, 1)
    memory = np.clip(rng.beta(2, 2, n) * evidence, 0, 1)
    sentry = np.clip(rng.beta(1.2, 12, n), 0, 1)
    novelty = rng.binomial(1, 0.25, n).astype(float)
    voice = rng.binomial(1, 0.15, n).astype(float)
    la = np.log10(1 + amount) / 5.0
    z = (-4.0 + 4.6 * intent_conf + 3.4 * evidence + 1.6 * memory - 3.2 * sentry - 1.0 * novelty - 0.7 * la
         - 0.8 * prior - 0.4 * voice + np.array([ACTION_BIAS[a] for a in acts]) + 2.4 * intent_conf * evidence)
    y = rng.binomial(1, _sigmoid(z)).astype(float)
    rows = [{"action": a, "amount": float(m), "features": {"intent_conf": float(i), "evidence_agree": float(e),
             "log_amount": float(l), "prior_disputes": float(p), "memory_support": float(me),
             "sentry_risk": float(s), "novelty": float(nv), "voice": float(v)}}
            for a, m, i, e, l, p, me, s, nv, v in zip(acts, amount, intent_conf, evidence, la, prior, memory, sentry,
                                                       novelty, voice)]
    X = np.stack([feature_vector(r["features"], r["action"]) for r in rows])
    return rows, X, y


def fit_logistic(X: np.ndarray, y: np.ndarray, l2: float = 1e-3, iters: int = 400) -> np.ndarray:
    Xb = np.hstack([X, np.ones((len(X), 1))])
    w = np.zeros(Xb.shape[1])
    for _ in range(iters):                               # Newton steps with a small ridge
        p = _sigmoid(Xb @ w)
        g = Xb.T @ (p - y) / len(y) + l2 * w
        H = (Xb * (p * (1 - p))[:, None]).T @ Xb / len(y) + l2 * np.eye(len(w))
        step = np.linalg.solve(H, g)
        w -= step
        if np.abs(step).max() < 1e-7:
            break
    return w


def isotonic(scores: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Pool-adjacent-violators. Returns knots (x, y) for np.interp."""
    order = np.argsort(scores)
    xs, ys = scores[order], y[order].astype(float)
    merged: list[list[float]] = []            # blocks of [mean, weight, x_first, x_last]
    for v, x in zip(ys, xs):
        merged.append([v, 1.0, x, x])
        while len(merged) > 1 and merged[-2][0] > merged[-1][0]:
            v2, w2, _a2, e2 = merged.pop()
            v1, w1, a1, _e1 = merged.pop()
            merged.append([(v1 * w1 + v2 * w2) / (w1 + w2), w1 + w2, a1, e2])
    kx, ky = [], []
    for v, _, a, e in merged:
        kx += [a, e]
        ky += [v, v]
    return np.array(kx), np.clip(np.array(ky), 1e-4, 1 - 1e-4)


def ece(p: np.ndarray, y: np.ndarray, bins: int = 15) -> float:
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi) if hi < 1 else (p >= lo) & (p <= hi)
        if m.any():
            total += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(total)


def reliability(p: np.ndarray, y: np.ndarray, bins: int = 10) -> list[dict]:
    edges = np.linspace(0, 1, bins + 1)
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi) if hi < 1 else (p >= lo) & (p <= hi)
        if m.sum() >= 5:
            out.append({"bin": round((lo + hi) / 2, 3), "confidence": round(float(p[m].mean()), 4),
                        "accuracy": round(float(y[m].mean()), 4), "count": int(m.sum())})
    return out


class Calibrator:
    def __init__(self, n: int = 200_000, seed: int = 7):
        self.n, self.seed = n, seed
        self.fit()

    def fit(self, extra_labels: list[dict] | None = None) -> None:
        rows, X, y = synthetic_labels(self.n, self.seed)
        if extra_labels:
            ex = np.stack([feature_vector(r["features"], r["action"]) for r in extra_labels])
            ey = np.array([float(r["correct"]) for r in extra_labels])
            rows = rows + [{"action": r["action"], "amount": r["amount"], "features": r["features"]} for r in extra_labels]
            X, y = np.vstack([X, ex]), np.concatenate([y, ey])
        rng = np.random.default_rng(self.seed + 1)
        idx = rng.permutation(len(y))
        cut1, cut2 = int(0.4 * len(y)), int(0.8 * len(y))
        tr, cal, te = idx[:cut1], idx[cut1:cut2], idx[cut2:]
        self.w = fit_logistic(X[tr], y[tr])
        raw_cal = self.stated(X[cal])
        self.knots = isotonic(raw_cal, y[cal])
        self.cal_rows = [rows[i] for i in cal]
        self.cal_scores = self.calibrated(X[cal])
        acts = np.array([r["action"] for r in self.cal_rows])
        self.cal_by_action = {a: self.cal_scores[acts == a] for a in set(acts.tolist())}
        self.cal_y = y[cal]
        p_raw_te, p_cal_te = self.stated(X[te]), self.calibrated(X[te])
        self.metrics = {"n_train": int(len(tr)), "n_calibration": int(len(cal)), "n_test": int(len(te)),
                        "real_labels": len(extra_labels or []),
                        "ece_stated": round(ece(p_raw_te, y[te]), 4), "ece_calibrated": round(ece(p_cal_te, y[te]), 4),
                        "reliability_stated": reliability(p_raw_te, y[te]),
                        "reliability_calibrated": reliability(p_cal_te, y[te])}

    def _logit(self, X: np.ndarray) -> np.ndarray:
        X = np.atleast_2d(X)
        return np.hstack([X, np.ones((len(X), 1))]) @ self.w

    def stated(self, X: np.ndarray) -> np.ndarray:
        """What a model would claim: the same signal, overconfident (sharpened and shifted up)."""
        return _sigmoid(2.1 * self._logit(X) + 1.1)

    def calibrated(self, X: np.ndarray) -> np.ndarray:
        return np.interp(self.stated(X), self.knots[0], self.knots[1])

    def score(self, features: dict, action: str) -> dict:
        x = feature_vector(features, action)
        return {"stated": round(float(self.stated(x)[0]), 4), "calibrated": round(float(self.calibrated(x)[0]), 4)}
