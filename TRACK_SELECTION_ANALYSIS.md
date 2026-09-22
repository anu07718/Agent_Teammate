# Paytm AI Hackathon — Track Selection Analysis

**Prepared for:** Karthik Janardhan ([@karthikj30](https://github.com/karthikj30))
**Date:** 22 September 2026
**Scope:** Full audit of 49 repositories (39 personal + 9 `CodedbyAKSA` + 1 `Svayom`), mapped against the three hackathon tracks, plus a survey of public GitHub prior art and the competing field.

---

## 1. The recommendation in one page

**Pick the `Autonomous AI Teammates` track.**

Not because it is the easiest — it is the most contested — but because it is the only track where you already own the component that almost nobody else in the field has built.

Every credible competitor in this track (and there are many, see §7) converges on the same design: *an LLM proposes, a hand-written deterministic policy engine disposes, and the system escalates to a human when the rules say so.* That is a sound design and it is now table stakes. The universal weakness is that **the escalation decision itself is hardcoded** — a threshold someone picked, a list of `if amount > X` rules.

You have already built, and *trained*, the alternative. `Failure-Aware-Search-Agents` post-trains an agent with DPO so that it emits a **calibrated** confidence signal, and it picks between three policies — `confident` / `hedge` / `re_search` — based on that signal. It measures itself with **Expected Calibration Error**. That is the hard, research-shaped part of "escalating to humans only when needed," and it is sitting in your account already implemented.

Paired with `RAG-with-LangGraph-Guardrails-LLM-Gateway` (the production substrate: cyclic LangGraph, in/out guardrails, multi-provider gateway, evals, IaC) and the `confidence_gate.py` / file-revert pattern from your `NSEGPT` work, you can stand up an autonomous teammate whose *escalation policy is a measured, defensible artifact* rather than an opinion.

**Runner-up:** `Merchant Growth AI`, on the strength of `VendorConnect` — your single largest genuine domain asset. Ranked second only because the track is the most saturated of the three and your AI layer there is thin.

**Third:** `AI-Powered Financial Journeys`. Real assets exist (`StockSense-AI`, `DebtEase`) but neither touches insurance or lending, which is where the track's centre of gravity sits.

### Blunt answer to "does anything I have TRULY fit?"

**No — not as a drop-in.** Be clear-eyed about this:

- **No repository in your account is a Paytm-domain application.** Not one touches payments, settlements, UPI, insurance claims, or lending underwriting.
- Your portfolio splits cleanly into **domain assets with thin AI** (VendorConnect, Karigar, DebtEase) and **deep AI infrastructure with no consumer domain** (Failure-Aware, RAG Gateway, Enterprise-Advanced-RAG, NSE_Observability).
- The winning move is therefore **not** "submit an existing repo." It is: *take the AI infrastructure you have genuinely built and hard to fake, and wrap it in a new, thin, Paytm-shaped domain layer.*

That is a real advantage, not a consolation. The infrastructure is the part that takes months. The domain wrapper is the part that takes a weekend.

---

## 2. Method and honest coverage

| What | How |
|---|---|
| Repository inventory | GitHub API across `karthikj30`, `CodedbyAKSA`, `Svayom` |
| Deep code inspection | Shallow clone + line counts, dependency manifests, entrypoints, grep for actual LLM/ML call sites |
| "Is it real?" test | Own-code LOC excluding `node_modules` / `site-packages` / `.venv`; presence of tests; whether AI is *called* or merely *named in the README* |
| Prior art | Public web + GitHub search |

**Inspected at source level (14):** VendorConnect, DebtEase, Karigar, HealthSaathi, Failure-Aware-Search-Agents, RAG-with-LangGraph-Guardrails-LLM-Gateway, NSEGPT, NSE_Observability, Enterprise-Advanced-RAG, StockSense-AI, crimeintel-ai, EV-Bharat, Itihaas, Paytm_hackathon-idea.

**Assessed from metadata only (not cloned):** the remaining personal repos judged clearly out-of-category (Portfolio, LeetCode, DSA_Graphs, Monastery360, BharatYatra, Arka-Jewels, Skillora, EcoSaksham, Seeker, my_hugo_site, Django_web, ChatBot, GForce, MyFirst_Web, sample-app, hello-cloudbuild-*, Karthik_pipeline_ADL, GitHub-Achievement-s, karthikj30.github.io, CIDCO_Architect, CIDCO_WinEXE, UrbanYantra, Technowin, nse-guardrail, CyberAstra_SIH26).

**Could not inspect — private and not attached to this session:** `CodedbyAKSA/VLC`, `CodedbyAKSA/CyberQore`, `CodedbyAKSA/PlaceIQ`, `CodedbyAKSA/TensorTrail`, `CodedbyAKSA/DataForge`, `CodedbyAKSA/ExamGEN`, `Svayom/Svayom`. **If any of these is a fintech or agent system, this analysis is incomplete and you should tell me** — `TensorTrail` and `CyberQore` in particular have names suggesting ML/security work that could change the ranking.

**A measurement caveat:** clones were shallow (`--depth 1`), so commit counts and history depth are *not* assessed anywhere in this document. Judgements about "is it built" rest on code volume, structure, dependency wiring, and presence of tests — not on commit activity.

---

## 3. Portfolio triage

49 repositories, sorted by relevance to any track.

### Tier A — load-bearing assets (6)

| Repo | Own LOC | What it actually is | Visibility |
|---|---|---|---|
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

### Tier C — out of category (38)

Portfolio, Skillora, Monastery360, BharatYatra, Arka-Jewels, EcoSaksham, HealthSaathi, Itihaas, UrbanYantra, CIDCO_*, LeetCode, DSA_Graphs, and the remaining scaffolds, tutorials and config repos. Not relevant to any track.

---

## 4. Three things you should know before you pitch

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
| True fit | **2** | Nothing touches claims, policies, underwriting or collections |

The track's own example is *health insurance claims*. You have no insurance code. StockSense is wealth-management, a different journey. This is a build-from-scratch track for you, with good plumbing.

### Track: Autonomous AI Teammates

| Dimension | Score | Evidence |
|---|---|---|
| Agent orchestration | 5 | Failure-Aware (multi-agent + MCP); RAG Gateway (cyclic LangGraph); Odysseus agent loop |
| **Escalation / confidence** | **5** | Calibrated confidence with measured ECE; `confident`/`hedge`/`re_search`; `confidence_gate.py` |
| Safe action-taking | 4 | Confirmation gate before destructive actions; file revert; in/out guardrails |
| Observability | 5 | NSE_Observability (LiteLLM+Prom+Grafana); Failure-Aware ships its own Grafana dashboards |
| Domain (sales/service) | 1 | None — no CRM, no ticketing, no support workflow anywhere |
| True fit | **4** | Capability fit is outstanding; domain fit is zero |

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
The track brief says: *"escalating to humans only when needed."* Read the field in §7 — every serious entrant handles this with a hand-authored rule set. That is defensible engineering and it is also completely reproducible in an afternoon. A *calibrated, trained* escalation policy with a reported ECE is not. You can put a reliability diagram on a slide. Nobody else will.

**Your two strongest repos compose, rather than merely coexist.**
`RAG-with-LangGraph-Guardrails-LLM-Gateway` is the body — cyclic graph, guardrails, gateway, evals, memory, observability. `Failure-Aware-Search-Agents` is the nervous system — the thing that knows when it does not know. These were built separately and fit together without forcing. That is a genuinely unusual position to start a hackathon from.

**The judging criterion this track rewards is exactly what you can prove.**
"Delivers measurable outcomes" is in the brief. You already have the measurement apparatus: `expected_calibration_error`, `hallucination_rate`, `research_rate`, RAGAS evals, Prometheus/Grafana, per-request cost metering. Most teams will demo a happy path. You can demo a **deflection-rate-vs-escalation-precision curve** and defend the trade-off.

### The argument against, stated fairly

You have **no customer-service or sales domain code at all**. Competitors like `PaytmResolveAI` and `Resolve OS` have built exactly that, with UPI-specific state machines. You are trading domain depth for capability depth. That trade is only worth making if your demo *foregrounds the calibration story* — if you present a generic support bot, you lose to teams with better domain modelling.

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
2. **Human console** — the escalation inbox. Steal the persona-portal idea from the AWS sample: an Agent view and a Supervisor view.
3. **The demo dataset** — 30–50 realistic support conversations, deliberately spanning clear-cut, ambiguous, and adversarial cases. **This is what makes or breaks the calibration story.** Without ambiguous cases your ECE means nothing.
4. **The reliability diagram** — plot predicted confidence against actual resolution correctness. This is your single most persuasive slide.

### What you must *not* do

- Do not rebuild the RAG stack. Import it.
- Do not vendor AGPL Odysseus code. Re-implement the confidence-gate *pattern* — it is ~200 lines.
- Do not claim NSEGPT's line count.
- Do not demo only happy paths. Your entire differentiation lives in the cases where the agent declines to act.

### The three slides that win this

1. **Everyone escalates on a hardcoded rule.** Show a competitor's `if` statement. Show your reliability diagram next to it.
2. **Deflection vs. escalation precision.** A real curve, from real evals. State the operating point you chose and why.
3. **Cost per resolution, live.** Your Grafana dashboard, running during the demo. Very few teams will have this.

---

## 10. If you overrule this and pick Merchant Growth AI

Defensible — it is your strongest *domain* asset and you know the vendor problem genuinely. If you go this way:

- **Build on VendorConnect**, not from scratch. 16.4K lines of merchant operations is a real head start, and the group-ordering and price-alert features are already differentiated.
- **Bring the calibration story with you anyway.** Every competitor recommends actions; recommend them *with a confidence the merchant can act on*, and refuse to recommend when the data is thin. Same moat, different track.
- **Differentiate on execution, not insight.** The field is saturated with "diagnose + recommend." GrowthPilot-AI already has 8 agents and an approval-based Action Center. Win on *closing the loop* — measure whether the recommended action actually moved revenue, and feed that back.
- **Use Karigar's assets.** TTS and multilingual content generation for merchant campaigns is working code, and Indic-language support is a recurring differentiator across this hackathon.

---

## 11. Open questions for you

1. **What is in `TensorTrail`, `CyberQore`, `PlaceIQ` and `Svayom`?** These are private and unattached. If any is an agent platform or fintech system, it could change the ranking.
2. **Team size and time?** The proposal in §9 is ~2 people for a weekend *given* that you import your existing stack. From scratch it is not achievable.
3. **Can you use hosted models, or is on-prem required?** Your Odysseus/Ollama work suggests you are comfortable on-prem, which is itself a differentiator for a payments company with data-residency constraints — worth a slide either way.
4. **Do you have any real transaction or support-ticket data**, even synthetic-but-realistic? The calibration story needs ambiguous cases to be credible.

---

## Appendix — full repository inventory

**`karthikj30` — 24 public**
Portfolio · Karigar · crimeintel-ai · EcoSaksham · Django_web · Skillora · Karthik_pipeline_ADL · HealthSaathi · Seeker · NSE_Observability · Monastery360 · BharatYatra · ChatBot · GForce · DebtEase · LeetCode · VendorConnect · karthikj30 · MyFirst_Web · Arka-Jewels · CIDCO_Architect · CIDCO_WinEXE · karthikj30.github.io · GitHub-Achievement-s

**`karthikj30` — 15 private**
UrbanYantra · Failure-Aware-Search-Agents · Technowin · nse-guardrail · NSEGPT · RAG-with-LangGraph-Guardrails-LLM-Gateway · sample-app · my_hugo_site · Enterprise-Advanced-RAG · DSA_Graphs · StockSense-AI · Paytm_hackathon-idea · hello-cloudbuild-app · hello-cloudbuild-env · CyberAstra_SIH26

**`CodedbyAKSA` — 9**
EV-Bharat (public) · Itihaas (public) · .github (public) · VLC · CyberQore · PlaceIQ · TensorTrail · DataForge · ExamGEN

**`Svayom` — 1**
Svayom (private, TypeScript)
