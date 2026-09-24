# Nirnay — the teammate that knows when to stop

**Paytm AI Hackathon · Track 3 — Autonomous AI Teammates**
Presentation deck + build plan
Prepared for Karthik Janardhan ([@karthikj30](https://github.com/karthikj30)) · 24 September 2026

> *Nirnay* (निर्णय) — "the decision". Working name; change it freely.
> Companion to [`TRACK_SELECTION_ANALYSIS.md`](TRACK_SELECTION_ANALYSIS.md), which chose the track.
> This document adds the two repo-scan answers that were open in §11, and turns the §9 proposal into a deck.

---

## Part 0 — The two questions, answered

Twelve public repositories were cloned and read at source level (not README level), plus
`Svayom/Svayom` — the repository §11 of the track analysis listed as *unread* and flagged as
capable of reordering the recommendation. It does not reorder it. It de-risks it. See §0.4.

### 0.1 Measured, not claimed

Line counts are own code — `.py`/`.ts`/`.tsx`/`.js`/`.jsx`, excluding `node_modules` and `.git`.

| Repository | Own LOC | Code files | Test files | What it actually is |
|---|---:|---:|---:|---|
| [Project-A.R.I.E.S](https://github.com/N-Garai/Project-A.R.I.E.S) | 20,793 | 125 | 5 | NASA telemetry → academic report. ADK Brain 4-phase loop (Plan→Reason→Route→Reflect) + 6 role agents + 124-tool registry |
| [accesspilot](https://github.com/joinarun/accesspilot) | 11,395 | 60 | 10 | Autonomous web-accessibility repair. Scan → map → plan → patch → re-scan → **human gate** → PR |
| [ReviewOps-Agent](https://github.com/mkiselyow/ReviewOps-Agent) | 10,851 | 115 | 18 | Performance-review teammate. Next.js app + Python ADK 2.0 agent service over REST |
| [memorybridge](https://github.com/CryptonV8/memorybridge) | 9,193 | 69 | 16 | Dementia-care routines. Draft → deterministic gate → semantic safety → caregiver approval → escalation |
| [trajectory-auditor](https://github.com/ShayIsso/trajectory-auditor) | 6,737 | 51 | 21 | Audits coding-agent session logs on 7 dimensions, synthesises an installable skill behind a write gate |
| [CritqAI](https://github.com/francisnguyenanh/CritqAI) | 6,362 | 18 | 3 | Socratic debate agent for essays. 6 agents, 4 MCP servers, deterministic validator |
| [astrotyper](https://github.com/eugeneh101/astrotyper) | 4,746 | 13 | 2 | 🏆 3rd place Kaggle capstone. LLM as a deterministic game master, LLM-as-judge eval suite |
| [KinKeeper](https://github.com/gpshalini/KinKeeper) | 2,929 | 20 | 9 | WhatsApp export → milestone events. Local-first, PII-redacting, FastMCP |
| [cooking-shopping-assistant](https://github.com/crisstugui-png/cooking-shopping-assistant) | 2,763 | 15 | 3 | BiteBudget. Session-sticky state machine, receipt OCR, injection gate with `RequestInput` |
| [palimpsest](https://github.com/carlosapsa/palimpsest) | 2,632 | 16 | 1 | 🏆 **1st place Freestyle**, 6,041 teams. Manuscript transcription with per-span confidence |
| [chance-electro-capstone](https://github.com/barmanoff/chance-electro-capstone) | 2,034 | 20 | 0* | Napkin photo → proposal + contract + invoice + GO/NO-GO. 3 agents over **A2A**, pricing over **MCP** |
| [TripWeaver](https://github.com/VenuAIAgenticDev/TripWeaver) | 1,122 | 12 | 1 | Trip planner. Textbook ADK: Sequential → Parallel → Loop with conditional skip |

\* chance-electro tests are Gherkin `.feature` files, not `test_*.py` — 4 feature files, so the zero is a naming artefact, not an absence.

**LOC is not merit.** Palimpsest won first place out of 6,041 teams with 2,632 lines. TripWeaver
is the smallest codebase here and the cleanest ADK reference in the set. Read the table as *shape*,
not *score*.

### 0.2 Question 1 — which suits Track 3 best?

Track 3 asks for four things. Scored 1–5 from source, not from README.

**A** autonomy across multiple steps · **B** takes actions in real systems · **C** an *engineered*
escalation boundary · **D** sales / customer-service domain · **E** a measurable outcome

| Repository | A | B | C | D | E | Σ |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| **accesspilot** | 5 | **5** | **5** | 1 | 5 | **21** |
| **chance-electro-capstone** | 4 | 3 | 2 | **5** | 5 | **19** |
| ReviewOps-Agent | 4 | 3 | 4 | 2 | 3 | 16 |
| trajectory-auditor | 4 | 3 | 4 | 1 | 4 | 16 |
| memorybridge | 3 | 3 | **5** | 1 | 3 | 15 |
| CritqAI | 4 | 3 | 3 | 1 | 3 | 14 |
| Project-A.R.I.E.S | 5 | 2 | 2 | 1 | 3 | 13 |
| KinKeeper | 3 | 2 | 2 | 1 | 3 | 11 |
| palimpsest | 3 | 1 | 2 | 1 | 4 | 11 |
| cooking-shopping-assistant | 3 | 2 | 3 | 1 | 2 | 11 |
| TripWeaver | 4 | 1 | 1 | 2 | 2 | 10 |
| astrotyper | 3 | 1 | 1 | 1 | 4 | 10 |

#### ✅ Answer: **AccessPilot** — with **chance-electro-capstone** as its domain twin

**AccessPilot is the only repository in the set that closes the whole Track 3 loop.** It perceives
(Playwright renders the page, axe-core scans it), decides (six specialist agents map findings to
source and plan a repair), **acts on a real system** (rewrites HTML/CSS/JSX/TSX/Vue/Svelte in an
isolated copy), **verifies its own work** (re-scans and compares against the original findings),
and then **stops at a human gate** before anything leaves the machine. Everything else in the set
either stops before acting, or acts without verifying.

Three details make the gate worth copying rather than admiring:

1. **The approval is bound to the artefact, not to the session.** From `app/run_manager.py`:
   ```python
   async def approve(self, run_id: str, approval: ApprovalRequest) -> RunSnapshot:
       ...
       raise ValueError("Run is not waiting for approval")
       ... approval.expected_diff_sha256
   ```
   You approve *this exact diff*, against *this verification result*, at *this git HEAD*. If the
   diff moves after you looked at it, your approval is void. Almost every "human-in-the-loop"
   demo approves a *step*; this one approves a *state*. That distinction is the whole ballgame
   when the action is a refund.

2. **Dangerous capability is off by policy, not off by prompt.** `ACCESSPILOT_ENABLE_REMOTE_MUTATIONS`
   and `ACCESSPILOT_ENABLE_LOCAL_EXECUTION` default to false *at the server*, and a run must
   additionally opt in, *and* a reviewer must approve. Three independent locks, none of which is
   the model's judgement.

3. **The safety layer is boring on purpose.** `app/services/safety.py` is an allow-list of 25
   executables, a protected-path set (`.git`, `.env`, `.ssh`, `id_rsa`, `credentials.json`), and
   four regexes that redact bearer tokens, JWTs and any 40-character blob out of every log line.
   No LLM is asked whether a path is safe.

**The disqualifier:** AccessPilot's domain is web accessibility. It has nothing to do with sales
or customer service. So it is the **architectural** answer, not the submission.

**chance-electro-capstone is the domain answer.** It is the only repository in the twelve that
automates a *commercial* workflow end to end — a photo of a hand-drawn site plan becomes a priced
proposal, a contract, an invoice, a shop order and a GO/NO-GO margin verdict. That is quote-to-cash.
That is a sales workflow. And it is **in production at a real electrical contractor**, live at
`electro.team247.online`, with money on the line per job.

It is also the best *multi-agent* engineering in the set:

- **Real A2A**, not a function call dressed up as a protocol — three independent HTTP servers on
  ports 8001–8003, discovered via `A2ACardResolver`, with agents 2 and 3 fanning out in parallel.
- **Every rupee comes from the MCP server.** All three agents are MCP *clients*; none imports the
  pricing engine. That is why the proposal and the margin verdict can never disagree — a class of
  bug most quoting tools ship with.
- **Economics are deterministic.** `catalog.py::compute_economics` has no LLM in it, so GO/NO-GO is
  reproducible and the sandbox sliders recompute instantly. The LLM reads the napkin; arithmetic
  decides the verdict.
- **Guardrails at five named choke points**, each wired to exactly one place, each rejection signed
  `[guardrail]` and appended to an `AUDIT` trail so a refusal survives A2A's error wrapping and
  surfaces as a clean 400 instead of a 500.

Its weakness is precisely AccessPilot's strength: **it has no escalation boundary.** Grep for
`escalat|hitl|approval` across its Python returns zero. Its only human touchpoint is a gap-filling
quiz when the analyst cannot read the drawing — a *completeness* loop, not a *risk* loop. It never
asks "am I confident enough to be trusted with this?"

#### What this means for the submission

> **Take AccessPilot's loop. Put chance-electro's business shape on it. Add the calibrated
> escalation neither of them has — because that is the part you already own.**

This is the same conclusion §6 of the track analysis reached from your own portfolio, arrived at
independently from twelve strangers' code. Every repository here that escalates, escalates on a
constant someone typed. MemoryBridge rejects on a keyword list. CritqAI's validator counts 18
banned phrases and question marks. AccessPilot — the best of them — gates on *risk level as a
label*, not a score. **Not one of the twelve reports a calibration metric.** Your
`nse-guardrail` tri-state router and `Failure-Aware-Search-Agents`' measured ECE remain unmatched
in this sample, which is a twelve-repo confirmation of the thesis the deck is built on.

#### Runners-up worth stealing from

| Take this | From | Why |
|---|---|---|
| **Authorization before the model** | [ReviewOps-Agent](https://github.com/mkiselyow/ReviewOps-Agent) | RBAC, consent and PII minimisation run in TypeScript *before* the Python agent is ever called (`src/server/auth/rbac.ts`, `permissions.ts`). "The LLM is never the authorization boundary." For a payments company this is the single most important sentence in all twelve repos. |
| **Two-stage gate: deterministic, then semantic** | [memorybridge](https://github.com/CryptonV8/memorybridge) | An algorithmic keyword check rejects prohibited routines *before* the Semantic Safety Reviewer runs. Cheap filter first, expensive judgement second — exactly your student/teacher split, at a smaller scale. |
| **Skills with negative triggers** | [memorybridge](https://github.com/CryptonV8/memorybridge) | `caregiver-escalation/SKILL.md` declares **Positive Triggers**, **Negative Triggers** ("Call 911", "Email the doctor") and **Prohibited Behavior**. Most skill files say what to do. Saying what *not* to do is what makes a skill testable. |
| **Deterministic validator over LLM-judge** | [CritqAI](https://github.com/francisnguyenanh/CritqAI) | "No AI call is made to validate an AI output." Removes 1–3 API calls per round and makes the quality gate auditable. |
| **Selection-bias control** | [trajectory-auditor](https://github.com/ShayIsso/trajectory-auditor) | The analyst only *points* at evidence; code extracts the window verbatim. Judges never see the analyst's narrative. Port this to citations in support answers and a grounding claim becomes mechanically true. |
| **Injection resistance proven by fixture** | [trajectory-auditor](https://github.com/ShayIsso/trajectory-auditor) | Twin 120-step logs differing in one planted step. Injected scores `[2,3,2,5,5,5,5]` with the attack flagged; control `[3,3,2,5,5,5,5]`. Zero dimensions inflated. That is a *test*, not a claim — build the refund equivalent. |
| **Per-span confidence in the UI** | [palimpsest](https://github.com/carlosapsa/palimpsest) | Won 1st of 6,041 teams partly on this. Uncertainty highlighted *inside* the output, not appended as a disclaimer. Your confidence score deserves the same treatment. |
| **Retry with exponential backoff + quality gate** | [Project-A.R.I.E.S](https://github.com/N-Garai/Project-A.R.I.E.S) | Reflector evaluates output quality; confidence below threshold → retry up to 3 → fallback → escalate. The closest thing in the set to your tri-state router. |
| **LoopAgent reconciliation** | [TripWeaver](https://github.com/VenuAIAgenticDev/TripWeaver) | `check conflicts → adjust → re-check`, `max_iterations=3`, early exit via an `exit_loop` tool. Ninety lines. Your refund/settlement reconciliation is the same shape. |
| **LLM-as-judge eval harness** | [astrotyper](https://github.com/eugeneh101/astrotyper) | 3rd place of ~6,000. Offline suite grading the model against *negative* constraints — never break character, never hallucinate a mechanic. Your negative constraint is "never promise a refund that policy does not allow." |
| **Conditional branch via callback** | [TripWeaver](https://github.com/VenuAIAgenticDev/TripWeaver) | `before_agent_callback` inspects state and skips a whole agent when it is unnecessary. Cheapest possible way to not pay for a step you do not need. |

### 0.3 Question 2 — which suits Svayom.ai best?

Different question, so different axes. Svayom is not looking for a track; it is looking for the
next rung. Scored on: **architectural fit** with Svayom's actual stack (Next.js 14 app + Python
gateway, self-hosted, multi-model, Clerk + Firestore), **whether it fills a gap Svayom's own README
already admits**, **adoption cost**, and **engineering-culture match**.

First, what Svayom is — read at source, 15,647 own lines across 133 files:

- `app/src/lib/router.ts` — a **capability router** that inspects every turn and selects tools by
  regex rule *plus shape gates* (`isDefinitional`, settled-history detection) that short-circuit
  retrieval however many trigger words a message contains. Every match carries the reason it fired.
  Routing costs zero extra model round-trips.
- 17 API routes, 14 dashboard surfaces, `src/svayom/` inference gateway + `src/svayom_modelops/`
  (mirror, verify, preflight, registry, serving).
- `ratelimit.ts` token buckets on 5 routes + a weekly token budget that binds.
- `selfcheck.ts` — writes, reads back, deletes, and reports the real error. Built because "a graph
  with no nodes and a training page reading zero look identical whether nothing has been said worth
  saving or every write is failing."
- Prompt-injection defence by **structure**: retrieved pages ride in their own lower-trust user
  message inside a per-turn nonce fence, with homoglyph/RTL/zero-width disguises folded — and
  folding only fires inside a word that already mixes scripts, so Russian and Japanese pass through.
- SSRF guard covering 16 spellings of loopback, refused in <5 ms without opening a socket.
- 855 vendored skills, 138 verify checks, SFT/DPO corpus export from 👍/👎/rewrite.

And what Svayom's README says it is **not**, in its own words:

> *"the graph is a view of your history, not retrieval. It is never fed back into the prompt."*
> *"The app collects and exports. It does not train."*
> *"the next rung is not trusting output for consequential actions."*

Three named, open gaps. The right repository for Svayom is the one that closes one.

| Repository | Arch fit | Fills a stated gap | Adoption cost | Culture match | Σ |
|---|:-:|:-:|:-:|:-:|:-:|
| **trajectory-auditor** | 4 | **5** | **5** | **5** | **19** |
| ReviewOps-Agent | **5** | 4 | 3 | 4 | 16 |
| accesspilot | 4 | **5** | 2 | **5** | 16 |
| memorybridge | 4 | 2 | 3 | 4 | 13 |
| CritqAI | 3 | 2 | 3 | 4 | 12 |
| Project-A.R.I.E.S | 2 | 2 | 2 | 3 | 9 |
| others | ≤3 | ≤2 | — | — | ≤9 |

#### ✅ Answer: **trajectory-auditor** — then **ReviewOps-Agent**, then **AccessPilot**

**trajectory-auditor closes the loop Svayom already built 80% of.**

Svayom collects every 👍, 👎 and rewrite into `sft.jsonl` and `dpo.jsonl`, then stops — because,
as the README says honestly, training belongs on a GPU and you cannot fine-tune Kimi-K3 or
DeepSeek-V4-Pro anyway. So the corpus sits there waiting for a LoRA run that needs hardware,
hours and an 8B model.

trajectory-auditor offers the **other** path from the same data: read the session, grade the
trajectory on 7 dimensions with evidence-quoted judges, and synthesise the lesson into an
**installable `SKILL.md`** — shipped with 3 eval cases and 4 failure-mode self-checks, installed
dual-target into `.claude/skills/` and `.agents/skills/`, behind a permission-expansion gate that
logs every decision to `artifacts/gate_decisions.jsonl`.

Svayom already loads 855 skills through `router.ts`. **A skill is a weight update that needs no
GPU.** trajectory-auditor is the missing middle between Svayom's feedback capture and Svayom's
skill injection — and it is the cheapest possible answer to "the app does not train."

The culture match is close to exact. Both codebases:

- prefer a deterministic check to an LLM judgement wherever one exists (Svayom: rules-based entity
  extraction, "spending a model round-trip per turn to find proper nouns is not a trade worth
  making"; TA: `salience.py`, a no-LLM scanner that warns when a failure signal went uncovered);
- refuse to let narrative stand in for evidence (Svayom: "a cited source is one that was genuinely
  retrieved during that turn"; TA: the analyst points, `windows.py` extracts verbatim);
- prove a security property with a fixture rather than asserting it (Svayom: 16 loopback spellings
  refused; TA: twin 120-step logs, zero dimensions inflated by the planted injection);
- are token-honest (Svayom reports exact token counts under every answer; TA measured naive 7-way
  fan-out at ≈1M tokens/audit and compacted it down).

It even carries the confession Svayom's README style would have written itself: *"during this
project's own build, generated fixtures leaked a real email 42 times past green unit tests — exactly
the artifact-drift failure class this tool detects (now enforced by `tests/unit/test_fixture_hygiene.py`)."*

**ReviewOps-Agent is Svayom's structural twin.** TypeScript Next.js front + Python agent service
over REST is Svayom's `app/` + `src/` split exactly. If Svayom is ever sold into a company rather
than run by one person, ReviewOps has already solved the shape of that problem: RBAC and consent
enforced in TypeScript before the Python service is called, a mock HRIS connector behind a
`contracts.ts` seam, an outbox that stands in for Slack/email with a 12-hour no-double-nudge
window, and 18 test files holding it. Take `auth/rbac.ts` and `connectors/contracts.ts` as the
pattern for Svayom multi-tenant.

**AccessPilot is the third rung, and the one Svayom's README explicitly points at.** "The next rung
is not trusting output for consequential actions" — AccessPilot is 11,395 lines of exactly that
rung, done properly: an approval bound to a diff hash, capability disabled by server policy, and a
safety module that never asks a model whether a path is dangerous. Adopt it when Svayom grows an
action layer, not before.

**Not recommended for Svayom:** Project-A.R.I.E.S (excellent work, but 124 tools and a NASA domain
is a different product); palimpsest, astrotyper, KinKeeper, cooking-shopping-assistant, TripWeaver
(single-purpose applications — read them for patterns, do not integrate them).

### 0.4 What reading Svayom changes for the hackathon

§11 of the track analysis asked what was in `Svayom/Svayom`, and warned that reading
`nse-guardrail` had reordered the analysis once already. Reading Svayom does not reorder the
recommendation — **it removes the largest risk attached to it.**

§6 stated the risk plainly: the whole submission leans on `nse-guardrail`, which is marked
internal-testing-only and was built under an NSE/BITS internship. If permission does not come
through, the pitch loses its spine.

Svayom is the answer to that. It is a **licence-clean, already-shipped, self-hosted substrate**
that supplies most of what nse-guardrail was supplying *around* the risk model:

| Needed for the teammate | nse-guardrail | **Svayom (clean)** |
|---|---|---|
| Multi-model gateway with metering | via NSE Ollama | ✅ `src/svayom/` + `svayom_modelops/`, OpenAI-compatible |
| Per-turn guardrails | ✅ | ✅ on every turn, structural injection fence + SSRF |
| Spend control | ✅ | ✅ token buckets on 5 routes + a weekly budget that binds |
| Human console / queue UI | ✅ 35-file Next.js | ✅ Next 14, Clerk, 14 dashboard surfaces, PWA + Android TWA |
| Skill injection | — | ✅ 855 skills, routed per turn with a stated reason |
| Feedback → corpus | — | ✅ SFT + DPO export, 👍/👎/rewrite |
| Storage that refuses to lose data quietly | — | ✅ Firestore/disk/ephemeral, declared and surfaced |
| **Calibrated risk routing** | ✅ **the unique part** | ❌ — this is what you port |
| Verification harness | 405 tests | ✅ 138 checks, `SKIP` ≠ pass, 404 ≠ auth |

**Read that table as the build plan.** Everything except one row already exists in a repository you
own outright. The one row that does not — the calibrated tri-state router — is precisely the row
that is your differentiation, and §9 already budgeted it as the largest piece of new work.

So the honest revision to §11, question 2: **if NSE permission is uncertain, build the teammate on
Svayom and port only the *methodology* of the risk router** — the tri-state shape, the threshold
trade-off discipline, the teacher/student split. Architecture and authorship are yours to describe
whatever the code permission turns out to be.

One caution, for accuracy rather than modesty: Svayom's `router.ts` is a *capability* router —
regex rules and shape gates choosing tools. It is not a *risk* router and does not produce a
calibrated score. Do not let the two get conflated on a slide. The capability router is the
scaffold you hang the risk model on; it is not the risk model.

---
---

# Part 1 — The deck

Seven slides, in the order the brief asks for.

---

## 📌 Slide 1 — Title

<div align="center">

# Nirnay

### The support teammate that knows when to stop

**Paytm AI Hackathon · Track 3 — Autonomous AI Teammates**

*An autonomous customer-resolution teammate whose escalation decision is
**measured**, not hardcoded.*

**Karthik Janardhan** · [@karthikj30](https://github.com/karthikj30) · karthikjanardhan5@gmail.com

</div>

> **The line to open with:**
> *"Every team here will show you an agent that escalates. I am going to show you one that can
> tell you how often it is right when it doesn't."*

---

## 📌 Slide 2 — Problem Statement

### Support automation is stuck at 30%, and the reason is not the model

An Indian payments platform handles disputes at a scale where the arithmetic is brutal: a stuck
UPI transfer, a failed settlement, a chargeback, a KYC block. Today's split is roughly:

- **~30%** fully automated — FAQ deflection, status lookups, canned replies
- **~70%** routed to a human, because nobody can prove the bot should have handled it

The bottleneck is **not** the model's ability to resolve the case. It is that **nobody can bound
the cost of being wrong**, so the safe default is "escalate." That default is expensive in three
directions at once — agent cost per ticket, customer wait time, and the trust lost when a bot
tries anyway and gets it wrong on somebody's money.

### Why the current answer doesn't scale

Every serious agent — including all twelve open-source systems audited in §0 and every public
Paytm-hackathon entrant surveyed in §7 of the track analysis — draws its escalation boundary the
same way:

```python
if amount > 5000 or sentiment == "angry" or confidence < 0.7:
    escalate()
```

Three numbers somebody chose in a meeting. They are not wrong — they are **unmeasurable**. Nobody
can answer:

- When the agent says it is 80% sure, **is it right 80% of the time?**
- What did we pay, in wrongly-escalated tickets, for the last threshold change?
- Which of these three conditions is actually carrying the decision?

**Uncalibrated confidence is the real bug.** The literature is unambiguous: verbalised LLM
confidence is systematically over-confident ([MiaoXiong2320/llm-uncertainty](https://github.com/MiaoXiong2320/llm-uncertainty),
ICLR 2024). An agent that says "I'm confident" and is wrong a third of the time is more dangerous
than one that never speaks — because you have built a process around believing it.

### The consequence

You cannot safely raise autonomy past 30%, because raising it means moving a number you cannot
defend. So the teammate stays a deflection bot, the queue stays full, and the 70% stays human.

> **Track 3 asks for "escalating to humans only when needed."**
> Nobody in the field can currently define *needed*. That is the problem worth solving.

---

## 📌 Slide 3 — Proposed Solution

### Nirnay: a teammate whose escalation policy is a measured artefact

Four decisions a resolution can take, not two:

| Decision | Condition | What happens |
|---|---|---|
| 🟢 **ACT** | calibrated confidence ≥ high | Executes the resolution, logs it, notifies the customer, records the outcome |
| 🟡 **HEDGE** | mid band | Acts, **states its uncertainty in the reply**, and attaches a one-click undo |
| 🔴 **ESCALATE** | below threshold | Hands a **structured packet** to a human — not a transcript. Findings, evidence, the action it *would* have taken, and why it stopped |
| ⛔ **REFUSE** | adversarial / policy-violating | Blocked pre-LLM in <200 ms, logged to the audit trail |

The middle two rows are the product. Everyone ships the first and the third.

### The pipeline

```
Customer message  (text · voice · Indic)
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│ ① AUTHORIZE — TypeScript, before any model call                  │
│    identity · entitlement · consent · PII minimisation           │
│    ← pattern from ReviewOps-Agent: the LLM is never the          │
│      authorization boundary                                      │
├─────────────────────────────────────────────────────────────────┤
│ ② INTERCEPT  (<200 ms, no LLM)                                   │
│    rules → XGBoost → SVDD/EIF → ModernBERT → risk score          │
│    >0.80 hard-block · <0.25 pass · middle → teacher adjudication │
│    ← nse-guardrail tri-state router (methodology; see §0.4)      │
│    ← Svayom: SSRF guard, nonce-fenced injection defence          │
├─────────────────────────────────────────────────────────────────┤
│ ③ GROUND — cyclic LangGraph                                      │
│    plan → retrieve → rerank_and_grade → generate                 │
│    ↺ transform_query when retrieval is weak                      │
│    over policy docs · txn history · merchant profile             │
│    ← RAG-with-LangGraph-Guardrails-LLM-Gateway                   │
├─────────────────────────────────────────────────────────────────┤
│ ④ CALIBRATE  ★ the differentiator                                │
│    0.45·retrieval + 0.30·source_trust + 0.25·verification        │
│    post-trained with DPO for calibration, reported as ECE        │
│    ← Failure-Aware-Search-Agents                                 │
│         ↓ ACT      ↓ HEDGE      ↓ ESCALATE                       │
├─────────────────────────────────────────────────────────────────┤
│ ⑤ ACT — every money-moving tool behind a bound gate              │
│    approval pinned to the exact payload hash + evidence set      │
│    one-click revert on every completed action                    │
│    ← AccessPilot approval model · NSEGPT confidence_gate pattern │
├─────────────────────────────────────────────────────────────────┤
│ ⑥ GUARD OUTPUT — groundedness + PII, before the customer sees it │
├─────────────────────────────────────────────────────────────────┤
│ ⑦ OBSERVE — LiteLLM → Prometheus → Grafana                       │
│    cost/resolution · latency · tokens · ECE · deflection rate    │
│    ← NSE_Observability · Svayom token buckets + weekly budget    │
└─────────────────────────────────────────────────────────────────┘
```

### The one slide that wins the room

A **reliability diagram**: predicted confidence on x, observed resolution accuracy on y, the
diagonal drawn in. Plus the operating point, chosen and defended:

```python
ALLOW_THRESHOLD = 0.25   # lowered from 0.35 — catches 19 more attacks,
                         # cost = 1 extra safe case sent to the teacher
```

*A real comment, from `src/pipeline/interceptor.py`, running in front of the National Stock
Exchange of India's internal LLM.* It is a precision/recall trade-off, quantified, decided, and
recorded **at the decision site**. Competitors will assert their agent escalates appropriately.
You can show what your threshold cost.

### Scope, stated honestly before a judge asks

- Backing systems are **mocked** — refund, settlement lookup, txn status, ticket CRUD. Every
  entrant in this track does the same; say so first and it stops being a weakness.
- The demo dataset is **synthetic but adversarial by construction**: 30–50 conversations spanning
  clear-cut, genuinely ambiguous, and hostile. **Without ambiguous cases an ECE means nothing** —
  this is the part to build first, not last.
- The output guard is wired from the RAG gateway, not written fresh.

---

## 📌 Slide 4 — Technology / Tech Stack

| Layer | Technology | Origin |
|---|---|---|
| **Client** | Next.js 14 · React · Clerk auth · PWA + Android TWA | **Svayom** — shipped |
| **Agent runtime** | Python 3.12 · LangGraph (cyclic, self-correcting) · FastAPI | RAG Gateway |
| **Model access** | LiteLLM gateway · OpenAI-compatible · self-hosted + hosted, swappable | **Svayom** `src/svayom/` |
| **Models** | Gemini / Groq for reasoning · ModernBERT + XGBoost + SVDD/EIF for risk · Sarvam or IndicTrans for Indic voice | mixed |
| **Retrieval** | pgvector · hybrid search · rerank + grade · RAGAS evals | Enterprise-Advanced-RAG |
| **Risk model** | Two-stage teacher/student, QLoRA-distilled, tri-state router | nse-guardrail *(methodology)* |
| **Calibration** | DPO post-training · Expected Calibration Error · reliability diagrams | Failure-Aware-Search-Agents |
| **Tools / interop** | **MCP** for every business tool · **A2A** for cross-agent handoff | pattern: chance-electro |
| **Guardrails** | Structural injection fence (per-turn nonce) · SSRF guard (16 loopback spellings) · PII redaction · allow-listed executables | **Svayom** + AccessPilot |
| **Approval** | Payload-hash-bound approval · resumable run state · one-click revert | AccessPilot + NSEGPT pattern |
| **Persistence** | Postgres / Firestore · immutable audit events · storage mode declared, never silent | **Svayom** `storage.ts` + MemoryBridge |
| **Observability** | Prometheus · Grafana · per-request cost/latency/token metering | NSE_Observability |
| **Evals** | Offline LLM-as-judge on *negative* constraints · deterministic salience scan · twin-fixture injection tests | astrotyper + trajectory-auditor |
| **Deploy** | Docker · Cloud Run / Vercel + Render · Terraform skeleton | Svayom `deploy/` + RAG Gateway IaC |

**Three notes a technical judge will care about:**

1. **MCP for every business tool, without exception.** chance-electro proves the payoff: because
   all three agents are MCP clients and none imports the pricing engine, the quote and the margin
   verdict *cannot* disagree. Apply the same rule and the reply to the customer and the ledger
   entry cannot disagree.
2. **Two model classes, two jobs.** Small deterministic models do the risk scoring in <200 ms with
   no LLM in the path. The LLM only ever drafts and reasons. Anything touching money is decided by
   arithmetic — chance-electro's `compute_economics`, MemoryBridge's pre-semantic keyword gate, and
   CritqAI's zero-token validator all independently arrived at this.
3. **Self-hostable end to end.** Svayom already runs its own gateway. For a payments company with
   data-residency constraints that is a differentiator, not a footnote — and it is a slide either way.

---

## 📌 Slide 5 — USP

### One sentence

> **Every agent escalates. Ours is the only one that can tell you how often it's right when it
> doesn't — and what the last threshold change cost.**

### Four claims, each backed by an artefact

| # | Claim | The artefact |
|:-:|---|---|
| **1** | **The escalation policy is trained, not typed.** DPO post-training produces a *calibrated* confidence signal, reported as Expected Calibration Error. | A reliability diagram. Nobody else in this hackathon will have one. |
| **2** | **This architecture already runs in front of a stock exchange.** Two-stage guardrail, tri-state routing, <200 ms, 405 passing tests, SEBI/OWASP grounded, live HITL admin queue. | Not a prototype of a concept — a port of a system. |
| **3** | **The threshold trade-off is recorded at the decision site.** `# lowered from 0.35 — catches 19 more attacks, cost = 1 extra safe to teacher` | One line of source that beats most teams' entire architecture diagram. |
| **4** | **The substrate is shipped and licence-clean.** Svayom: 15,647 lines, self-hosted gateway, 855 routed skills, 138 verify checks, per-turn guardrails, token budgets that bind. | Not a weekend scaffold. A product with a release history. |

### Why this is genuinely hard to copy

- **Twelve independently-built public agent systems were audited** (§0). Every one that escalates,
  escalates on a constant. Not one reports a calibration metric.
- **Every public Paytm-hackathon entrant surveyed** (§7) hardcodes the boundary. `PaytmResolveAI`
  states it as a virtue: *"a deterministic policy engine, never the LLM, decides anything touching
  money."* That is correct and it is also the ceiling — a deterministic engine cannot tell you its
  own error rate.
- Calibration is **months of work**, not a weekend of prompting. It needs a post-training loop, an
  adversarial eval set, and the discipline to publish a metric that can embarrass you.

### The thing not to do

Do not open with a generic support bot. **The entire differentiation lives in the cases where the
agent declines to act.** If the demo is a happy path, every judge sees a chatbot and you lose to
teams with better domain modelling. Demo the refusal. Demo the hedge. Demo the undo.

---

## 📌 Slide 6 — Impact & Benefits

### The mechanism, stated plainly

Calibration does not make the agent smarter. It makes the *threshold* movable. Once you can prove
what a threshold costs, you can move it — and every point of autonomy past 30% is a point nobody
could previously justify buying.

### For the business

| Metric | Today | With Nirnay | Why it moves |
|---|---|---|---|
| Automated resolution | ~30% | **55–65%** | Cases the bot *can* handle stop being escalated "just in case" |
| Escalation precision | unmeasured | **reported, with a curve** | The reliability diagram is the instrument |
| Cost per resolution | ~₹40–60 (human) | **~₹3–6 (autonomous path)** | Per-request metering, live on the Grafana dashboard |
| First-response time | minutes–hours | **<5 seconds** | Interception + grounding run in one pass |
| Wrongly-automated cases | unbounded | **bounded and measured** | The number the hedge band exists to hold down |

*(Directional figures — state them as the model, not as measurements, and show the arithmetic.)*

### For the human agents

The point is **not** headcount. It is that the 70% a human sees becomes the 70% that genuinely
needs a human — and each one arrives as a **structured packet**, not a transcript to read from
scratch: findings, evidence, the action the agent would have taken, and the reason it stopped.
Take the persona-portal idea from [aws-samples/sample-agentic-insurance-claims-processing-eks](https://github.com/aws-samples/sample-agentic-insurance-claims-processing-eks):
an Agent view and a Supervisor view, so a human can override or investigate without leaving the tool.

### For the customer

- Answers in seconds for the clear cases
- **Honest uncertainty** on the ambiguous ones, with an undo attached — the palimpsest lesson:
  uncertainty belongs *inside* the output, highlighted, not appended as a disclaimer
- A human for the hard ones, who already has the context

### For risk and compliance

- Every decision carries an immutable audit event — the MemoryBridge and chance-electro `AUDIT`
  pattern, extended to money
- Every refusal is signed, logged, and surfaced as a clean 4xx rather than a silent failure
- Every money-moving action is approved against a **payload hash**, so an approval cannot drift
  onto a different action than the one a human read
- SEBI/OWASP grounding is already in the risk model's lineage

### The measurement apparatus already exists

This is the part most teams cannot claim. `expected_calibration_error`, `hallucination_rate`,
`research_rate`, `_find_threshold.py`, `_honest_eval.py`, `calibrate_boosts.py`, RAGAS evals,
Prometheus/Grafana, per-request cost metering, and Svayom's 138 verify checks that report a
skipped section as `SKIP` rather than counting it as passed. **Most teams will demo a happy path.
Demo a deflection-rate-vs-escalation-precision curve and defend the operating point.**

---

## 📌 Slide 7 — Business Model

### The wedge

Do not sell a chatbot. **Sell the confidence layer that makes someone else's chatbot safe to turn
up.** Every enterprise that has deployed support automation is stuck at the same ceiling for the
same reason, and they have already paid for the bot.

### Three ways to sell it

**1 · Outcome-priced resolution (the primary model)**

Charge per *autonomously resolved* ticket — not per API call, not per seat. ₹8–15 against a
₹40–60 human cost. The customer pays only when the agent actually closed the case, which makes
the pricing model and the calibration story the *same* argument: we only bill when we were right
to act, and we can prove how often that is.

| Tier | Volume / month | Price | Includes |
|---|---|---|---|
| **Pilot** | ≤5,000 resolutions | Free, 60 days | Hosted, synthetic + your data, reliability report at the end |
| **Growth** | 5k–100k | ₹12 / resolution | Full pipeline, Grafana, HITL console, 2 channels |
| **Enterprise** | 100k+ | ₹6–8 / resolution + platform fee | Self-hosted or VPC, custom risk model, data residency, SLA |

**2 · Calibration-as-a-Service** — the durable one

The confidence layer is model-agnostic and bot-agnostic. Sell it *around* an incumbent: they keep
their agent, you supply the score, the tri-state router, the HITL queue and the reliability
reporting. Lands where the buyer has already spent and is stuck. Priced per scored decision.

**3 · Regulated on-prem licence** — the high-margin one

Banks, exchanges, insurers and PSPs cannot send dispute traffic to a hosted endpoint. Svayom is
already a self-hosted gateway and the risk model lineage is already on-prem. Annual licence +
deployment + a tuning retainer, because the threshold has to be re-tuned per customer — and the
retainer is not a bolt-on, it is the honest consequence of the product working the way it claims.

### Why the margin holds

The expensive path is the human one, and the product's whole job is to send fewer cases down it.
Inference for the autonomous path is single-digit rupees; the risk model is small, local, and
costs effectively nothing per call; the expensive LLM is only invoked after the cheap gate has
already said yes. Every architectural decision in Slide 4 is also a unit-economics decision.

### Go-to-market

1. **Land** on one narrow dispute type with clean policy documents — failed UPI transfers, or
   settlement queries. The narrower the domain, the better the calibration, and calibration is
   the demo.
2. **Prove** with a 60-day pilot whose deliverable is a **reliability report**, not a feature list.
   That report is the sales asset; no competitor can produce one.
3. **Expand** dispute type by dispute type. Each new type reuses the pipeline and needs only a
   labelled eval set — which the previous deployment has been generating in production all along.
4. **Moat** compounds: every resolved case is a labelled example, every escalation is a
   hard negative, and the calibration curve tightens. The second customer is cheaper than the first.

### The honest risks

| Risk | Response |
|---|---|
| Regulatory approval for autonomous money movement | Ship read-only and draft-only first. HEDGE band and the undo path exist precisely so ACT can be enabled per-action-type, gradually. |
| Enterprise sales cycles | The wedge (model 2) sells to a team that already has budget and an unsolved problem. Much shorter than replacing the bot. |
| Incumbents add calibration | They will. The lead is the adversarial eval set and the per-customer tuning discipline, not the idea. |
| NSE code reuse permission (§11, Q1) | **Unresolved — resolve it this week.** §0.4 shows the fallback: build on Svayom and port only the methodology. Architecture and authorship are yours regardless. |

---
---

# Part 2 — How to approach it

### The order that matters

Most teams build the agent, then bolt on evaluation. **Do the opposite.** The eval set *is* the
product here; without ambiguous cases, the ECE is a decoration.

**Day 1 — the dataset, before any agent code**
30–50 support conversations, deliberately in three groups: clearly resolvable, genuinely
ambiguous, and adversarial. Label each with the correct decision (ACT / HEDGE / ESCALATE / REFUSE).
**The ambiguous group is the whole project.** If you skip this day, nothing downstream means anything.

**Day 2 — the skeleton, end to end, dumb**
Wire authorize → intercept → ground → decide → act → guard → observe with a *constant* threshold.
Get one refund case running end to end. Ugly is fine. This is the harness the calibration plugs into.

**Day 3 — the risk model, retargeted**
This is the largest piece of new work, as §9 warned. nse-guardrail scores *prompt-injection and
policy-violation* risk; you need *resolution confidence*. The tri-state shape, the teacher/student
split and the threshold methodology all transfer. The labels and the training corpus do not.

**Day 4 — calibrate and plot**
DPO or temperature scaling, then the reliability diagram against Day 1's labels. **Pick your
operating point and write the comment explaining what it cost** — in the source, at the decision
site, the way `interceptor.py` does. That comment is a slide.

**Day 5 — the console and the demo**
The escalation inbox, Agent view and Supervisor view. Rehearse the demo **backwards from the
refusal**: show the agent declining first, then hedging with an undo, then acting. Happy path last,
if at all.

### Seven concrete things to lift, with file paths

| # | What | From | Where exactly |
|:-:|---|---|---|
| 1 | Approval bound to a payload hash, resumable | accesspilot | `app/run_manager.py::approve`, `expected_diff_sha256` |
| 2 | Capability off by server policy, then by run, then by reviewer | accesspilot | `ACCESSPILOT_ENABLE_REMOTE_MUTATIONS` |
| 3 | Allow-listed executables + protected paths + log redaction | accesspilot | `app/services/safety.py` |
| 4 | Authorization in TS before the Python agent is called | ReviewOps-Agent | `src/server/auth/rbac.ts`, `permissions.ts` |
| 5 | Deterministic gate *before* the semantic gate | memorybridge | pre-reviewer keyword rejection |
| 6 | Skills with **negative** triggers and prohibited behaviour | memorybridge | `.agent/skills/caregiver-escalation/SKILL.md` |
| 7 | Evidence extracted by code, never by the model's narrative | trajectory-auditor | `app/trajectory/windows.py`, `salience.py` |

### Five things not to do

1. **Do not rebuild the RAG stack.** Import it.
2. **Do not vendor AGPL Odysseus code.** Re-implement the confidence-gate *pattern* — it is ~200 lines.
3. **Do not repeat nse-guardrail's README claims** about the output guard or the active-learning
   loop. `output_guard/scanner.py` is 8 lines; `active_learning/` is three placeholder classes.
   Say *"input-side guarding, with the output path designed but not built"* and you are unassailable.
4. **Do not conflate Svayom's capability router with a risk router.** One picks tools by regex;
   the other produces a calibrated score. A sharp judge will ask.
5. **Do not demo only happy paths.** Said three times in this document on purpose.

### Still open (from §11, plus one new)

1. **What are you permitted to reuse from `nse-guardrail`?** Code, architecture, and "I built this"
   are three different permissions. Load-bearing — resolve it first. §0.4 is the fallback plan.
2. **Team size and time?** The plan above is ~2 people for a week *given* that you import your
   existing stack. From scratch it is not achievable.
3. **Hosted models, or on-prem required?** Either way it is a slide; Svayom makes on-prem real.
4. **Any real or realistic support-ticket data?** The calibration story needs ambiguous cases.
5. **NEW — will you run the teammate on Svayom's gateway or stand up a new one?** §0.4 argues for
   Svayom: shipped, licence-clean, already metered and guarded. Decide before Day 2, because it
   determines what Day 2 wires together.

---

# Part 3 — References

### The twelve audited (§0)

| Repository | Track-3 Σ | Read it for |
|---|:-:|---|
| [joinarun/accesspilot](https://github.com/joinarun/accesspilot) | **21** | The complete autonomous loop with a real human gate |
| [barmanoff/chance-electro-capstone](https://github.com/barmanoff/chance-electro-capstone) | **19** | A2A + MCP done properly; a commercial workflow in production |
| [mkiselyow/ReviewOps-Agent](https://github.com/mkiselyow/ReviewOps-Agent) | 16 | Authorization before the model; TS app + Python agent service |
| [ShayIsso/trajectory-auditor](https://github.com/ShayIsso/trajectory-auditor) | 16 | Selection-bias control; injection resistance proven by fixture |
| [CryptonV8/memorybridge](https://github.com/CryptonV8/memorybridge) | 15 | Two-stage safety gate; skills with negative triggers |
| [francisnguyenanh/CritqAI](https://github.com/francisnguyenanh/CritqAI) | 14 | Deterministic, zero-token validation of LLM output |
| [N-Garai/Project-A.R.I.E.S](https://github.com/N-Garai/Project-A.R.I.E.S) | 13 | Plan→Reason→Route→Reflect with retry and quality gates |
| [gpshalini/KinKeeper](https://github.com/gpshalini/KinKeeper) | 11 | Local-first privacy; a security planning gate written before the code |
| [carlosapsa/palimpsest](https://github.com/carlosapsa/palimpsest) | 11 | 🏆 1st of 6,041 — per-span confidence surfaced in the UI |
| [crisstugui-png/cooking-shopping-assistant](https://github.com/crisstugui-png/cooking-shopping-assistant) | 11 | Session-sticky state machine; `RequestInput` HITL on injection |
| [VenuAIAgenticDev/TripWeaver](https://github.com/VenuAIAgenticDev/TripWeaver) | 10 | The cleanest small ADK reference: Sequential/Parallel/Loop + conditional skip |
| [eugeneh101/astrotyper](https://github.com/eugeneh101/astrotyper) | 10 | 🏆 3rd of ~6,000 — LLM-as-judge evals against *negative* constraints |

### Own assets referenced

[Svayom/Svayom](https://github.com/Svayom/Svayom) · `nse-guardrail` (private) ·
`Failure-Aware-Search-Agents` (private) · `RAG-with-LangGraph-Guardrails-LLM-Gateway` (private) ·
`NSE_Observability` · `Enterprise-Advanced-RAG` (private) · `NSEGPT` (private, AGPL fork —
see §4b) · [VendorConnect](https://github.com/karthikj30/VendorConnect) ·
[Karigar](https://github.com/karthikj30/Karigar)

### Human-in-the-loop primitives

- [LangGraph `interrupt()`](https://docs.langchain.com/oss/python/deepagents/human-in-the-loop) — pause mid-run, persist to a checkpointer, resume after a decision
- [OpenAI Agents SDK human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/) — tools declare `needs_approval` as a **per-call async predicate**; that predicate is where a calibrated score belongs
- [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) · [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) · [google/adk-python](https://github.com/google/adk-python) · [a2aproject/A2A](https://github.com/a2aproject/A2A)

### Escalation-aware service agents (the field)

- [huabeitech/agent-desk](https://github.com/huabeitech/agent-desk) — the closest public analogue; handoff via an *answerability evaluation*
- [thirilose-learn/autonomous-ai-customer-support-agent](https://github.com/thirilose-learn/autonomous-ai-customer-support-agent)
- [tanmoynit/autonomous-support-escalation-agent](https://github.com/tanmoynit/autonomous-support-escalation-agent)
- [Oninlovesjiujitsu/ai-automation-project](https://github.com/Oninlovesjiujitsu/ai-automation-project) — drafts, evaluates, auto-sends the safe ones, routes the risky to Slack
- [Paytm hackathon field (§7)](TRACK_SELECTION_ANALYSIS.md): [dubeyjiongit/PaytmResolveAI](https://github.com/dubeyjiongit/PaytmResolveAI) · [sparsh101sparsh/resolve-os](https://github.com/sparsh101sparsh/resolve-os) · [AmitNIET159/mitra-autonomous-ai](https://github.com/AmitNIET159/mitra-autonomous-ai)

### Calibration and abstention — the literature behind the moat

- [MiaoXiong2320/llm-uncertainty](https://github.com/MiaoXiong2320/llm-uncertainty) — ICLR 2024, *"Can LLMs Express Their Uncertainty?"*. **Verbalised confidence is systematically overconfident** — cite this as the argument for a trained alternative
- [yubol-bobo/awesome-llm-confidence](https://github.com/yubol-bobo/awesome-llm-confidence) — how confidence propagates across tools, steps and agents
- [SihengLi99/LLM-Honesty-Survey](https://github.com/SihengLi99/LLM-Honesty-Survey) — TMLR survey on known/unknown recognition and selective prediction
- [chenjux/abstention](https://github.com/chenjux/abstention) — uncertainty-based abstention
- [google-research/robustness_metrics](https://github.com/google-research/robustness_metrics) · [scikit-learn calibration](https://scikit-learn.org/stable/modules/calibration.html) — ECE and reliability-diagram implementations

### Financial-domain agent architecture

- [aws-samples/sample-agentic-insurance-claims-processing-eks](https://github.com/aws-samples/sample-agentic-insurance-claims-processing-eks) — LangGraph hub-and-spoke with **four persona portals**. Steal the persona-portal idea for the HITL console.
- [JeevanChevula/ClaimPilot](https://github.com/JeevanChevula/ClaimPilot)

### Evaluation harnesses

- [explodinggradients/ragas](https://github.com/explodinggradients/ragas) — retrieval + groundedness scoring
- [confident-ai/deepeval](https://github.com/confident-ai/deepeval) · [Arize-ai/phoenix](https://github.com/Arize-ai/phoenix) — LLM-as-judge and tracing
- [huggingface/trl](https://github.com/huggingface/trl) — the DPO implementation; Svayom's export already emits `dpo.jsonl` in its format

---

<div align="center">
<sub>

Companion to [`TRACK_SELECTION_ANALYSIS.md`](TRACK_SELECTION_ANALYSIS.md).
Twelve external repositories and `Svayom/Svayom` read at source level, 24 September 2026.
Line counts are own code, measured — `node_modules` and `.git` excluded.
Third-party projects are referenced under their own licences; no code is vendored here.

</sub>
</div>
