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
cd backend && python -m pytest -q # 77 tests, about 60 s (19 in tests/test_channels.py; the GreenMail one skips without a mail server)
cd web && npx tsc -b --noEmit && npm run build
cd web && npm run e2e             # needs a server on :8000; 17 browser checks (software WebGL flags are in the script)
cd web && node e2e/phone-client.mjs  # the APK's flow at phone size, 5 checks (needs a server and web/dist)
cd web && node e2e/flows.mjs      # Flows: drag and drop, wire, save, run, approve on the node; 9 checks
cd web && node e2e/team.mjs       # two people (?as=Asha, ?as=Ravi): presence, shared chat, names, shared flows; 9 checks
cd web && node e2e/audit.mjs      # every view and button in dark/light, desktop/phone: errors, failed requests, clipped text, fonts (~10 min; OFFICE=0 skips the office click pass, which run.mjs and team.mjs cover)
cd web && node e2e/workflow.mjs   # workflow.md followed by a new user, step by step; 15 checks (make e2e-workflow)
cd web && node e2e/fields-office.mjs     # every office control and option, each result checked on the server; 19 checks, ~25 min
cd web && node e2e/fields-workspace.mjs  # every workspace view, input, select and button; 23 checks
cd web && node e2e/fields-flows.mjs      # every Flows node, field, option, save refusal and Check condition on real runs; 26 checks
make mail-server                  # GreenMail: real SMTP :3025 / IMAP :3143 (users support/secret, boss/secret; any other mailbox is made on delivery, login = password = address)
make test-mail                    # the email tests through it
cd web && node e2e/channels.mjs   # Channels in a browser, 22 checks: needs a server on :8000 and GreenMail; KEYED_URL=<a server with NIRNAYA_ACCESS_KEY=e2e-key> adds the lock screen
make exe                          # exe/build/Nirnaya + exe/dist/Nirnaya-Setup-<ver>-x64.exe
make apk                          # apk/dist/Nirnaya-<ver>.apk
```
Server flags for the desktop app: `--db`, `--web`, `--log FILE` (pythonw has no console), `--exit-with PID`
(stop when the window process ends; Windows waits on the process handle, POSIX polls).
Env: `NIRNAYA_DB` (SQLite path), `NIRNAYA_STEP_DELAY` (animation pacing, 0 in tests), `NIRNAYA_LLM=off|auto`,
`ANTHROPIC_API_KEY`, `NIRNAYA_MODEL` (default `claude-opus-5-5`), `SENTRY_DSN`, `VITE_SENTRY_DSN`, `NIRNAYA_WEB`,
`NIRNAYA_ACCESS_KEY` (locks the API: header `X-Nirnaya-Key`, cookie `nirnaya_key` or `?key=`), and any channel
setting as `NIRNAYA_<CHANNEL>_<FIELD>` plus `NIRNAYA_PUBLIC_URL` and `NIRNAYA_UNKNOWN` (they lock that field in the UI).

## Invariants: do not break these
- Money moves **only** through `Gateway.execute_sealed`: seal match, ownership, policy cap, unused idempotency key. Never call `rails.reverse/refund/wallet_credit` from anywhere else.
- Models and the UI see **tokenised** text only (`pii.Tokeniser`). Only the gateway detokenises.
- Every reply goes through `guard.check`; amounts and references in a reply must be in `plan.facts`.
- Routing uses the **calibrated** score, never the stated one. Thresholds come from `conformal.RiskControl` (Learn-then-Test, δ = 0.05, per action × amount band). An uncertifiable threshold is `None`/∞ and means "never alone".
- Every superstep writes a checkpoint; parked cases live in checkpoints. `Engine.run/approve/reject/undo` share a per-case `asyncio.Lock`; internal re-runs call `_run`, never `run` (it would deadlock).
- The trail is append-only and hash-chained; never update rows.
- A new action type needs all of these: an entry in `policy.default_actions`, `ACTION_BIAS` and the sampling mix in `calibration.py`, a specialist branch, a reply template, a `WHAT` phrase, a gateway `_run_action` branch, a benchmark scenario and tests.
- Every human action carries the person's name (`by`): approve/reject/undo/audit, policy changes, office tasks, routines, op approvals, chat, flows. The web app sends `team.by()`; the server cleans it with `team.clean_name`. Keep `"you"`/`"routine"`/`"system"` meaning "not a named person" where the UI checks for them.
- A flow never moves money by itself: a Customer message node goes through the whole pipeline (Seal included) and a Department task node is an ordinary op (`by="flow · <name>"`). A new node type needs a `NODE_TYPES` entry, a `validate` rule, a `_do` branch, the Builder's `summary` and Inspector fields, and a test in `tests/test_flows.py`.
- Channels (`channels/`) never move money either: every inbound message becomes an ordinary case (`create_case` + `start`) or a small-talk reply. Replies leave only through the bus event `reply.sent`, which `Gateway.send` publishes and `Channels._on_event` delivers on the case's conversation. Every webhook checks its provider's signature (Meta `X-Hub-Signature-256` with the app secret, Twilio `X-Twilio-Signature` over the public URL, WAHA HMAC or private networks only, a token for the email forwarder and the n8n hook) before reading anything. Secrets go to the browser masked (`<field>_set`), and a secret sent as `""` keeps the saved one. `api.OPEN_PATHS` lists what the access key leaves open (provider webhooks, the call page's API, `/api/health`): a new webhook goes there and checks its own signature.
- An op (a task typed to a department, a routine run) never moves money: it calls the engine's own functions (`recalibrate`, `undo`, `trail.verify`, `benchmark.run`, reads through the gateway). A new op kind needs a `KINDS` entry and a `run_kind` branch in `ops.py`, and a test in `tests/test_office.py`. Kinds that change the model (`recalibrate`) wait for the OK (`needs_ok`).

## Layout
- `backend/nirnaya/`:
  - pipeline: `engine.py` (supersteps), `sentry_gate.py`, `pii.py`, `understand.py`, `specialists.py`, `shadow.py`, `seal.py`, `gateway.py`
  - scoring: `calibration.py`, `conformal.py`, `drift.py`
  - knowledge: `memory.py`, `graph.py`
  - replies: `replies.py`, `guard.py`
  - the office: `office.py` (`/api/office/*`), `ops.py` (tasks typed to a department, routine runs, booked tasks), `schedule.py` (plain-words schedules → next run), `routines.py` (the timetable; its tick also fires scheduled flows), `presets.py` (sample messages)
  - the team: `team.py` (presence from `/api/events?who=&client=&view=`, `POST /api/team/me` for view/focus/name, the shared chat in kv `office_chat`, and a bus listener that writes approval/rejection/undo notes into the owning agent's chat)
  - flows: `flows.py` (`/api/flows*`: node types, validation, runs walked from Start, `flow.run` events, `pipeline()` for the Live tab; kv `flows` and `flow_runs`; `on_message(ctx)` starts flows whose Start waits for messages)
  - channels (`channels/`, stdlib only: urllib, imaplib, smtplib, email): `config.py` (settings, secrets, env overrides), `hub.py` (`Channels`: conversations in kv `channel_convs`, contacts, identify, `receive`, the send queue and worker, forward, approve by email, the IMAP loop, outbound calls), `mail.py` (parse, quote stripping, robots, threaded replies; SMTP, Brevo, Resend; the IMAP `Inbox`), `whatsapp.py` (Meta Cloud API, WAHA), `voice.py` (Twilio signatures, TwiML, calls), `http.py`, `routes.py` (`/api/channels/*`, the Twilio turn-by-turn webhooks, the call page's `/api/channels/web/*`, the n8n hook)
  - other: `rails.py` (simulated bank), `benchmark.py`, `docparse.py`, `reports.py`, `llm.py`
  - serving: `api.py` (REST, SSE `/api/events`, MCP `/mcp`, serves `web/dist`)
- `backend/nirnaya/personas/*.md`: one persona per agent (front matter: `department` is one of the six, `lead: true` on each department's lead).
- Six departments (`agents.DEPARTMENTS`): intake, resolution, verification, decision, commit, oversight; each has a lead.
- `web/src/`:
  - shell and state: `App.tsx` (the office full screen when `view === "office"`, else the workspace shell), `store.ts` (external store + SSE, `onEvents` for listeners), `api.ts`
  - the office (`office/`, all original code): `scene.ts` (three.js scene, camera, people, emotes, tickets, the Brain board; positions bound HTML each frame via `scene.bind(key, el)`), `models.ts` (low-poly pieces), `layout.ts` (pods, seats, colours), `wires.ts` (SVG connector wires), `data.ts` (`/api/office` client, office store, cases and ops → cards), `OfficePage.tsx`, `Panel.tsx` (Task Status), `Rail.tsx` (department + agent chat, approvals), `Overlays.tsx` (board, Brain, calendar, big editor), `office.css`
  - workspace views: `views/*` (Workspace + Approvals, Supervisor, Brain, Ledger with Univer lazy-loaded, Benchmark, Trail, Settings)
  - channels (`channels/`): `ChannelsView.tsx` (status cards, public address, Inbox, one form per channel built from a field list, Contacts), `CallPage.tsx` (`/call`, rendered by `main.tsx` without the app shell: Web Speech API in, speechSynthesis out, typing as a fallback), `api.ts`
  - flows (`flows/`): `FlowsView.tsx` (Live | Builder), `Live.tsx` (the pipeline from `/api/flows/pipeline`), `Builder.tsx` (canvas: HTML5 drag from the palette, pointer events for moving nodes and drawing wires, pan/zoom by transform), `api.ts` (`showFlow(id)` opens a flow in the Builder from anywhere), `flows.css`
  - the team: `team.ts` (your name and browser id in localStorage `nirnaya.me`, `?as=Name`, `tellView`), `components/People.tsx` (avatars, rename popover)
- `exe/`: the Windows app. `neutralino.config.json` (window), `resources/launcher.js` (probe ports 8765–8769, reuse a running Nirnaya, else spawn the bundled `python\pythonw.exe -m nirnaya ... --exit-with NL_PID`, then `location.replace` to the server), `build.sh` (embeddable Python 3.12 + win_amd64 wheels from `requirements-win.txt`, `backend/nirnaya`, `web/dist`, NSIS), `installer.nsi` (per-user, WebView2 bootstrapper). `exe/dist/` holds the built installer (committed).
- `apk/`: the Android app. Capacitor 8 (`capacitor.config.json`: `androidScheme: http` so it can call LAN servers), `android/` (committed; manifest has `usesCleartextTraffic`), `build.sh` (web → `www/`, `cap sync`, `gradlew assembleDebug`). It is a client: the first launch shows `ServerConnect` in `OfficePage.tsx` (opens by itself when `window.Capacitor.isNativePlatform()`), which saves the address with `setApiBase`. `apk/dist/` holds the built APK (committed).
- `channels.md`: setting up real email, WhatsApp, Twilio, the call page and n8n on free tiers, with sources. Keep its field names in step with `ChannelsView.tsx`.
- `workflow.md`: the guide for a new user, from first start to the "are my agents working" checklist. `web/e2e/workflow.mjs` follows it step by step: when a label, a sample or a result text changes, change both. `run.md` is the install/run guide (the owner edits it too).
- `tools/make_icons.py`: draws every icon (exe `.ico`, installer bitmaps, Android mipmaps and launch screens) from the favicon's N.
- `docs/REPO-SCAN.md`: what was taken from each of the 18 reference repos, and why some were not merged (licences).

## Licence rules for the reference repos
Do **not** copy code from these:
- **AGPL:** OpenMontage, Recordly, codegraff
- **agents-office:** PolyForm Noncommercial; no rebranding, no fronting another agent system. The owner asked for its exact UI; copying its code was refused by this environment's safety check (a public repo and a DM sending the link are not the written permission its licence asks for). The office in `web/src/office/` is original code built from screenshots of it. Do not paste or transcribe its source, assets, fonts or marks into this repo. If the owner later has written permission from its author covering commercial use, renaming and fronting Nirnaya, it must be saved under `docs/permissions/` first, and the port must keep that project's notices.
- **Sentry server:** FSL

Use the Sentry SDKs only. Do not use pixel-agents' image assets. The MIT and Apache ones are fine to learn from or depend on (three.js, Univer, the fonts are packages). If code is ever copied, keep its licence notice.

## Behaviour worth knowing
- Drift (`drift.py`) is per action and one-sided: each action's live scores are compared with that action's own calibration scores, only once 20 have arrived, and only a shift towards *less* certain counts. Pooling every action made ordinary traffic look like drift (the mix of actions changes with whatever people send). `Inject drift` on the Supervisor still trips it.
- The ledger's outside events (`rails.natural_event`): a failed debit can get its auto-reversal, a payment that went through can get a merchant refund, each once. `POST /api/sim/rail-event` takes `event: "auto"`; ledger rows carry `can` (the event that can still land, or null). "move the ground" in the office chat uses the same rule.
- A Check node only offers ways that fit its field (`flows.OPS_FOR`): ok/route/status `is`/`is not`, result also `contains`, amount `is`/`is not`/`>`/`<` compared as numbers (₹ and commas allowed). An empty value is refused on save.
- Schedules read "every minute" / "each minute" as `{"kind": "minutes", "every": 1}`.
- Flow waits carry `flow_id`, so "Open flow" (Approvals) and "FLOW ↗" (office rail) open that flow in the Builder (via sessionStorage keys `nirnaya.flows.open` / `nirnaya.flows.tab`).
- When the open flow is deleted elsewhere, the Builder switches to another flow (or, with unsaved changes, keeps them as a new unsaved flow and says so). It picks from the data on screen, never a fresh load, so a flow saved at the same moment does not drop out of the picker.

## Gotchas
- React: a `useUI` selector must never return a fresh array or object (`?? []` loops forever; use `EMPTY` from `store.ts`).
- Univer mounts into a node React does not manage (see `Ledger.tsx`), or React throws `removeChild`.
- Shell: `pkill -f "nirnaya --port"` (or `pgrep`) matches its own command line and kills the shell. Use `pgrep -f "^python3 -m nirnaya"` (anchored, so the shell's own `bash -c` line never matches), in a command that does not also start a server.
- The SSE stream never goes idle: in Playwright wait for `load`, not `networkidle`. Chromium is preinstalled; use `playwright@1.56.1` with `channel: "chromium"`.
- The calibration fit takes about 2 s at startup (200k synthetic rows); tests share one fitted `Calibrator` via a session fixture.
- Office CSS resets use `:where(.o-root) :where(button)` on purpose: a plain `.o-root button { font: inherit }` outranks every component class and blows up the chips and buttons.
- Office keys (1–6, B, G, P, C, D, F, M, W) belong to the office; `App.tsx` ignores its own view keys while `view === "office"`. The workspace has 11 views: keys 1–9 and 0 open the first ten, Settings has none.
- Channels: a call, the call page and a webhook waiting inline read replies from the conversation's `outbox` (`wait_reply`); "I've found your account" is said together with the case's answer there (and in email), and only WhatsApp sends it on its own. A forward for approval goes out on `case.finished`, never on `approval.requested` (the case is not saved yet then, so it would read as not pending).
- Channels: only answer mail we received gets "Re:"; a new email (a flow, a test) keeps its subject. `contact_key` is `email:`, `phone:<last 10 digits>` or `id:` (a handle from n8n); a person typing a contact must give an email, 10 digits or an @handle.
- e2e: a speech-recognition mock must not call `onend` again after it has ended (Chrome does not), and `CallPage` handles each recognizer's end once anyway. WhatsApp and Twilio stand-ins are a local HTTP server; point the channel at it with `PUT /api/channels {"whatsapp": {"graph_url": …}}` / `{"voice": {"api_url": …}}` (not in the form).
- FastAPI runs sync endpoints in a thread pool: any office endpoint that starts an op or publishes events must be `async def` (ops use `asyncio.create_task`).
- e2e: the recalibration step rejects on purpose (approving would teach the model from the test's own labels and change later routes). Checks select approval packets by `data-case` / `data-op`, never "the last one".
- Fonts are bundled (`@fontsource/inter`, `@fontsource/instrument-serif`), so the office looks the same offline and in the phone build.
- Every fetch and link must go through `apiBase()` (`api.ts`): the APK serves the app from `http://localhost`, so a bare `/api/...` would hit the phone, not the server.
- `bus.publish(kind, id=...)` overwrites the event's own sequence id (the envelope is `{"id", "ts", "kind", **data}`). Use `op_id=`, `flow_id=` and so on.
- `presence` events are not kept in the bus history (they would push real work out of `/api/events/recent`, which the office replays into ACTIVITY on load). The store handles them before any `onEvents` listener.
- Bus listeners (`bus.listen`) run inside `publish`, often while the engine holds a case lock: keep them to quick store writes and further publishes, never engine calls.
- The office chat is server-side now: never add user or agent messages with `say()` (that is for this-browser-only prompts and errors). Approval notes come from `team._on_event`, not from the button handlers.
- `Panel.tsx` renders its hint and row meta with `dangerouslySetInnerHTML`: anything a person typed or named (task text, names, server error text) goes through `esc()` from `office/data.ts`.
- Under swiftshader every click in the 3D office takes about 2 s (Playwright waits for stable frames). Give office clicks 6 s or more in scripts.
- Office name tags are anchored on the head *without* the breathing bob (`r.pin`), rounded to whole pixels, and pushed apart when they would overlap (`placeBinds`). A tag that moves every frame never counts as stable, and Playwright's click waits for it forever.
- Office status chips and their meta line both contain words like DONE/WAITING/REFUSED: in tests select `.o-row[data-id=…] .o-st`, not `getByText("DONE")`. Filter tabs are named "All 12" (with a space): match `/^All\s*\d+$/`.
- Flows canvas: `overflow: clip`, not just hidden. Focus and Playwright's scroll-into-view can scroll an `overflow: hidden` box, which shifts the world under the pointer maths. Pointer capture on the canvas swallows clicks on the zoom buttons, so `onBgDown` ignores `.fl-zoom`. SVG `<text>` (wire labels) has no `innerText`: read `textContent`.
- `newOp` in tests: quiet routines (drift check, TAT watch) create ops too; match on `by` or the routine id.
- A POST that starts something (Flows **Run**) answers with the thing as it started, and its live events (`flow.run`) can arrive first on a busy server. Never let the response overwrite a copy that events already delivered (the Builder keeps the event copy).
- Office menus (department, samples) close on Escape and on a click outside; the window key handler would otherwise send Escape to `overview()` and leave the menu covering the panel.
- EXE: numpy's Windows wheels call `ucrtbase.crealf`, which wine 9 lacks. Test with wine 10+ (WineHQ `wine-stable-amd64` + the `i386-windows` DLLs from `wine-stable-i386`, extracted with `dpkg -x`, are enough; the i386 apt deps do not resolve on noble). NSIS installers are 32-bit, hence the i386 DLLs.
- EXE: Neutralino's `os.spawnProcess` runs `cmd.exe /c "<command>"` on Windows, so the command is `"<path>\pythonw.exe" -m nirnaya --db "<path>" ...` with each path quoted; cmd strips only the outer pair. `NL_PATH` can be relative (`.`): resolve it with `filesystem.getAbsolutePath`.
- EXE: `neu build` uses and deletes `exe/.tmp`; never keep anything there. Neutralino ignores the window close unless it is a real WM_DELETE_WINDOW (xdotool `windowclose` destroys the window instead; use python-xlib to send the message).
- EXE: pip `--platform win_amd64` still reads environment markers for the build machine, so Windows-only dependencies (colorama, tzdata) are listed in `requirements-win.txt` by hand.
- APK: no KVM in the cloud box, so no emulator; `aapt2 dump badging` / `apksigner verify` plus `e2e/phone-client.mjs` are the checks. The server cannot run on the phone: pydantic-core has no Android wheels (Chaquopy or PyPI).

## Next
Web app (done), 3D office as home (done), Windows installer in `exe/` (done), Android APK in `apk/` (done, client of a server), team presence and shared chat (done), Flows Live + Builder (done), real channels: email, WhatsApp, Twilio calls, the call page, n8n webhooks, an access key (done; tested against stand-ins and GreenMail, not yet with the owner's real accounts).
Still to do: connect the owner's real Gmail, Meta app and Twilio trial (channels.md lists what is needed); open the EXE on real Windows and the APK on a real phone (neither could run here); code-sign the EXE; a release keystore for the APK; an optional "share on Wi-Fi" switch in the desktop app so a phone can use its server (it listens on 127.0.0.1 only today; set `NIRNAYA_ACCESS_KEY` before exposing a server).
