# Paytm AI Hackathon — Idea Selection

Working repo for choosing and building a Paytm AI Hackathon submission.

## Tracks under consideration

1. **AI-Powered Financial Journeys** — simplify Insurance, Lending and Fintech journeys
2. **Autonomous AI Teammates** — AI that gets the job done, not just responds
3. **Merchant Growth AI** — the AI business partner for every Paytm merchant

## Current state

[**TRACK_SELECTION_ANALYSIS.md**](TRACK_SELECTION_ANALYSIS.md) — audit of all 49 repos across
`karthikj30`, `CodedbyAKSA` and `Svayom`, scored against the three tracks, plus a survey of
public prior art and the competing hackathon field.

**Recommendation: Autonomous AI Teammates.**

The field uniformly hardcodes its escalation boundary. `Failure-Aware-Search-Agents` already
post-trains a *calibrated* confidence signal with a measured Expected Calibration Error, and
`RAG-with-LangGraph-Guardrails-LLM-Gateway` supplies the production substrate around it. That
combination is the differentiator, and it already exists.

Runner-up: Merchant Growth AI, on the strength of `VendorConnect`.

See §11 of the analysis for the open questions that could still change this.
