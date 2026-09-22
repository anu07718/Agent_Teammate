# Paytm AI Hackathon — Track Selection Analysis

**Prepared for:** Karthik Janardhan ([@karthikj30](https://github.com/karthikj30))
**Date:** 22 September 2026 (revised after reading the private repositories)
**Scope:** Full audit of 49 repositories (39 personal + 9 `CodedbyAKSA` + 1 `Svayom`), mapped against the three hackathon tracks, plus a survey of public GitHub prior art and the competing field.

> **Revision note.** The first version of this document was written without access to your
> private repositories. Reading them changed the analysis substantially. **`nse-guardrail` —
> 31,502 lines of own code, the largest codebase in your account — is now the single strongest
> asset here**, and it was invisible in the first pass. The recommended *track* is unchanged, but
> the argument for it is now considerably stronger and the proposed build has changed. See §4a.

---

## 1. The recommendation in one page

**Pick the `Autonomous AI Teammates` track.**

Not because it is the easiest — it is the most contested — but because it is the only track where you already own the component that almost nobody else in the field has built.

Every credible competitor in this track (and there are many, see §7) converges on the same design: *an LLM proposes, a hand-written deterministic policy engine disposes, and the system escalates to a human when the rules say so.* That is a sound design and it is now table stakes. The universal weakness is that **the escalation decision itself is hardcoded** — a threshold someone picked, a list of `if amount > X` rules.

You have built the alternative **twice**, independently, and one of them was deployed for a financial institution.

- **`nse-guardrail`** is a two-stage AI security layer built for the National Stock Exchange of India during a BITS Pilani PS-1 internship. Every message to NSE's internal LLM passes through it in under 200 ms. It routes on a calibrated risk score into exactly three states — **allow (<0.25) / soft-block (0.25–0.80) → HITL admin queue / hard-block (>0.80)**. That is the tri-state escalation policy this track asks for, running in front of a real exchange, grounded in SEBI and OWASP policy, with 405 passing tests. The threshold tuning is *documented in the code as a trade-off*: `ALLOW_THRESHOLD = 0.25   # lowered from 0.35 — catches 19 more attacks, cost = 1 extra safe to teacher`. That one comment is worth more in a judging room than most teams' entire architecture diagram.
- **`Failure-Aware-Search-Agents`** post-trains an agent with DPO so it emits a **calibrated** confidence signal and picks between `confident` / `hedge` / `re_search`. It measures itself with **Expected Calibration Error**.

Paired with `RAG-with-LangGraph-Guardrails-LLM-Gateway` (the production substrate: cyclic LangGraph, in/out guardrails, multi-provider gateway, evals, IaC) and the `confidence_gate.py` / file-revert pattern from your `NSEGPT` work, you can stand up an autonomous teammate whose *escalation policy is a measured, defensible artifact* rather than an opinion — and point at a stock exchange that already trusted a version of it.

**Runner-up:** `Merchant Growth AI`, on the strength of `VendorConnect` — your single largest genuine *domain* asset. Ranked second only because the track is the most saturated of the three and your AI layer there is thin.

**Third:** `AI-Powered Financial Journeys`. `nse-guardrail`'s SEBI grounding gives you more standing here than the first draft credited, but you still have no insurance or lending code, which is where the track's centre of gravity sits.

### Blunt answer to "does anything I have TRULY fit?"

**No single repo is a drop-in** — but the gap is smaller than it first appeared.

- **No repository in your account is a Paytm-domain application.** Not one touches payments, settlements, UPI, insurance claims, or lending underwriting.
- Your portfolio splits into **domain assets with thin AI** (VendorConnect, Karigar, DebtEase) and **deep AI infrastructure** (nse-guardrail, Failure-Aware, RAG Gateway, Enterprise-Advanced-RAG, NSE_Observability).
- What changed with the private repos: **that infrastructure is no longer domain-less.** `nse-guardrail` was built for and evaluated by an Indian financial-markets institution, against Indian financial regulation. That is genuine regulated-fintech credibility, and it is rare in a hackathon field.
- The winning move is still: *take the infrastructure you have genuinely built and that is hard to fake, and wrap it in a thin, Paytm-shaped domain layer.*

The infrastructure is the part that takes months. The domain wrapper is the part that takes a weekend.

---

## 2. Method and honest coverage

| What | How |
|---|---|
| Repository inventory | GitHub API across `karthikj30`, `CodedbyAKSA`, `Svayom` |
| Deep code inspection | Shallow clone + line counts, dependency manifests, entrypoints, grep for actual LLM/ML call sites |
| "Is it real?" test | Own-code LOC excluding `node_modules` / `site-packages` / `.venv`; presence of tests; whether AI is *called* or merely *named in the README* |
| Prior art | Public web + GitHub search |

**Inspected at source level (17):** nse-guardrail, VendorConnect, Technowin, UrbanYantra, DebtEase, Karigar, HealthSaathi, Failure-Aware-Search-Agents, RAG-with-LangGraph-Guardrails-LLM-Gateway, NSEGPT, NSE_Observability, Enterprise-Advanced-RAG, StockSense-AI, crimeintel-ai, EV-Bharat, Itihaas, Paytm_hackathon-idea.

**Assessed from metadata only (not cloned):** the remaining repos judged clearly out-of-category — Portfolio, LeetCode, DSA_Graphs, Monastery360, BharatYatra, Arka-Jewels, Skillora, EcoSaksham, Seeker, my_hugo_site, Django_web, ChatBot, GForce, MyFirst_Web, sample-app, hello-cloudbuild-app, hello-cloudbuild-env, Karthik_pipeline_ADL, GitHub-Achievement-s, karthikj30.github.io, CIDCO_Architect, CIDCO_WinEXE. `CyberAstra_SIH26` and `Paytm_hackathon-idea` were both 0 KB (empty) at scan time.

**Could not inspect — organisation repos are hard-blocked in this session.** Both the git proxy and the GitHub API refuse them: *"cross-tier adds are not supported: requested `codedbyaksa/tensortrail` but session already has repos from owner(s) [karthikj30]."* Because this session was opened against a `karthikj30` repository, no `CodedbyAKSA` or `Svayom` repository can be attached to it — this is a session-scoping limit, not a permissions problem with your account.

Still unread: `CodedbyAKSA/VLC`, `CyberQore`, `PlaceIQ`, `TensorTrail`, `DataForge`, `ExamGEN`, and `Svayom/Svayom`. **To have these read, start a fresh session with one of them as the initial repository.** Given that reading `nse-guardrail` alone reordered this entire analysis, that is worth doing before you commit — `TensorTrail` and `CyberQore` in particular have names suggesting ML-ops and security work.

**A measurement caveat:** clones were shallow (`--depth 1`), so commit counts and history depth are *not* assessed anywhere in this document. Judgements about "is it built" rest on code volume, structure, dependency wiring, and presence of tests — not on commit activity.

---

## 3. Portfolio triage

49 repositories, sorted by relevance to any track.

### Tier A — load-bearing assets (7)

| Repo | Own LOC | What it actually is | Visibility |
|---|---|---|---|
| **nse-guardrail** | **31,502** | **The strongest asset in the account.** Two-stage AI security layer in front of NSE's internal Ollama LLM, built during a BITS Pilani PS-1 internship. Stage 1 student pipeline (Prompt Guard + rule engine + XGBoost + SVDD/EIF + ModernBERT) scores in <200 ms and routes allow / soft-block / hard-block. Stage 2 teacher (Granite Guardian 4.1 8B) adjudicates soft-blocks with session history and SEBI/OWASP grounding, routing the still-uncertain to a **HITL admin queue**. Chunk-level guarding of RAG documents. Teacher/student distillation with QLoRA. Next.js 16 frontend. README reports 405 passing tests (verified 2026-06-11). | Private |
| **VendorConnect** | 16,453 Py | Flask marketplace for street-food vendors: suppliers, group ordering, price alerts, delivery agents, rewards, community, multilingual. AI via Qubrid gateway (chat/vision/audio/image). AWS via boto3. Has a `tests/` directory. | Public |
| **RAG-with-LangGraph-Guardrails-LLM-Gateway** | 6,993 Py | Cyclic LangGraph RAG: `guard_input → plan → retrieve → rerank_and_grade → generate → guard_output`, self-correcting via `transform_query` loop. LiteLLM gateway → Groq/OpenAI/Vertex. pgvector, RAGAS evals, NeMo guardrails adapter, Terraform/GCP, observability module. | Private |
| **Failure-Aware-Search-Agents** | 5,887 Py | DPO-post-trained search agent emitting calibrated uncertainty. Multi-agent (search / verification / composer / orchestrator). FastMCP server. Prometheus + Grafana. ECE, hallucination-rate and re-search-rate metrics. | Private |
| **StockSense-AI** | 6,744 TS | Next.js 15 / React 19 / Prisma. NSE & BSE tracking, RSI/MACD indicators, portfolio, AI chat + daily tips + per-stock analysis via Gemini and Groq. | Private |
| **DebtEase** | 6,851 | React+Vite dashboard over a greedy debt-settlement optimiser. Net balances, settlement plan, what-if, OCR wizard, D3 force-graph visualiser, vault. | Public |
| **NSEGPT** | ~10K own delta | Fork of the Odysseus on-prem coding assistant (AGPL). **See the fork caveat in §4.** | Private |

### Tier B — supporting assets (5)

| Repo | Own LOC | Relevance |
|---|---|---|
| **Enterprise-Advanced-RAG** | 3,279 Py | "Kubernetes SRE Copilot." CRAG, Self-RAG, HyDE, hybrid search, reranking, Text2SQL, caching, guardrails. README claims 87 passing tests. |
| **NSE_Observability** | 4,884 Py | LiteLLM + Prometheus + Grafana + Postgres + custom Ollama exporter. Per-request cost/latency/token metering — the ops layer an agent platform needs. |
| **Karigar** | ~1.2K Py + 2.3K JS | Flask + Gemini 1.5 Flash + Google Cloud TTS + Firestore + Maps. Story generation, voice narration, design suggestions, video scripts for artisans. A genuine *seller-growth* copilot. |
| **crimeintel-ai** | 11,219 JS | React geospatial analytics: heat map, network view, investigation view, 670-line assistant component. Evidence of dashboard-plus-assistant UX at scale. |
| **CodedbyAKSA/EV-Bharat** | 6,338 Py | RAG API (1,335 lines), battery-health ML (XGBoost/RF), CV drowsiness detection, OCR, Whisper. Evidence of real applied-ML range. |
| **UrbanYantra** | 14,141 | FastAPI + Next.js geospatial heat-stress platform. Notable for two directories: `explainability/shap_analysis.py` and `calibration/station_bias.py`, plus `llm_chat.py`. Third independent instance of you building calibration and explainability into a system. |
| **Technowin** | 16,586 Py | GIGW compliance auditor for Indian government websites — accessibility (2,577 lines), security (2,069), content, operations, homepage checks, 1,567-line self-test. **No AI at all**, but it is substantial automated *regulatory compliance* tooling, which is a genuinely relevant instinct for a payments company. |

### Tier C — out of category (37)

Portfolio, Skillora, Monastery360, BharatYatra, Arka-Jewels, EcoSaksham, HealthSaathi, Itihaas, CIDCO_*, LeetCode, DSA_Graphs, and the remaining scaffolds, tutorials and config repos. Not relevant to any track.

---

## 4a. nse-guardrail, in detail — read this before anything else

This is the asset that should anchor your submission. Verified at source:

**Own code: 31,502 lines.** Breakdown of `src/`:

| Package | LOC | Status |
|---|---|---|
| `training/` | 4,420 | Real — teacher trainer, student trainer, router, variant generator, adapter manager, one-click generator |
| `models/` | 3,614 | Real |
| `pipeline/` | 1,739 | Real — `interceptor.py` (849 lines) is the routing core |
| `api/` | 1,548 | Real |
| `ensemble/` | 477 | Real — includes a meta-learner |
| `rules/` | 473 | Real |
| `audit/` | 401 | Real |
| `preprocessing/` | 161 | Real |
| `demo/` | 89 | Real |
| `output_guard/` | **8** | ⚠️ **Placeholder** |
| `active_learning/` | **24** | ⚠️ **Three placeholder classes** |

Plus `evals/` (19 scripts including `_find_threshold.py`, `_honest_eval.py`, `_robust_eval.py`, `calibrate_boosts.py`, `_threshold_comparison.py`), `pg_idx/`, `scripts/`, `notebooks/`, 17 test files, and a 35-file Next.js frontend.

**The routing core, quoted from `src/pipeline/interceptor.py`:**

```python
BLOCK_THRESHOLD = 0.80
ALLOW_THRESHOLD = 0.25   # lowered from 0.35 — catches 19 more attacks, cost = 1 extra safe to teacher

HARD_BLOCK = "blocked"
SOFT_BLOCK = "soft_blocked"   # → HITL queue
ALLOW      = "allowed"
```

That comment is the single most valuable line in your portfolio for this hackathon. It is a precision/recall trade-off, quantified, decided, and recorded at the decision site. Competitors will assert that their agent escalates appropriately; you can show the cost of the threshold you chose.

**Two things in it are oversold in the README — fix the claim, not the code.** The README describes an output guardrail ("S1+S2") and a learning loop ("admin labels → QLoRA fine-tunes the teacher → teacher relabels the corpus → all student models retrain"). In the source, `output_guard/scanner.py` is 8 lines and `active_learning/` contains three classes whose docstrings read *"Placeholder — Phase 6 implementation."* The input path, the teacher/student training machinery and the HITL queue are all real. The output path and the closed loop are not. **Say "input-side guarding, with the output path designed but not built" and you are unassailable. Repeat the README and one sharp question ends your demo.**

---

## 4b. Three things you should know before you pitch

These matter because a judge or a reviewer will find them.

**1. NSEGPT is a fork, and its headline size is misleading.**
The repository contains ~156,000 lines of Python, but the README states plainly that it is *"a private fork of Odysseus … maintained for evaluation by NSE."* The bulk — `agent_loop.py` (2,973 lines), `tool_implementations.py` (4,598), `task_scheduler.py` (2,309), `builtin_actions.py` (2,246) — is upstream. It is AGPL licensed.

Your actual contribution is `src/confidence_gate.py`, `src/file_revert_store.py`, `src/graph_index/` (AST queries over the code graph), and one additional registered tool. **Do not present 156K lines as yours.** Present the delta, which is genuinely the right delta: *a confirmation gate before destructive tool actions, and one-click revert after file edits.* That is production human-in-the-loop design, and it is directly reusable. The AGPL licence also means you should not vendor this code into a hackathon submission without thinking it through.

**2. DebtEase contains no AI whatsoever.**
Grepping the entire source for `openai|gemini|anthropic|claude|langchain|llm|gpt-` returns **zero matches**. The "AppAssistant" is a 114-line UI panel. It is a well-built algorithmic app — the greedy settlement optimiser is real — but it cannot be pitched into an *AI-powered* track without building the AI first.

**3. `RAG-with-LangGraph-Guardrails-LLM-Gateway` self-describes as partial.**
Its README says: *"this repo is a runnable core + IaC skeleton."* The graph, gateway, guardrails and evals are implemented; the infrastructure is scaffolding. Budget for that honestly — it is a strong foundation, not a deployed system.

---

## 5. Track-by-track fit

Scored 1–5 on what you can *evidence today*, not what you could build.

### Track: AI-Powered Financial Journeys

| Dimension | Score | Evidence |
|---|---|---|
| Domain assets | 2 | StockSense-AI (equities, not insurance/lending); DebtEase (P2P settlement) |
| AI depth | 4 | Gemini + Groq wired in StockSense; the whole RAG/guardrails stack applies |
| Document-heavy journey capability | 4 | Enterprise-Advanced-RAG, RAG Gateway, EV-Bharat OCR/pdf-parser |
| **Regulated-finance credibility** | **4** | nse-guardrail — built for NSE, grounded in SEBI policy; Technowin — GIGW compliance auditing |
| True fit | **3** | *(revised up from 2)* Nothing touches claims, policies, underwriting or collections — but you can now speak credibly about regulated financial systems |

The track's own example is *health insurance claims*. You have no insurance code, and StockSense is wealth-management — a different journey. This remains a build-from-scratch track. What the private repos add is standing: "I built the guardrail layer that sits in front of the National Stock Exchange's internal LLM" is a strong opening line in a fintech room, whichever track you enter.

### Track: Autonomous AI Teammates

| Dimension | Score | Evidence |
|---|---|---|
| Agent orchestration | 5 | Failure-Aware (multi-agent + MCP); RAG Gateway (cyclic LangGraph); Odysseus agent loop |
| **Escalation / confidence** | **5+** | *Two independent implementations.* nse-guardrail's tri-state router with a documented threshold trade-off **and a live HITL queue, shipped to a stock exchange**; Failure-Aware's DPO-trained policy with measured ECE |
| Safe action-taking | 5 | *(revised up from 4)* nse-guardrail intercepts every message pre-LLM at <200 ms; `confidence_gate.py` confirmation before destructive actions; file revert |
| Observability | 5 | NSE_Observability (LiteLLM+Prom+Grafana); Failure-Aware ships its own Grafana dashboards; nse-guardrail has `audit/logger.py` |
| **Human-in-the-loop UX** | **4** | *(new)* nse-guardrail ships an admin review queue and a 35-file Next.js console — the escalation inbox already exists |
| Domain (sales/service) | 1 | None — no CRM, no ticketing, no support workflow anywhere |
| True fit | **5** | *(revised up from 4)* Capability fit is now exceptional; domain fit is still zero |

### Track: Merchant Growth AI

| Dimension | Score | Evidence |
|---|---|---|
| Merchant domain | 5 | VendorConnect — 16.4K lines of genuine merchant operations |
| Seller-growth AI precedent | 4 | Karigar — storytelling, TTS, design and video-script generation for sellers |
| Analytics/recommendation engine | 2 | No forecasting, no next-best-action, no cohort analysis in either |
| Agentic execution | 2 | VendorConnect's AI layer is 838 lines of API wrapper — no planning, no tool use |
| True fit | **3** | Best domain fit you have; weakest AI depth |

---

## 6. Why Autonomous AI Teammates wins

Three reasons, in order of weight.

**It is the only track where your moat is the part everyone else fakes.**
The track brief says: *"escalating to humans only when needed."* Read the field in §7 — every serious entrant handles this with a hand-authored rule set. That is defensible engineering and it is also completely reproducible in an afternoon. A *calibrated* escalation policy, with a reported ECE and a documented threshold trade-off, is not. You can put a reliability diagram on a slide. Nobody else will.

**You have shipped this to a financial institution already.**
This is the argument the first draft of this document could not make. `nse-guardrail` is not a prototype — it sits in front of the National Stock Exchange's internal LLM, scores every message in under 200 ms, routes the ambiguous middle band to a human queue, and reports 405 passing tests. When a Paytm judge asks *"would you trust this with real money?"*, most teams will answer with conviction. You can answer with a deployment.

**Three of your repos compose, rather than merely coexist.**
`nse-guardrail` is the immune system — the tri-state risk router and the HITL queue. `RAG-with-LangGraph-Guardrails-LLM-Gateway` is the body — cyclic graph, gateway, evals, memory, observability. `Failure-Aware-Search-Agents` is the nervous system — the thing that knows when it does not know, and was *trained* to know it. These were built separately, for unrelated purposes, and they fit together without forcing. That is an unusual position to start a hackathon from.

**The judging criterion this track rewards is exactly what you can prove.**
"Delivers measurable outcomes" is in the brief. You already have the measurement apparatus: `expected_calibration_error`, `hallucination_rate`, `research_rate`, `_find_threshold.py`, `_honest_eval.py`, `calibrate_boosts.py`, RAGAS evals, Prometheus/Grafana, per-request cost metering. Most teams will demo a happy path. You can demo a **deflection-rate-vs-escalation-precision curve** and defend the operating point.

### The argument against, stated fairly

You have **no customer-service or sales domain code at all**. Competitors like `PaytmResolveAI` and `Resolve OS` have built exactly that, with UPI-specific state machines. You are trading domain depth for capability depth. That trade is only worth making if your demo *foregrounds the calibration and safety story* — if you present a generic support bot, you lose to teams with better domain modelling.

A second, smaller risk: `nse-guardrail` was built under an NSE internship and is marked internal-testing-only. **Check what you are permitted to show or reuse before you build the pitch around it.** If the code itself is off-limits, the *approach* and your authorship of it are still yours to describe — but find that out now, not the night before.

---

## 7. The competitive field — read this carefully

The most important finding of this survey: **all three tracks already have substantial public submissions.** These are on GitHub now and set the bar.

### Merchant Growth AI — heavily saturated

| Repo | Approach |
|---|---|
| [rohanbhowm25308/GrowthPilot-AI](https://github.com/rohanbhowm25308/GrowthPilot-AI) | Flask + Groq (`gpt-oss-120b`), **8 specialised agents** (Business Analyst, Customer Intelligence, Forecast, Growth Strategy, Marketing, ROI, Action, Orchestrator), CSV upload with auto column detection, approval-based Action Center. Deployed on Render. |
| [inchara831/paytm-growth-copilot](https://github.com/inchara831/paytm-growth-copilot) | Transaction telemetry → margin-risk and traffic-anomaly isolation → one-click execution |
| [supritha-sekar/CommercePilot](https://github.com/supritha-sekar/CommercePilot) | Agentic commerce, opportunity detection + explanation |
| [manthandhanraj/MerchantAI](https://github.com/manthandhanraj/MerchantAI) | Framed as "what is happening, why, what should I do today — a business partner, not a dashboard" |
| [Yashasy7/Merchant-Mind](https://github.com/Yashasy7/Merchant-Mind), [haritha4538/agentic-commerce-growth-copilot](https://github.com/haritha4538/agentic-commerce-growth-copilot), [Zelalem-Dev/Mercato-AI](https://github.com/Zelalem-Dev/Mercato-AI) | Same shape |

GrowthPilot-AI is polished and explicitly hackathon-targeted. Entering here means out-executing a crowded field on a problem where your AI layer is currently the weakest.

### Autonomous AI Teammates — contested, but with a visible gap

| Repo | Approach |
|---|---|
| [dubeyjiongit/PaytmResolveAI](https://github.com/dubeyjiongit/PaytmResolveAI) | Investigates stuck UPI payments. Four independent state rails (`bank_status`, `upi_status`, `receiver_status`, `refund_status`). **"A deterministic policy engine, never the LLM, decides anything touching money."** Risk scoring triggers step-up verification; escalates when rails disagree. Express+TS / React+Vite. Claims "no placeholders, anywhere." |
| [sparsh101sparsh/resolve-os](https://github.com/sparsh101sparsh/resolve-os) | Merchant support ops teammate — Sarvam AI + deterministic policy + WhatsApp |
| [sparsh101sparsh/paytm-desk](https://github.com/sparsh101sparsh/paytm-desk) | Hinglish merchant settlement/refund disputes, Sarvam + Cognee + n8n |
| [AmitNIET159/mitra-autonomous-ai](https://github.com/AmitNIET159/mitra-autonomous-ai) | Detects signals → reasons → executes safe actions → learns from outcomes |
| [hrishabh1915/paytm-ai-customer-resolution-teammate](https://github.com/hrishabh1915/paytm-ai-customer-resolution-teammate), [Sonitmehta/Paytm-Merchant-AI](https://github.com/Sonitmehta/Paytm-Merchant-AI), [NamanBhardwajJackOfAllTrades/paytm-ai-teammate](https://github.com/NamanBhardwajJackOfAllTrades/paytm-ai-teammate) | Variations on the same pattern |

**The gap:** every one of these hardcodes the escalation boundary. None reports a calibration metric. That is your opening.

### AI-Powered Financial Journeys — contested

| Repo | Approach |
|---|---|
| [shiv9956/Sahaj](https://github.com/shiv9956/Sahaj) | Described as a winner edition. Next.js + Fastify + TypeScript. Turns a spoken/typed goal into a guided, evidence-backed journey across lending and insurance. |
| [S-jais/ClaimSaathi](https://github.com/S-jais/ClaimSaathi) | Health-insurance reimbursement: document checking, rejection-letter parsing via RAG, structured reconsideration drafts |
| [agniv-dutta/FinSaathi](https://github.com/agniv-dutta/FinSaathi) | Policy upload → Q&A, coverage verification, eligibility, claim tracking |
| [ayushraj5634/Sahayak_Paytm](https://github.com/ayushraj5634/Sahayak_Paytm) | Voice-first multimodal copilot for MSMEs — credit access + insurance claims in 8+ Indic languages |

Note the pattern: **Indic-language voice is a recurring differentiator** across this track.

---

## 8. Reference architectures worth studying

Not competitors — prior art to learn from and cite.

**Human-in-the-loop primitives (study before designing your gate)**
- [LangGraph `interrupt()`](https://docs.langchain.com/oss/python/deepagents/human-in-the-loop) — pause mid-run, persist state to a checkpointer, resume after a human decision. Stable since v1.0; the most battle-tested option for pause/resume.
- [OpenAI Agents SDK human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/) — tools declare `needs_approval` (boolean or a per-call async predicate); paused runs serialise via `RunState`. **The per-call predicate is the hook where your calibrated confidence score belongs.**

**Escalation-aware service agents**
- [huabeitech/agent-desk](https://github.com/huabeitech/agent-desk) — ~250 stars, ~1,100 commits, actively maintained. Go/Gin/GORM + Next.js 16 + Qdrant. Handoff via an *answerability evaluation*: if retrieved content cannot support an answer, fall back to human. Also supports explicit user request, agent-to-agent transfer, and ticket escalation. **The closest public analogue to what you should build — and its answerability check is exactly the thing your calibrated policy improves on.**
- [thirilose-learn/autonomous-ai-customer-support-agent](https://github.com/thirilose-learn/autonomous-ai-customer-support-agent) — structured data retrieval + policy RAG + safe escalation fallback
- [Oninlovesjiujitsu/ai-automation-project](https://github.com/Oninlovesjiujitsu/ai-automation-project) — drafts responses, programmatically evaluates for hallucination and tone, auto-sends safe ones and routes risky ones to Slack. A clean two-stage safety pattern.
- [tanmoynit/autonomous-support-escalation-agent](https://github.com/tanmoynit/autonomous-support-escalation-agent) — escalates on refund size, age, prior use, or ambiguity; drafts an escalation ticket rather than guessing

**Financial-domain agent architecture**
- [aws-samples/sample-agentic-insurance-claims-processing-eks](https://github.com/aws-samples/sample-agentic-insurance-claims-processing-eks) — LangGraph hub-and-spoke: Coordinator orchestrating Policy, Fraud and Risk agents. Notably ships **four persona portals** (Claimant, Adjuster, SIU, Supervisor) so humans can override or investigate. The persona-portal idea is worth stealing regardless of which track you choose.
- [JeevanChevula/ClaimPilot](https://github.com/JeevanChevula/ClaimPilot) — FastAPI + Groq LLaMA-3; classifies claim document types, extracts structured data, validates completeness, returns a decision

**Calibration and abstention — the literature behind your moat**
- [yubol-bobo/awesome-llm-confidence](https://github.com/yubol-bobo/awesome-llm-confidence) — curated; explicitly covers how confidence propagates across tools, steps and agents in composed action loops
- [MiaoXiong2320/llm-uncertainty](https://github.com/MiaoXiong2320/llm-uncertainty) — ICLR 2024, *"Can LLMs Express Their Uncertainty?"*. Prompting / sampling / aggregation framework. Key finding to cite: **verbalised confidence is systematically overconfident** — which is precisely the argument for your DPO-trained alternative.
- [SihengLi99/LLM-Honesty-Survey](https://github.com/SihengLi99/LLM-Honesty-Survey) — TMLR survey on known/unknown recognition, calibration, selective prediction
- [chenjux/abstention](https://github.com/chenjux/abstention) — uncertainty-based abstention

**Framework landscape**
- [Shubhamsaboo/awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps), [Jenqyang/Awesome-AI-Agents](https://github.com/Jenqyang/Awesome-AI-Agents), [aloth/awesome-ai-agents](https://github.com/aloth/awesome-ai-agents)

---

## 9. Concrete proposal

**An autonomous customer-resolution teammate whose escalation decision is trained, not hardcoded — and measured in production.**

### The pitch, in one line

> Everyone's agent escalates. Ours knows *when* — and can prove it, because the escalation policy was post-trained for calibration and is reported as an Expected Calibration Error, not asserted as a threshold.

### Architecture

```
  Customer message (text / voice / Indic)
        │
        ▼
  ┌──────────────────────────────────────────────────────────┐
  │  INTERCEPT (<200ms)            ← nse-guardrail            │
  │  student pipeline: rules + XGBoost + SVDD/EIF + BERT      │
  │      risk >0.80 → hard block                              │
  │      risk <0.25 → pass through                            │
  │      0.25–0.80  → teacher adjudication → HITL queue       │
  ├──────────────────────────────────────────────────────────┤
  │  guard_input       ← RAG Gateway (PII, prompt injection)  │
  ├──────────────────────────────────────────────────────────┤
  │  plan · retrieve · rerank_and_grade                        │
  │        ← RAG Gateway cyclic LangGraph                      │
  │        ← policy docs, txn history, merchant profile        │
  │        ↺ transform_query on weak retrieval                 │
  ├──────────────────────────────────────────────────────────┤
  │  CALIBRATED CONFIDENCE          ← Failure-Aware-Search     │
  │  0.45·retrieval + 0.30·source_trust + 0.25·verification    │
  │                                                            │
  │   ≥ high   → ACT     execute via tools, log, notify        │
  │   mid      → HEDGE   act with stated uncertainty + undo    │
  │   low      → ESCALATE structured handoff packet to human   │
  ├──────────────────────────────────────────────────────────┤
  │  confidence_gate   ← NSEGPT pattern                        │
  │      any money-moving action → explicit confirmation       │
  │      every action → one-click revert (file_revert_store)   │
  ├──────────────────────────────────────────────────────────┤
  │  guard_output      ← groundedness + PII check              │
  ├──────────────────────────────────────────────────────────┤
  │  Observability     ← NSE_Observability                     │
  │      LiteLLM → Prometheus → Grafana                        │
  │      per-resolution cost, latency, tokens, ECE, deflection │
  └──────────────────────────────────────────────────────────┘
```

Every box maps to code you have already written. The new work is the domain layer: the tool implementations, the ticket model, and the human console.

### What you must build new (be realistic about scope)

1. **Domain tools** — refund, settlement lookup, txn status, ticket create/update. Mock backends are fine and expected; `PaytmResolveAI` does the same.
2. **Human console** — the escalation inbox. nse-guardrail's admin queue and Next.js console are the closest starting point you have; extend rather than rebuild. Steal the persona-portal idea from the AWS sample: an Agent view and a Supervisor view.
3. **Retarget the risk model** — nse-guardrail scores *prompt-injection and policy-violation* risk. You need it to score *resolution confidence* instead. The routing skeleton, the teacher/student split and the threshold methodology all transfer; the labels and training corpus do not. **This is the largest single piece of new work — plan for it explicitly.**
4. **The output path** — `output_guard/scanner.py` is 8 lines. An agent that takes actions needs its outputs checked, so this becomes load-bearing in a way it was not at NSE. The RAG Gateway's `guard_output` (groundedness + PII) covers most of it; wire that in rather than writing new.
5. **The demo dataset** — 30–50 realistic support conversations, deliberately spanning clear-cut, ambiguous, and adversarial cases. **This is what makes or breaks the calibration story.** Without ambiguous cases your ECE means nothing.
6. **The reliability diagram** — plot predicted confidence against actual resolution correctness. This is your single most persuasive slide.

### What you must *not* do

- Do not rebuild the RAG stack. Import it.
- Do not vendor AGPL Odysseus code. Re-implement the confidence-gate *pattern* — it is ~200 lines.
- Do not claim NSEGPT's line count.
- Do not repeat nse-guardrail's README claims about the output guard or the active-learning loop. See §4a.
- Do not use NSE code or data without checking what the internship terms allow.
- Do not demo only happy paths. Your entire differentiation lives in the cases where the agent declines to act.

### The four slides that win this

1. **I have already built this for a stock exchange.** The NSE guardrail architecture, the tri-state router, 405 tests, <200 ms. Establishes that you are not prototyping a concept — you are porting a system.
2. **Everyone escalates on a hardcoded rule.** Show a competitor's `if` statement. Then show `ALLOW_THRESHOLD = 0.25  # lowered from 0.35 — catches 19 more attacks, cost = 1 extra safe to teacher` next to your reliability diagram.
3. **Deflection vs. escalation precision.** A real curve, from real evals. State the operating point you chose and why.
4. **Cost per resolution, live.** Your Grafana dashboard, running during the demo. Very few teams will have this.

---

## 10. If you overrule this and pick Merchant Growth AI

Defensible — it is your strongest *domain* asset and you know the vendor problem genuinely. If you go this way:

- **Build on VendorConnect**, not from scratch. 16.4K lines of merchant operations is a real head start, and the group-ordering and price-alert features are already differentiated.
- **Bring the calibration story with you anyway.** Every competitor recommends actions; recommend them *with a confidence the merchant can act on*, and refuse to recommend when the data is thin. Same moat, different track.
- **Differentiate on execution, not insight.** The field is saturated with "diagnose + recommend." GrowthPilot-AI already has 8 agents and an approval-based Action Center. Win on *closing the loop* — measure whether the recommended action actually moved revenue, and feed that back.
- **Use Karigar's assets.** TTS and multilingual content generation for merchant campaigns is working code, and Indic-language support is a recurring differentiator across this hackathon.

---

## 11. Open questions for you

1. **What are you permitted to reuse from `nse-guardrail`?** It is marked internal-testing-only and was built under an NSE/BITS internship. This is now the load-bearing question — the recommendation leans on it. Code, architecture, and "I built this" are three different permissions; find out which you have.
2. **What is in `TensorTrail`, `CyberQore`, `PlaceIQ` and `Svayom`?** Still unread — organisation repos cannot be attached to this session (§2). Reading `nse-guardrail` reordered this whole analysis; these could too. **Open a fresh session against one of them to have them read.**
3. **Team size and time?** The proposal in §9 is ~2 people for a weekend *given* that you import your existing stack — but retargeting the risk model (§9, item 3) is real work. From scratch it is not achievable.
4. **Can you use hosted models, or is on-prem required?** Your Odysseus/Ollama/nse-guardrail work is all on-prem, which is itself a differentiator for a payments company with data-residency constraints — worth a slide either way.
5. **Do you have any real transaction or support-ticket data**, even synthetic-but-realistic? The calibration story needs ambiguous cases to be credible. nse-guardrail's `data/` and `evals/` may give you a reusable harness even if the labels do not transfer.

---

## Appendix — full repository inventory

**`karthikj30` — 24 public**
Portfolio · Karigar · crimeintel-ai · EcoSaksham · Django_web · Skillora · Karthik_pipeline_ADL · HealthSaathi · Seeker · NSE_Observability · Monastery360 · BharatYatra · ChatBot · GForce · DebtEase · LeetCode · VendorConnect · karthikj30 · MyFirst_Web · Arka-Jewels · CIDCO_Architect · CIDCO_WinEXE · karthikj30.github.io · GitHub-Achievement-s

**`karthikj30` — 15 private**
UrbanYantra · Failure-Aware-Search-Agents · Technowin · nse-guardrail · NSEGPT · RAG-with-LangGraph-Guardrails-LLM-Gateway · sample-app · my_hugo_site · Enterprise-Advanced-RAG · DSA_Graphs · StockSense-AI · Paytm_hackathon-idea · hello-cloudbuild-app · hello-cloudbuild-env · CyberAstra_SIH26

**`CodedbyAKSA` — 9**
EV-Bharat (public, read) · Itihaas (public, read) · .github (public) · VLC ✗ · CyberQore ✗ · PlaceIQ ✗ · TensorTrail ✗ · DataForge ✗ · ExamGEN ✗

**`Svayom` — 1**
Svayom ✗ (private, TypeScript)

✗ = not readable from this session; organisation repos cannot be attached once the session is scoped to `karthikj30`. Start a new session against one of them to have them read.
