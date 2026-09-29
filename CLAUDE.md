# Nirnaya: notes for Claude

## Standing rules from the owner
- Commit and push as **karthikj30 <karthikjanardhan5@gmail.com>**. Work on **main** and push to main; main is the default branch.
- The product is **Nirnaya** (not "Nirnay"; older files in `architecture/` and `ppt.md` still say Nirnay).
- Deck and slide text: never name other projects' owners or organisations, no framework names, nothing from the earlier NSE idea. It is a new project.
- Slide copy is short points, and each slide says something new. Keep deck numbers consistent: autonomy ~30% → 55–65% (target), ₹3–6 vs ₹40–60 per case, ₹6–12 per resolution and ₹0 on escalations, first reply under 5 s, risk check under 200 ms, α as low as 0.2%.

## Commands
```bash
make install                      # pip install -e backend[...] + npm ci in web/
make run                          # build web, serve API + web on :8000
make dev                          # API :8000 (reload) + Vite :5173 (proxies /api and /mcp)
cd backend && python -m pytest -q # 33 tests, about 13 s
cd web && npx tsc -b --noEmit && npm run build
cd web && npm run e2e             # needs a server on :8000; 13 browser checks
```
Env: `NIRNAYA_DB` (SQLite path), `NIRNAYA_STEP_DELAY` (animation pacing, 0 in tests), `NIRNAYA_LLM=off|auto`,
`ANTHROPIC_API_KEY`, `NIRNAYA_MODEL` (default `claude-opus-5-5`), `SENTRY_DSN`, `VITE_SENTRY_DSN`, `NIRNAYA_WEB`.

## Invariants: do not break these
- Money moves **only** through `Gateway.execute_sealed`: seal match, ownership, policy cap, unused idempotency key. Never call `rails.reverse/refund/wallet_credit` from anywhere else.
- Models and the UI see **tokenised** text only (`pii.Tokeniser`). Only the gateway detokenises.
- Every reply goes through `guard.check`; amounts and references in a reply must be in `plan.facts`.
- Routing uses the **calibrated** score, never the stated one. Thresholds come from `conformal.RiskControl` (Learn-then-Test, δ = 0.05, per action × amount band). An uncertifiable threshold is `None`/∞ and means "never alone".
- Every superstep writes a checkpoint; parked cases live in checkpoints. `Engine.run/approve/reject/undo` share a per-case `asyncio.Lock`; internal re-runs call `_run`, never `run` (it would deadlock).
- The trail is append-only and hash-chained; never update rows.
- A new action type needs all of these: an entry in `policy.default_actions`, `ACTION_BIAS` and the sampling mix in `calibration.py`, a specialist branch, a reply template, a `WHAT` phrase, a gateway `_run_action` branch, a benchmark scenario and tests.

## Layout
- `backend/nirnaya/`:
  - pipeline: `engine.py` (supersteps), `sentry_gate.py`, `pii.py`, `understand.py`, `specialists.py`, `shadow.py`, `seal.py`, `gateway.py`
  - scoring: `calibration.py`, `conformal.py`, `drift.py`
  - knowledge: `memory.py`, `graph.py`
  - replies: `replies.py`, `guard.py`
  - other: `rails.py` (simulated bank), `routines.py`, `benchmark.py`, `docparse.py`, `reports.py`, `llm.py`
  - serving: `api.py` (REST, SSE `/api/events`, MCP `/mcp`, serves `web/dist`)
- `backend/nirnaya/personas/*.md`: one persona per agent (front-matter format).
- `web/src/`:
  - shell and state: `App.tsx`, `store.ts` (external store + SSE), `api.ts`
  - office: `office/engine.ts` (canvas; all art is drawn in code)
  - views: `views/*` (Office, Workspace + Approvals, Supervisor, Brain, Ledger with Univer lazy-loaded, Benchmark, Trail, Settings)
- `docs/REPO-SCAN.md`: what was taken from each of the 18 reference repos, and why some were not merged (licences).

## Licence rules for the reference repos
Do **not** copy code from these:
- **AGPL:** OpenMontage, Recordly, codegraff
- **agents-office:** PolyForm Noncommercial; no rebranding, no fronting another agent system
- **Sentry server:** FSL

Use the Sentry SDKs only. Do not use pixel-agents' image assets. The MIT and Apache ones are fine to learn from or depend on. If code is ever copied, keep its licence notice.

## Gotchas
- React: a `useUI` selector must never return a fresh array or object (`?? []` loops forever; use `EMPTY` from `store.ts`).
- Univer mounts into a node React does not manage (see `Ledger.tsx`), or React throws `removeChild`.
- Shell: `pkill -f "nirnaya --port"` (or `pgrep`) matches its own command line and kills the shell. Use `pgrep -f "[n]irnaya --port"` in a command that does not also contain the literal string.
- The SSE stream never goes idle: in Playwright wait for `load`, not `networkidle`. Chromium is preinstalled; use `playwright@1.56.1` with `channel: "chromium"`.
- The calibration fit takes about 2 s at startup (200k synthetic rows); tests share one fitted `Calibrator` via a session fixture.

## Next
Web app first (done). Then the **APK**: wrap `web/` with Capacitor, pointing at a server URL (Settings → Server). Then the **EXE**: Electron shell that starts the backend (PyInstaller) and loads `web/dist`.
