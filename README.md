# Paytm AI Hackathon — Idea Selection

Working repo for choosing and building a Paytm AI Hackathon submission.

## Tracks under consideration

1. **AI-Powered Financial Journeys** — simplify Insurance, Lending and Fintech journeys
2. **Autonomous AI Teammates** — AI that gets the job done, not just responds
3. **Merchant Growth AI** — the AI business partner for every Paytm merchant

## Current state

[**TRACK_SELECTION_ANALYSIS.md**](TRACK_SELECTION_ANALYSIS.md) — audit of all 49 repos across
`karthikj30`, `CodedbyAKSA` and `Svayom`, scored against the three tracks, plus a survey of
public prior art and the competing hackathon field. 17 repos read at source level.

**Recommendation: Autonomous AI Teammates.**

The field uniformly hardcodes its escalation boundary. You have built the alternative twice:

- **`nse-guardrail`** (31,502 LOC — the largest codebase in the account) routes every message to
  NSE's internal LLM into allow / soft-block→human-queue / hard-block on a calibrated risk score,
  in under 200 ms, with 405 passing tests and SEBI/OWASP grounding.
- **`Failure-Aware-Search-Agents`** post-trains a calibrated confidence signal with a measured
  Expected Calibration Error.

`RAG-with-LangGraph-Guardrails-LLM-Gateway` supplies the production substrate around both.

Runner-up: Merchant Growth AI, on the strength of `VendorConnect`.

**Read §4a first** — it covers what nse-guardrail actually contains versus what its README claims.
**§11** has the open questions, including what you are permitted to reuse from the NSE work.

[**ppt.md**](ppt.md) — the Track 3 deck (title, problem, solution, stack, USP, impact, business
model) plus a build plan, and a source-level audit of twelve public agent repositories scored
against the track. Its §0.4 closes §11's second open question: `Svayom/Svayom` has now been read,
and it is the licence-clean fallback substrate if NSE reuse permission does not come through.

### Not yet read

`CodedbyAKSA/{TensorTrail, CyberQore, PlaceIQ, VLC, DataForge, ExamGEN}`.
Organisation repos cannot be attached to a session already scoped to `karthikj30` — start a fresh
session against one of them. Reading the private `karthikj30` repos reordered this analysis once
already, so this is worth doing before committing to a track.
