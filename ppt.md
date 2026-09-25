# Nirnay

### The support teammate that verifies before it acts — and knows when to stop

**Paytm AI Hackathon · Track 3 — Autonomous AI Teammates**

**Karthik Janardhan** · [@karthikj30](https://github.com/karthikj30) · karthikjanardhan5@gmail.com
25 September 2026

---
---

# 1 · Problem Statement

### Support automation is stuck at ~30%. The model is not the bottleneck.

- A payments platform's disputes — stuck UPI transfers, failed settlements, chargebacks, KYC blocks — split roughly **30% automated / 70% human**.
- The 70% is not there because the agent *can't* resolve it. It's there because **nobody can bound the cost of being wrong**, so "escalate" is the safe default.

### The real defect: confidence nobody has measured

Every production support agent draws its boundary the same way:

```python
if amount > 5000 or sentiment == "angry" or confidence < 0.7:
    escalate()
```

Three numbers chosen in a meeting. Not wrong — **unmeasurable**. Nobody can answer:

- When the agent says 80% sure, **is it right 80% of the time?**
- What did the last threshold change cost, in wrongly-escalated tickets?
- Which of those three conditions is actually carrying the decision?

### Three failures that follow

| Failure | What it looks like |
|---|---|
| **Overconfidence** | Published research shows verbalised LLM confidence is systematically over-confident. An agent that says "I'm sure" and is wrong a third of the time is worse than one that stays silent — you've built process around believing it. |
| **Act-then-hope** | Agents execute and report success without ever re-checking the system they touched. Nobody catches the half-applied refund. |
| **Approval theatre** | "Human-in-the-loop" usually means a pop-up approving a *step*. The state moves underneath it, the process restarts, the queue is lost. |

> **The brief asks for "escalating to humans only when needed."**
> Nobody can currently define *needed*. That is the problem worth solving.

---
---

# 2 · Proposed Solution

## 2.1 · The idea in one screen

**Nirnay is a customer-resolution teammate built on two rules nobody else applies together:**

> **① Never ask a human to approve an unverified outcome.**
> **② Never let an approval outlive the state it was given for.**

### Four decisions, not two

| Decision | Trigger | Behaviour |
|---|---|---|
| 🟢 **ACT** | calibrated confidence ≥ high | Executes, verifies, logs, notifies, records the outcome |
| 🟡 **HEDGE** | mid band | Acts, **states its uncertainty in the reply**, attaches one-click undo |
| 🔴 **ESCALATE** | below threshold | Hands a **structured packet** to a human — findings, evidence, the action it *would* have taken, why it stopped |
| ⛔ **REFUSE** | adversarial / policy-violating | Blocked before the model runs, in <200 ms, written to the audit trail |

**The middle two rows are the product.** Everyone ships row 1 and row 3.

---

## 2.2 · The mechanism: act in a shadow, verify, *then* gate

Most agents: **decide → act → report.**
Nirnay: **decide → act in a shadow ledger → re-run the same deterministic check → compare to baseline → gate on the verified delta.**

```
 propose  ──▶  shadow-execute  ──▶  RE-CHECK  ──▶  compare vs baseline
                (never live)        (same code         │
                                     as intake)        ├─ improved & confident ──▶ commit
                                                       ├─ improved, mid band  ──▶ commit + undo token
                                                       ├─ no change / worse   ──▶ retry (bounded, max 3)
                                                       └─ still unresolved    ──▶ escalate with evidence
```

- The check that *verifies* the fix is the **same code** that *found* the problem. No second opinion, no LLM grading its own homework.
- **Bounded retry**, not infinite. Three attempts, then a human — with all three attempts attached.
- A human is only ever shown **a result that already passed verification**.

---

## 2.3 · Approvals that survive a restart

Every money-moving tool is declared as requiring approval **in code, not in a prompt**:

```python
@tool(approval_mode="always_require")
def submit_refund(order_id: str, amount: str, reason: str) -> str: ...
```

- A prompt instruction can be argued out of the model. **A tool-level flag cannot.**
- When it fires, the workflow **writes a checkpoint and pauses.** The process may exit, deploy, crash, restart.
- It resumes from the checkpoint with the human's response attached — the pending request is still there, intact.
- The approval carries the **hash of the exact payload + the verification result + the ledger state it was computed against.** If any of those move, the approval is void and re-requested.

> **You approve *this exact action, in this exact state* — not "the refund step".**
> That distinction is the entire difference between a demo and a system that touches money.

---

## 2.4 · Three locks before anything leaves the sandbox

Capability is disabled by default at three independent levels, none of which is the model's judgement:

1. **Server policy** — money-moving tools are off unless the deployment enables them
2. **Run opt-in** — the individual case must additionally request the capability
3. **Human approval** — bound to the verified artifact, as above

Plus deterministic primitives that **never ask a model a safety question**: tool allow-lists, protected-field sets, PII redaction on every log line, and injection-resistant structural fencing on retrieved policy text.

---

## 2.5 · How it addresses the problem

| Problem | Mechanism | Result |
|---|---|---|
| Escalation boundary is a guess | Confidence post-trained for **calibration**, reported as Expected Calibration Error | The threshold becomes a **defensible operating point**, not an opinion |
| Nobody knows the cost of moving it | Deflection-rate vs escalation-precision curve from the eval set | You can **price** a threshold change before shipping it |
| Agents act and hope | Shadow-execute + re-check with the intake code | **Wrong actions are caught before a human ever sees them** |
| Approvals go stale | Checkpointed, hash-bound, resumable approval | Approval **cannot drift** onto a different action |
| Only two outcomes exist | HEDGE band with undo | Cases that were escalated "just in case" **get resolved** |
| Nothing is measurable | Benchmarked on a published customer-service benchmark with reliability scoring | Outcomes are **reported, not asserted** |

**The mechanism of the business result:** calibration does not make the agent smarter. It makes the threshold **movable**. Every point of autonomy above 30% is a point nobody could previously justify buying.

---

## 2.6 · Innovation & Uniqueness

### Five things that, together, nobody in this field ships

| # | What | Why it's rare |
|:-:|---|---|
| **1** | **Calibrated escalation** — the policy is *trained*, reported as ECE, plotted as a reliability diagram | Every surveyed production support agent hardcodes the boundary. **None reports a calibration metric.** |
| **2** | **Verify-before-gate** — humans only ever see verified outcomes | Standard agents gate on *intent*. Gating on *verified result* moves the human from approver to auditor. |
| **3** | **Durable hash-bound approval** — survives restart, void if state moves | Most HITL is an in-memory pause. A restart loses the queue. |
| **4** | **Four-state routing with a HEDGE band** | The industry ships a binary. The hedge band is where the recovered 25% of volume actually lives. |
| **5** | **Benchmarked, not demoed** — reliability measured across repeated trials, not a single happy path | An agent that succeeds once in four tries is not 25% good; it is unusable. Reliability scoring says so. |

### The one-line claim

> **Every agent escalates. Ours is the only one that can tell you how often it's right when it doesn't — and it never asks you to approve something it hasn't already checked.**

### Why it's hard to copy

- Calibration is **months**, not a weekend: a post-training loop, an adversarial eval set, and the nerve to publish a metric that can embarrass you.
- The moat **compounds**: every resolved case is a labelled example, every escalation a hard negative. The curve tightens per deployment.
- Competitors can copy the architecture diagram in an afternoon. They cannot copy the eval set.

---

## 2.7 · Precedent: this architecture already ran on real money

- Two-stage guardrail built for **India's largest stock exchange** during an internship: every message to the internal LLM scored in **<200 ms**, routed **allow / soft-block→human queue / hard-block**, **405 passing tests**, grounded in national securities regulation and OWASP.
- The threshold trade-off is recorded **at the decision site**, in source:
  ```python
  ALLOW_THRESHOLD = 0.25   # lowered from 0.35 — catches 19 more attacks,
                           # cost = 1 extra safe case sent to the teacher
  ```
- A separate system post-trained an agent to emit a **calibrated** confidence signal, measured by Expected Calibration Error.
- A shipped self-hosted AI platform (**15,647 lines**) supplies the gateway, per-turn guardrails, binding token budgets and the console.

> **This is a port, not a prototype.** The new work is the domain layer and the retargeted risk model — scoped explicitly in §3.

---
---

# 3 · Technologies & Methodology

## 3.1 · Technologies to be used

| Layer | Technology |
|---|---|
| **Agent runtime** | **Microsoft Agent Framework** (Python) — graph workflows, middleware pipeline, checkpointing, tool-level approvals, OpenTelemetry |
| **Orchestration pattern** | Handoff builder (triage → refund / settlement / KYC specialist), concurrent fan-out, bounded loops |
| **Languages** | Python 3.12 (agent + risk model) · TypeScript / Next.js 14 (console, authorization layer) |
| **Model access** | Provider-agnostic client layer — hosted or self-hosted, swappable without a rewrite |
| **Reasoning models** | Frontier model for drafting and reasoning; small local models for scoring |
| **Risk / confidence models** | Rule engine → XGBoost → SVDD / Isolation Forest → ModernBERT, teacher/student distilled with QLoRA |
| **Calibration** | DPO post-training · Expected Calibration Error · reliability diagrams · temperature scaling baseline |
| **Policy training** | RL (GRPO / PPO) over multi-turn conversations via the framework's RL lab integration |
| **Retrieval** | pgvector · hybrid search · rerank-and-grade · self-correcting query rewrite on weak retrieval |
| **Tool interop** | **MCP** for every business system · **A2A** to expose the teammate to other agents |
| **Guardrails** | Ingress + egress middleware · DLP-style governance middleware · structural injection fencing · PII redaction |
| **Durability** | Checkpoint storage (file → Cosmos/Postgres in production) · immutable audit events · undo tokens |
| **Observability** | OpenTelemetry traces → Prometheus → Grafana · per-resolution cost, latency, tokens, ECE, deflection |
| **Evaluation** | τ²-bench customer-service simulation (user simulator + domain policy + tools) · LLM-as-judge on *negative* constraints · adversarial twin fixtures |
| **Agent definition** | Declarative YAML agents — policy as reviewable, versioned config |
| **Deploy** | Docker · Cloud Run / container host · self-hostable end-to-end for data residency |

### Three choices a technical judge will press on

1. **MCP for every business tool, no exceptions.** No agent imports a ledger directly. That is why the customer-facing reply and the ledger entry **cannot disagree** — a class of bug most support tools ship with.
2. **Two model classes, two jobs.** Small deterministic models do risk scoring in <200 ms with no LLM in the path. The LLM only drafts and reasons. **Anything touching money is decided by arithmetic.**
3. **Self-hostable end to end.** For a payments company with data-residency constraints, on-prem is a differentiator, not a footnote.

---

## 3.2 · Architecture

```
Customer message  (text · voice · Indic)
      │
      ▼
┌──────────────────────────────────────────────────────────────────┐
│ ① AUTHORIZE — in the application, before any model call           │
│    identity · entitlement · consent · PII minimisation            │
│    the LLM is never the authorization boundary                    │
├──────────────────────────────────────────────────────────────────┤
│ ② INTERCEPT — ingress middleware, no LLM, <200 ms                 │
│    rules → XGBoost → SVDD/IF → ModernBERT → risk score            │
│    >0.80 terminate with a safe reply · <0.25 pass                 │
│    middle band → adjudication → human queue                       │
├──────────────────────────────────────────────────────────────────┤
│ ③ TRIAGE & GROUND — handoff graph + self-correcting retrieval     │
│    triage ─▶ refund | settlement | KYC specialist                 │
│    plan → retrieve → rerank_and_grade → generate                  │
│    ↺ rewrite query when retrieval is weak                         │
├──────────────────────────────────────────────────────────────────┤
│ ④ CALIBRATE  ★ differentiator                                     │
│    0.45·retrieval + 0.30·source_trust + 0.25·verification         │
│    post-trained for calibration · reported as ECE                 │
│         ↓ ACT        ↓ HEDGE        ↓ ESCALATE                    │
├──────────────────────────────────────────────────────────────────┤
│ ⑤ SHADOW-EXECUTE + VERIFY   ★ differentiator                      │
│    apply to a shadow ledger → re-run intake checks → diff         │
│    improved? → proceed   unchanged/worse? → retry (max 3)         │
├──────────────────────────────────────────────────────────────────┤
│ ⑥ GATE — @tool(approval_mode="always_require")                    │
│    checkpoint written · workflow pauses · process may restart     │
│    approval bound to payload hash + verification + ledger state   │
│    resume with the human's response attached                      │
├──────────────────────────────────────────────────────────────────┤
│ ⑦ COMMIT + UNDO — real execution, undo token minted               │
├──────────────────────────────────────────────────────────────────┤
│ ⑧ GUARD EGRESS — groundedness + PII, before the customer sees it  │
├──────────────────────────────────────────────────────────────────┤
│ ⑨ OBSERVE — OpenTelemetry → Prometheus → Grafana                  │
│    cost/resolution · latency · ECE · deflection · undo rate       │
└──────────────────────────────────────────────────────────────────┘
```

**Read it as three bands:** ①–② cost nothing and reject the hostile; ③–④ think; ⑤–⑨ act under a gate that cannot be talked out of.

---

## 3.3 · Methodology — the order matters

**The eval set is the product. Most teams build the agent and bolt evaluation on afterwards. Do the opposite.**

| Phase | Deliverable | Why it comes here |
|---|---|---|
| **P1 · Dataset** | 30–50 conversations in three groups: clear-cut, **genuinely ambiguous**, adversarial. Each labelled ACT / HEDGE / ESCALATE / REFUSE. | **Without ambiguous cases an ECE means nothing.** Skip this and nothing downstream is meaningful. |
| **P2 · Skeleton** | Authorize → intercept → triage → decide → shadow → verify → gate → commit → observe, running end-to-end on **one** refund case, with a *constant* threshold. | Ugly is fine. This is the harness calibration plugs into. |
| **P3 · Risk model** | Retarget the two-stage router from *policy-violation* risk to **resolution confidence**. | Largest single piece of new work. The tri-state shape, teacher/student split and threshold methodology transfer; **the labels do not.** |
| **P4 · Calibrate** | DPO (temperature scaling as fallback) → reliability diagram → pick the operating point → **write the comment saying what it cost.** | That comment is a slide. |
| **P5 · Benchmark** | Run τ²-bench with a user simulator. Report reliability across repeated trials, not a single pass. | Turns "it works" into a number a judge can check. |
| **P6 · Console & demo** | Escalation inbox with Agent and Supervisor views. Rehearse **backwards from the refusal.** | Differentiation lives in the cases where it declines. |

### Implementation flow

```
 P1 dataset ──▶ P2 skeleton ──▶ P3 risk model ──▶ P4 calibrate ──┐
      ▲                                                          │
      └──────────── P5 benchmark ◀── reliability gap ◀───────────┘
                         │
                         ▼
                   P6 console + demo
```

The loop back to P1 is deliberate: a benchmark failure means the eval set was too easy, not that the agent is broken.

---

## 3.4 · Working prototype — the demo, in order

**Rehearsed backwards from the refusal. Happy path last, if at all.**

| # | Shown | What it proves |
|:-:|---|---|
| 1 | A prompt-injected message is rejected in <200 ms, before any model call, and appears in the audit trail | The cheap gate is real and pre-LLM |
| 2 | An ambiguous refund → **HEDGE**: resolved, uncertainty stated in the reply, undo token attached | The band that recovers volume |
| 3 | A shadow execution that **fails verification** → retried → escalated with all three attempts attached | Verify-before-gate, visibly |
| 4 | Approval pending → **kill the process** → restart → the case is still waiting, approve it, it completes | Durable approval, not a pop-up |
| 5 | Approve, then mutate the ledger underneath → the approval is **voided and re-requested** | Hash binding, demonstrated not claimed |
| 6 | The reliability diagram and the deflection-vs-escalation-precision curve, with the operating point marked | The slide nobody else has |
| 7 | Live Grafana: cost per resolution, ECE, deflection, undo rate | Measured, during the demo |

**Stated honestly before a judge asks:** backing systems are mocked (ledger, settlement, ticketing) — standard for this track. The eval set is synthetic but **adversarial by construction**.

---
---

# 4 · Feasibility Analysis

## 4.1 · Why this is buildable in the time available

| Component | Status | Effort |
|---|---|---|
| Agent runtime, graph workflows, checkpointing, tool approvals, telemetry | **Off-the-shelf** — production framework, installed with one command | ~0 |
| Gateway, per-turn guardrails, token budgets, console shell | **Already built and shipped** (own platform, 15.6K lines) | ~0 |
| Retrieval + self-correcting RAG loop | **Already built** | low |
| Tri-state routing skeleton, teacher/student split, HITL queue | **Already built** — needs retargeting, not rewriting | medium |
| Shadow-execute + verify loop | **New** — but the pattern is proven in open-source autonomous-repair agents | medium |
| Domain tools (refund, settlement, status, ticket CRUD) | **New**, mocked | low |
| **Risk model retargeted to resolution confidence** | **New — the critical path** | **high** |
| Calibration + reliability diagram | **Methodology already built and measured** | medium |
| Benchmark harness | **Off-the-shelf** — framework ships the integration | low |

**One high-effort item, everything else imported or adapted.** That is the definition of a feasible scope.

### Feasibility by dimension

- **Technical** — no unsolved research. Calibration, tri-state routing and checkpointed approval are all shipped art; the work is composition and labelling.
- **Data** — needs no production data. The benchmark supplies a user simulator; the adversarial set is hand-authored.
- **Operational** — self-hostable, single container, no GPU required for inference (risk models are small; RL training is optional and offline).
- **Economic** — the autonomous path costs single-digit rupees; see §5.2.
- **Regulatory** — read-only and draft-only modes ship first; ACT is enabled per-action-type behind the three locks.

---

## 4.2 · Challenges, risks & mitigations

| # | Risk | Severity | Strategy |
|:-:|---|:-:|---|
| **1** | **Retargeting the risk model is the critical path.** Policy-violation labels do not transfer to resolution confidence. | 🔴 High | Start P3 on day one in parallel with P2. Ship a temperature-scaled baseline first so a calibrated number exists even if DPO doesn't converge. |
| **2** | **A weak eval set makes the ECE meaningless.** Only clear-cut cases → a flattering, worthless curve. | 🔴 High | Build ambiguity in deliberately: contradictory evidence, partial refunds, missing txn legs. Peer-label a held-out slice to measure label noise. |
| **3** | **Autonomous money movement needs regulatory sign-off.** | 🔴 High | Ship read-only + draft-only first. HEDGE band and undo exist precisely so ACT can be enabled gradually, per action type. Immutable audit from day one. |
| **4** | **Over-confidence on out-of-distribution cases** — calibration holds in-distribution and degrades outside it. | 🟠 Med | Anomaly detector (SVDD/IF) in the ingress path routes OOD straight to ESCALATE regardless of stated confidence. Say this out loud; it is a strength. |
| **5** | **Verification is only as good as the check.** A shallow re-check passes a bad fix. | 🟠 Med | The verifier is the *intake* code, not a second implementation — drift is structurally impossible. Salience scan warns when a known failure signal went uncovered. |
| **6** | **Prompt injection via policy documents or customer text.** | 🟠 Med | Retrieved text rides in its own lower-trust message inside a per-turn nonce fence; homoglyph/RTL/zero-width disguises folded. Proven by twin fixtures differing in one planted instruction. |
| **7** | **Demo depends on live model APIs.** | 🟠 Med | Mock mode + cached traces. The provider layer is swappable; a local model backs the demo if the network fails. |
| **8** | **Reuse permission for prior internship work.** | 🟠 Med | **Resolve before build starts.** Fallback: build on the owned, licence-clean platform and port only the *methodology*. Architecture and authorship are unaffected. |
| **9** | **Scope creep — building a full support suite.** | 🟡 Low | One dispute type, end to end. Narrow domain → better calibration → and calibration *is* the demo. |
| **10** | **Incumbents add calibration.** | 🟡 Low | They will. The lead is the adversarial eval set and per-customer tuning discipline, not the idea. |

**The honest one:** if the calibration curve comes out flat and uninformative, the differentiation is gone and it becomes another support bot. Mitigation is mitigation #1 and #2 — and knowing by P4, not on demo day.

---
---

# 5 · Impact & Benefits

## 5.1 · Target audiences and what changes for each

| Audience | Today | With Nirnay |
|---|---|---|
| **Support agent** | Queue full of cases a bot could have closed; each arrives as a raw transcript | Sees only genuinely hard cases, each as a **structured packet** — findings, evidence, proposed action, reason it stopped |
| **Customer** | Minutes to hours; a bot that either guesses or gives up | Seconds for clear cases; **honest uncertainty with an undo** for ambiguous ones; a prepared human for hard ones |
| **Support leader** | Can't raise autonomy without moving a number they can't defend | A **priced** threshold: "+5 points of deflection costs 1.2 points of escalation precision" |
| **Risk & compliance** | Opaque decisions, no provenance | Every decision an immutable audit event; every refusal signed; every action approved against a payload hash |
| **Engineering** | Prompt changes with unknown blast radius | Declarative agent config, versioned; regression caught by the benchmark before deploy |

---

## 5.2 · Economic benefit

| Metric | Today | With Nirnay | Mechanism |
|---|---|---|---|
| Automated resolution | ~30% | **55–65%** | Cases the bot *can* handle stop being escalated "just in case" |
| Escalation precision | unmeasured | **reported, with a curve** | The reliability diagram is the instrument |
| Cost per resolution | ~₹40–60 (human) | **~₹3–6** (autonomous path) | Small models gate; the expensive model runs only after the cheap gate says yes |
| First response | minutes–hours | **<5 seconds** | Interception and grounding in one pass |
| Wrongly-automated cases | unbounded | **bounded and measured** | What the HEDGE band and verification exist to hold down |
| Reversal cost | manual investigation | **one-click undo** | Undo token minted at commit |

*Directional — presented as a model with the arithmetic shown, not as measurements.*

**Why the margin holds:** the expensive path is the human one, and the product's whole job is to send fewer cases down it. Every architectural decision in §3.1 is also a unit-economics decision.

---

## 5.3 · Social, environmental and systemic benefit

**Social**
- **Dignity in dispute handling.** A stuck ₹2,000 transfer matters more to a daily-wage earner than a ₹200,000 one does to a business. Sub-5-second resolution is not a convenience metric at the bottom of the income distribution.
- **Indic-language parity.** Voice-first, multilingual resolution reaches users who cannot navigate an English chat flow — the segment currently least served by automation.
- **Better jobs, not fewer.** Agents move from transcript-reading to judgement. The packet does the reading.
- **Honest machines.** A system that says "I am not sure, here is a human" is a small public good in a market being flooded with confident, wrong AI.

**Environmental**
- Small deterministic models handle interception and scoring; the large model runs only after the cheap gate passes. **Most rejected traffic never reaches a GPU.**
- Bounded retries (max 3) cap worst-case compute per case.
- Self-hostable, so compute can sit where the grid is cleanest and data residency allows.

**Systemic**
- A published, checkable reliability number raises the floor for what "autonomous" is allowed to mean in regulated finance.

---
---

# 6 · Business Model

## 6.1 · The wedge

> **Don't sell a chatbot. Sell the confidence layer that makes the chatbot already deployed safe to turn up.**

Every enterprise that bought support automation is stuck at the same ceiling for the same reason — and they have already paid for the bot. The confidence layer is model-agnostic and bot-agnostic.

---

## 6.2 · Three revenue lines

**① Outcome-priced resolution — the primary model**

Charge per **autonomously resolved** ticket. Not per API call, not per seat.

| Tier | Volume / month | Price | Includes |
|---|---|---|---|
| **Pilot** | ≤5,000 resolutions | Free, 60 days | Hosted, your data, **reliability report** as the deliverable |
| **Growth** | 5k–100k | ₹12 / resolution | Full pipeline, Grafana, HITL console, 2 channels |
| **Enterprise** | 100k+ | ₹6–8 / resolution + platform fee | Self-hosted or VPC, custom risk model, data residency, SLA |

Billing only on successful autonomous resolution makes the **pricing model and the calibration story the same argument**: we bill when we were right to act, and we can prove how often that is.

**② Calibration-as-a-Service — the durable one**

Sell *around* an incumbent: they keep their agent, you supply the score, the four-state router, the approval queue and the reliability reporting. Priced per scored decision. Lands where the buyer has already spent and is stuck — much shorter cycle than replacing the bot.

**③ Regulated on-prem licence — the high-margin one**

Banks, exchanges, insurers and PSPs cannot send dispute traffic to a hosted endpoint. The platform is already self-hosted and the risk-model lineage is already on-prem. Annual licence + deployment + **tuning retainer** — the retainer is not a bolt-on, it is the honest consequence of the product working as claimed: thresholds must be re-tuned per customer.

---

## 6.3 · Go-to-market

1. **Land** on one narrow dispute type with clean policy documents — failed UPI transfers, or settlement queries. Narrower domain → better calibration → and calibration is the demo.
2. **Prove** with a 60-day pilot whose deliverable is a **reliability report**, not a feature list. No competitor can produce one.
3. **Expand** dispute type by dispute type. Each reuses the pipeline and needs only a labelled eval set — which the previous deployment has been generating in production.
4. **Compound.** Every resolved case is a labelled example; every escalation a hard negative. **The second customer is cheaper than the first.**

---
---

# 7 · References & Research

### Frameworks, protocols and runtime

- **Microsoft Agent Framework** — graph workflows, middleware, checkpointing, tool approvals, telemetry — [learn.microsoft.com/agent-framework](https://learn.microsoft.com/en-us/agent-framework/)
- **Model Context Protocol** — tool and data interop — [modelcontextprotocol.io](https://modelcontextprotocol.io)
- **A2A (Agent-to-Agent) protocol** — cross-agent handoff — [a2aproject.github.io/A2A](https://a2aproject.github.io/A2A/)
- **LangGraph human-in-the-loop** — `interrupt()`, checkpointer-backed pause/resume — [docs.langchain.com](https://docs.langchain.com/oss/python/deepagents/human-in-the-loop)
- **OpenAI Agents SDK human-in-the-loop** — tools declare `needs_approval` as a **per-call predicate**; that predicate is where a calibrated score belongs — [openai.github.io/openai-agents-python](https://openai.github.io/openai-agents-python/human_in_the_loop/)
- **OpenTelemetry GenAI semantic conventions** — [opentelemetry.io](https://opentelemetry.io/docs/specs/semconv/gen-ai/)

### Evaluation and benchmarking

- **τ-bench / τ²-bench** — customer-service agent benchmark with a user simulator and domain policies; introduces **pass^k**, reliability across repeated trials rather than single-run accuracy — [arxiv.org/abs/2406.12045](https://arxiv.org/abs/2406.12045)
- **RAGAS** — retrieval and groundedness scoring — [docs.ragas.io](https://docs.ragas.io)
- **DeepEval / Phoenix** — LLM-as-judge harnesses and tracing

### Calibration and abstention — the research behind the moat

- **"Can LLMs Express Their Uncertainty?"** (ICLR 2024) — key finding: **verbalised confidence is systematically over-confident.** The argument for a trained alternative. — [arxiv.org/abs/2306.13063](https://arxiv.org/abs/2306.13063)
- **"On Calibration of Modern Neural Networks"** — temperature scaling; the ECE baseline — [arxiv.org/abs/1706.04599](https://arxiv.org/abs/1706.04599)
- **Direct Preference Optimization (DPO)** — preference post-training without a reward model — [arxiv.org/abs/2305.18290](https://arxiv.org/abs/2305.18290)
- **Group Relative Policy Optimization (GRPO)** — RL for multi-turn agent policies — [arxiv.org/abs/2402.03300](https://arxiv.org/abs/2402.03300)
- **Selective prediction / abstention** — learning to decline — [arxiv.org/abs/1705.08500](https://arxiv.org/abs/1705.08500)
- **Reliability diagrams** — the plot that is the differentiating slide — [scikit-learn.org/stable/modules/calibration.html](https://scikit-learn.org/stable/modules/calibration.html)

### Training and tooling

- **TRL** — DPO implementation; the owned platform already exports preference pairs in its format — [huggingface.co/docs/trl](https://huggingface.co/docs/trl)
- **PEFT / QLoRA** — teacher/student distillation under one GPU — [arxiv.org/abs/2305.14314](https://arxiv.org/abs/2305.14314)
- **OWASP Top 10 for LLM Applications** — the guardrail checklist — [owasp.org/www-project-top-10-for-large-language-model-applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)

### Own prior work referenced

- Two-stage AI guardrail for a national stock exchange — tri-state routing, <200 ms, 405 tests *(private)*
- Calibrated-uncertainty search agent — DPO post-training, measured ECE *(private)*
- Cyclic RAG gateway with in/out guardrails and multi-provider routing *(private)*
- Per-request cost/latency/token observability stack — [NSE_Observability](https://github.com/karthikj30/NSE_Observability)
- Self-hosted AI platform — gateway, capability router, per-turn guardrails, binding token budgets, preference-pair export *(15,647 lines)*
- Track selection rationale — [`TRACK_SELECTION_ANALYSIS.md`](TRACK_SELECTION_ANALYSIS.md)

---

<div align="center">
<sub>

**Nirnay** — verify, then gate. Durably.
Paytm AI Hackathon · Track 3 — Autonomous AI Teammates · September 2026

</sub>
</div>
