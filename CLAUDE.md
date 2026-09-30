# Nirnaya: notes for Claude

## Standing rules from the owner
- Commit and push as **karthikj30 <karthikjanardhan5@gmail.com>**. Work on **main** and push to main; main is the default branch.
- The product is **Nirnaya** (never "Nirnay"; the deck and diagrams were renamed too).
- Deck and slide text: never name other projects' owners or organisations, no framework names, nothing from the earlier NSE idea. It is a new project.
- Slide copy is short points, and each slide says something new. Keep deck numbers consistent: autonomy ~30% → 55–65% (target), ₹3–6 vs ₹40–60 per case, ₹6–12 per resolution and ₹0 on escalations, first reply under 5 s, risk check under 200 ms, α as low as 0.2%.

## Commands
```bash
make install                      # pip install -e backend[...] + npm ci in web/
make run                          # build web, serve API + web on :8000
make dev                          # API :8000 (reload) + Vite :5173 (proxies /api and /mcp)
cd backend && python -m pytest -q # 42 tests, about 20 s
cd web && npx tsc -b --noEmit && npm run build
cd web && npm run e2e             # needs a server on :8000; 17 browser checks (software WebGL flags are in the script)
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
- An op (a task typed to a department, a routine run) never moves money: it calls the engine's own functions (`recalibrate`, `undo`, `trail.verify`, `benchmark.run`, reads through the gateway). A new op kind needs a `KINDS` entry and a `run_kind` branch in `ops.py`, and a test in `tests/test_office.py`. Kinds that change the model (`recalibrate`) wait for the OK (`needs_ok`).

## Layout
- `backend/nirnaya/`:
  - pipeline: `engine.py` (supersteps), `sentry_gate.py`, `pii.py`, `understand.py`, `specialists.py`, `shadow.py`, `seal.py`, `gateway.py`
  - scoring: `calibration.py`, `conformal.py`, `drift.py`
  - knowledge: `memory.py`, `graph.py`
  - replies: `replies.py`, `guard.py`
  - the office: `office.py` (`/api/office/*`), `ops.py` (tasks typed to a department, routine runs, booked tasks), `schedule.py` (plain-words schedules → next run), `routines.py` (the timetable), `presets.py` (sample messages)
  - other: `rails.py` (simulated bank), `benchmark.py`, `docparse.py`, `reports.py`, `llm.py`
  - serving: `api.py` (REST, SSE `/api/events`, MCP `/mcp`, serves `web/dist`)
- `backend/nirnaya/personas/*.md`: one persona per agent (front matter: `department` is one of the six, `lead: true` on each department's lead).
- Six departments (`agents.DEPARTMENTS`): intake, resolution, verification, decision, commit, oversight; each has a lead.
- `web/src/`:
  - shell and state: `App.tsx` (the office full screen when `view === "office"`, else the workspace shell), `store.ts` (external store + SSE, `onEvents` for listeners), `api.ts`
  - the office (`office/`, all original code): `scene.ts` (three.js scene, camera, people, emotes, tickets, the Brain board; positions bound HTML each frame via `scene.bind(key, el)`), `models.ts` (low-poly pieces), `layout.ts` (pods, seats, colours), `wires.ts` (SVG connector wires), `data.ts` (`/api/office` client, office store, cases and ops → cards), `OfficePage.tsx`, `Panel.tsx` (Task Status), `Rail.tsx` (department + agent chat, approvals), `Overlays.tsx` (board, Brain, calendar, big editor), `office.css`
  - workspace views: `views/*` (Workspace + Approvals, Supervisor, Brain, Ledger with Univer lazy-loaded, Benchmark, Trail, Settings)
- `docs/REPO-SCAN.md`: what was taken from each of the 18 reference repos, and why some were not merged (licences).

## Licence rules for the reference repos
Do **not** copy code from these:
- **AGPL:** OpenMontage, Recordly, codegraff
- **agents-office:** PolyForm Noncommercial; no rebranding, no fronting another agent system. The owner asked for its exact UI; copying its code was refused by this environment's safety check (a public repo and a DM sending the link are not the written permission its licence asks for). The office in `web/src/office/` is original code built from screenshots of it. Do not paste or transcribe its source, assets, fonts or marks into this repo. If the owner later has written permission from its author covering commercial use, renaming and fronting Nirnaya, it must be saved under `docs/permissions/` first, and the port must keep that project's notices.
- **Sentry server:** FSL

Use the Sentry SDKs only. Do not use pixel-agents' image assets. The MIT and Apache ones are fine to learn from or depend on (three.js, Univer, the fonts are packages). If code is ever copied, keep its licence notice.

## Gotchas
- React: a `useUI` selector must never return a fresh array or object (`?? []` loops forever; use `EMPTY` from `store.ts`).
- Univer mounts into a node React does not manage (see `Ledger.tsx`), or React throws `removeChild`.
- Shell: `pkill -f "nirnaya --port"` (or `pgrep`) matches its own command line and kills the shell. Use `pgrep -f "[n]irnaya --port"` in a command that does not also contain the literal string.
- The SSE stream never goes idle: in Playwright wait for `load`, not `networkidle`. Chromium is preinstalled; use `playwright@1.56.1` with `channel: "chromium"`.
- The calibration fit takes about 2 s at startup (200k synthetic rows); tests share one fitted `Calibrator` via a session fixture.
- Office CSS resets use `:where(.o-root) :where(button)` on purpose: a plain `.o-root button { font: inherit }` outranks every component class and blows up the chips and buttons.
- Office keys (1–6, B, G, P, C, D, W) belong to the office; `App.tsx` ignores its own view keys while `view === "office"`.
- FastAPI runs sync endpoints in a thread pool: any office endpoint that starts an op or publishes events must be `async def` (ops use `asyncio.create_task`).
- e2e: the recalibration step rejects on purpose (approving would teach the model from the test's own labels and change later routes). Checks select approval packets by `data-case` / `data-op`, never "the last one".
- Fonts are bundled (`@fontsource/inter`, `@fontsource/instrument-serif`), so the office looks the same offline and in the phone build.

## Next
Web app first (done), with the 3D office as home (done). Then the **APK**: wrap `web/` with Capacitor, pointing at a server URL (Settings → Server). Then the **EXE**: Electron shell that starts the backend (PyInstaller) and loads `web/dist`.
