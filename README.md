# Nirnay

**The support teammate that verifies before it acts — and knows when to stop.**

Paytm AI Hackathon · **Track 3 — Autonomous AI Teammates**

---

## The problem

Support automation is stuck at roughly 30% autonomous resolution. Not because the model can't
resolve the rest — because nobody can bound the cost of being wrong, so "escalate" is the safe
default. Every production support agent draws its boundary on hardcoded thresholds that are not
wrong so much as **unmeasurable**: when the agent says it is 80% sure, nobody can say whether it
is right 80% of the time.

## The idea

Two rules, applied together:

> **① Never ask a human to approve an unverified outcome.**
> **② Never let an approval outlive the state it was given for.**

Four decisions instead of two — **ACT · HEDGE · ESCALATE · REFUSE** — routed on a confidence
score that is *post-trained for calibration* and reported as an Expected Calibration Error, not
asserted as a threshold.

Every proposed action is applied to a **Shadow Ledger** first, re-checked by the same code that
found the problem, and only then sealed to a human's approval — bound to a hash of the payload,
the verification result and the ledger version, so the approval voids if any of them move. The
case survives process restarts.

## Architecture

![Nirnay — system architecture](architecture/png/01-system-architecture.png)

Editable source: [`architecture/nirnay-architecture.drawio`](architecture/nirnay-architecture.drawio) — five pages:
system architecture · resolution loop · durable runtime · decision science · tech stack.
[Open it in diagrams.net](https://app.diagrams.net/#Uhttps%3A%2F%2Fraw.githubusercontent.com%2Fkarthikj30%2FAgent_Teammate%2Fmain%2Farchitecture%2Fnirnay-architecture.drawio)
or in VS Code with the Draw.io extension. PNG exports of every page are in [`architecture/png/`](architecture/png/).

## Read the deck

**[ppt.md](ppt.md)** — the full submission:

| Section | Contents |
|---|---|
| 1 | Problem statement |
| 2 | Proposed solution — components, mechanism, sealed approvals, innovation, scope boundaries |
| 3 | Technologies, architecture, methodology, prototype demo script |
| 4 | Feasibility analysis, with eleven scored risks and mitigations |
| 5 | Impact and benefits — social, economic, environmental |
| 6 | Business model and go-to-market |
| 7 | References and research |

## Status

Design stage. The build order is deliberate and documented in §3.3 of the deck: **the evaluation
set is built before the agent**, because a calibration metric measured on easy cases is worthless.

---

<sub>[`TRACK_SELECTION_ANALYSIS.md`](TRACK_SELECTION_ANALYSIS.md) is retained as background — the
earlier survey of the three hackathon tracks and the competing field that led to this one.</sub>
