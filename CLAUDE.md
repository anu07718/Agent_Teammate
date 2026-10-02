# Nirnaya: notes for Claude

## Standing rules from the owner
- Commit and push as **karthikj30 <karthikjanardhan5@gmail.com>**. Work on **main** and push to main; main is the default branch.
- The product is **Nirnaya** (never "Nirnay"; the deck and diagrams were renamed too).
- Deck and slide text: never name other projects' owners or organisations, no framework names, nothing from the earlier NSE idea. It is a new project.
- **Free tiers only.** Every service the app uses must work on a free plan with no card (free.md lists them). No paid APIs: Anthropic's API was removed at the owner's request; the language model is Groq, Gemini, OpenRouter `:free` models, Mistral's Experiment plan, Ollama or another local OpenAI-compatible server. Twilio is a trial only and is labelled so. Shared workspaces use Firebase Realtime Database on the Spark plan.
- **No real money, ever.** Real UPI payments come from Razorpay's free test mode only: `pg.py` refuses `rzp_live_` keys. The demo bank is labelled "Demo bank" everywhere it shows; never present it as real. docs/upi.md is the brief for judges' questions (what is real, why, the production path, RBI TAT and data rules): keep it true to the code.
- Slide copy is short points, and each slide says something new. Keep deck numbers consistent: autonomy ~30% → 55–65% (target), ₹3–6 vs ₹40–60 per case, ₹6–12 per resolution and ₹0 on escalations, first reply under 5 s, risk check under 200 ms, α as low as 0.2%.

## Commands
```bash
make install                      # pip install -e backend[...] + npm ci in web/
make test-all                     # tools/test-all.sh: pytest, build, every e2e suite on its own fresh server (+ a keyed or second one on PORT+1), GreenMail and the Firebase emulator started if needed → test-results/<target>/report.md; TARGET=exe|apk, QUICK=1, SUITES="run workflow"
make run                          # build web, serve API + web on :8000
make dev                          # API :8000 (reload) + Vite :5173 (proxies /api and /mcp)
cd backend && python -m pytest -q # 108 tests, about 75 s (8 in tests/test_pg.py against a Razorpay stand-in, 5 in tests/test_feed.py; the GreenMail one and the real-model one skip without their servers)
cd web && npx tsc -b --noEmit && npm run build
cd web && npm run e2e             # needs a server on :8000; 17 browser checks (software WebGL flags are in the script)
cd web && node e2e/phone-client.mjs  # the APK's flow at phone size, 8 checks (needs a server and web/dist; APP_DIST= the APK's assets/public, KEYED_URL= a keyed server)
cd web && node e2e/flows.mjs      # Flows: drag and drop, wire, save, run, approve on the node; 9 checks
cd web && node e2e/team.mjs       # two people (?as=Asha, ?as=Ravi): presence, shared chat, names, shared flows; 9 checks
cd web && node e2e/audit.mjs      # every view and button in dark/light, desktop/phone: errors, failed requests, clipped text, fonts (~10 min; OFFICE=0 skips the office click pass, which run.mjs and team.mjs cover)
cd web && node e2e/workflow.mjs   # workflow.md followed by a new user, step by step; 15 checks (make e2e-workflow)
cd web && node e2e/fields-office.mjs     # every office control and option, each result checked on the server; 19 checks, ~25 min
cd web && node e2e/fields-workspace.mjs  # every workspace view, input, select and button, the CSV import; 25 checks
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
the model keys `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `OLLAMA_HOST`, `NIRNAYA_LLM_URL/KEY/MODEL`, `NIRNAYA_LLM_ORDER`,
`NIRNAYA_RAZORPAY_KEY_ID`, `NIRNAYA_RAZORPAY_KEY_SECRET`, `NIRNAYA_RAZORPAY_WEBHOOK_SECRET`, `NIRNAYA_RAZORPAY_API_URL` (a stand-in), `NIRNAYA_IMPORT_MAX_AMOUNT` (default 100000), `SENTRY_DSN`, `VITE_SENTRY_DSN`, `NIRNAYA_WEB`,
`NIRNAYA_ACCESS_KEY` (locks the API: header `X-Nirnaya-Key`, cookie `nirnaya_key` or `?key=`), and any channel
setting as `NIRNAYA_<CHANNEL>_<FIELD>` plus `NIRNAYA_PUBLIC_URL` and `NIRNAYA_UNKNOWN` (they lock that field in the UI).

## Invariants: do not break these
- Money moves **only** through `Gateway.execute_sealed`: seal match, ownership, policy cap, unused idempotency key. Never call `rails.reverse/refund/wallet_credit` from anywhere else.
- Models and the UI see **tokenised** text only (`pii.Tokeniser`). Only the gateway detokenises.
- A payment with `source == "razorpay_test"` is a real gateway payment: any money-moving action on it routes **ESCALATE** (`engine._route_one`), the evidence step reads it live first (`pg.payment`), `execute_sealed` refreshes it from Razorpay before the seal check (so a change at Razorpay breaks the seal), and the refund goes through `pg.refund_for` (only from `Gateway._run_action`) with the idempotency key in `receipt` and `notes.nirnaya_idem`, after checking Razorpay's own refunds for it. Its receipt has no undo. Outside events (`natural_event`, `outside_event`) only land on demo payments.
- Fed data (`feed.py`) is checked row by row and never trusted: a new check goes in `feed.check` with a test in `tests/test_feed.py`. Every fed row keeps `source`, `batch` and `file` so it can be removed; after any data change call `api._data_changed` (rebuilds the Brain graph).
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
  - the language model: `llm.py` (stdlib OpenAI-compatible client; providers in `PROVIDERS`, tried in the saved order; a 429 rests a provider for its Retry-After; `extract_json`/`normalise_extract` make small models' answers safe; settings in kv `llm`, env wins; `/api/llm`, `/api/llm/test/{id}`; `summary()` feeds the top bars)
  - shared workspaces: `relay.py` (the host side: `Firebase` REST + SSE client on http.client with proxy support, `Relay` answers `/w/<code>/req` by calling the app in-process (`call_app`), batches bus events into `/w/<code>/ev/s0..s15`, heartbeats `/w/<code>/host`, maps `/w/<code>/members` into `Team.remote`; `DENY` lists what only the host may do; `probe` refuses databases with open rules; kv `workspace` keeps the code across restarts; `/api/workspace*`). Rules: `firebase/database.rules.json`
  - real payments and fed data: `pg.py` (Razorpay test mode: `Razorpay` client on urllib, `PG` settings in kv `pg` with masked secrets, `sync`/`refresh` map payments onto ledger txns and customers, `webhook` checks `X-Razorpay-Signature` and dedupes event ids in kv `pg_events`, `refund_for`, `link_for`; `/api/pg*`), `feed.py` (CSV templates, `check` = preview, `commit`, batches; `/api/data*` in api.py)
  - other: `rails.py` (the demo bank, plus `add_customer`, `upsert_external`, `remove_fed`, `set_demo`; every row has `source`: demo, import or razorpay_test), `benchmark.py`, `docparse.py`, `reports.py`
  - serving: `api.py` (REST, SSE `/api/events`, MCP `/mcp`, serves `web/dist`)
- `backend/nirnaya/personas/*.md`: one persona per agent (front matter: `department` is one of the six, `lead: true` on each department's lead).
- Six departments (`agents.DEPARTMENTS`): intake, resolution, verification, decision, commit, oversight; each has a lead.
- `web/src/`:
  - shell and state: `App.tsx` (the office full screen when `view === "office"`, else the workspace shell), `store.ts` (external store + SSE, `onEvents` for listeners), `api.ts`
  - the office (`office/`, all original code): `scene.ts` (three.js scene, camera, people, emotes, tickets, the Brain board; positions bound HTML each frame via `scene.bind(key, el)`), `models.ts` (low-poly pieces), `layout.ts` (pods, seats, colours), `wires.ts` (SVG connector wires), `data.ts` (`/api/office` client, office store, cases and ops → cards), `OfficePage.tsx`, `Panel.tsx` (Task Status), `Rail.tsx` (department + agent chat, approvals), `Overlays.tsx` (board, Brain, calendar, big editor), `office.css`
  - workspace views: `views/*` (Workspace + Approvals, Supervisor, Brain, Ledger with Univer lazy-loaded and `FeedCards.tsx` (the Razorpay card and the CSV import card), Benchmark, Trail, Settings)
  - channels (`channels/`): `ChannelsView.tsx` (status cards, public address, Inbox, one form per channel built from a field list, Contacts), `CallPage.tsx` (`/call`, rendered by `main.tsx` without the app shell: Web Speech API in, speechSynthesis out, typing as a fallback), `api.ts`
  - flows (`flows/`): `FlowsView.tsx` (Live | Builder), `Live.tsx` (the pipeline from `/api/flows/pipeline`), `Builder.tsx` (canvas: HTML5 drag from the palette, pointer events for moving nodes and drawing wires, pan/zoom by transform), `api.ts` (`showFlow(id)` opens a flow in the Builder from anywhere), `flows.css`
  - one look for both: `index.css` holds the palette (`--o-*`, paper in `:root`, near-black in `.dark`) and maps the workspace tokens onto it (`--bg`, `--panel`, `--fg`, `--muted`, `--line`, …), plus `caps` (10px, 600, 0.16em, uppercase labels), `serif`, `page-title`, `shadow-card`, `o-live`. `components/TopBar.tsx` has the pieces both top bars share (`Clock`, `ThemeToggle`, `ConnTiles`); the workspace header in `App.tsx` uses the office's `o-top` classes (`o-top-static` keeps it in the page flow). `ui.tsx` buttons, badges and tabs are caps pills in the same style. One theme in `store.ts` (`theme`, saved as `nirnaya.theme`): the D key in the office and the sun/moon tile in either bar switch it everywhere
  - shared workspaces, the member side: `relay.ts` (joined state in localStorage `nirnaya.joined`; `relayFetch` turns a fetch into a request under the database and waits for its answer on an EventSource; `relayEvents`; presence heartbeats), `net.ts` (the native fetch, before `api.ts` wraps it), `components/Collab.tsx` (the person+ tile, the Work together dialog, the IN … pill; `own()` talks to this device's own server with the native fetch). `api.ts`'s fetch wrapper routes every `/api/` URL through the relay while joined; `store.connect` and `team.tell` switch too
  - the team: `team.ts` (your name and browser id in localStorage `nirnaya.me`, `?as=Name`, `tellView`), `components/People.tsx` (avatars, rename popover)
- `exe/`: the Windows app. `neutralino.config.json` (window), `resources/launcher.js` (probe ports 8765–8769, reuse a running Nirnaya, else spawn the bundled `python\pythonw.exe -m nirnaya ... --exit-with NL_PID`, then `location.replace` to the server), `build.sh` (embeddable Python 3.12 + win_amd64 wheels from `requirements-win.txt`, `backend/nirnaya`, `web/dist`, NSIS), `installer.nsi` (per-user, WebView2 bootstrapper). `exe/dist/` holds the built installer (committed).
- `apk/`: the Android app. Capacitor 8 (`capacitor.config.json`: `androidScheme: http` so it can call LAN servers), `android/` (committed; manifest has `usesCleartextTraffic`), `build.sh` (web → `www/`, `cap sync`, `gradlew assembleDebug`). It is a client: the first launch shows `ServerConnect` in `OfficePage.tsx` (opens by itself when `window.Capacitor.isNativePlatform()`), which saves the address with `setApiBase`. `apk/dist/` holds the built APK (committed).
- `free.md`: every external service and its free tier (language models, the relay database, hosting the website, channels). Keep it in step with `llm.PROVIDERS` and the rules file.
- `web/vercel.json`, `web/.env.example`: the website on Vercel (root `web`, `VITE_NIRNAYA_RELAY` built in).
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
- FastAPI + `from __future__ import annotations`: import `Request`, `Body` and friends at module top, and define pydantic body models at module level, never inside `create_app` or a function. Otherwise the annotation is a string FastAPI cannot resolve and the endpoint answers 422 for every request.
- Razorpay stand-in for tests and screenshots: `tests/test_pg.py::FakeRazorpay` is a real local HTTP server (same paths, Basic auth, refund rules); `pay()` adds a payment. Point the app at it with `NIRNAYA_RAZORPAY_API_URL`.
- The CSV formula check (`=`, `+`, `-`, `@` first) skips cells that are valid phones or amounts, or `+91 …` numbers would be refused.
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
- `office.css` is not in a Tailwind layer, so its display rules (`.o-lab`, `.o-tile`, `.o-btn`, `.o-gauge`, `.o-conn`, `.o-brand` sizes) beat any Tailwind utility on the same element. To hide or resize an `o-*` element at a breakpoint use the important form: `max-md:hidden!`, `max-sm:text-[19px]!`. Check the workspace header at 360–1920 px in both themes after adding anything to it.
- Labels are uppercased by CSS (`caps`, `o-caps`): Playwright's `getByRole`/`getByText` names keep the source case, but `innerText()` returns the capitals, so regexes over `innerText` need the `i` flag.
- The dark palette is `html.dark` in index.css (and Tailwind's `dark:` variant is `html.dark *`), never a bare `.dark`: the office has `.o-btn.dark` / `.o-actbtn.dark` buttons, and a bare `.dark` selector turned those buttons themselves into the dark palette.
- Relay: a multi-path update (the host's answer plus removing the request in one PATCH) reaches a listener as an SSE `patch` event, not `put`: listen to both (`onTree` in relay.ts, `Firebase.stream` in relay.py). Numeric child keys come back as JSON arrays, so slots are `s0`..`s15`. The request flag for "can unpack compressed answers" is `za`; `z` is a compressed body.
- Relay timing in tests: with the 3D office open under swiftshader, a relayed request takes about 1 s (the page's main thread is busy rendering); with the office closed it takes about 20 ms. The Firebase emulator starts every new namespace with open rules; the test fixture loads `firebase/database.rules.json` into `demo-nirnaya`.
- Fonts are bundled (`@fontsource/inter`, `@fontsource/instrument-serif`), so the office looks the same offline and in the phone build.
- Every fetch and link must go through `apiBase()` (`api.ts`): the APK serves the app from `http://localhost`, so a bare `/api/...` would hit the phone, not the server.
- `bus.publish(kind, id=...)` overwrites the event's own sequence id (the envelope is `{"id", "ts", "kind", **data}`). Use `op_id=`, `flow_id=` and so on.
- `presence` events are not kept in the bus history (they would push real work out of `/api/events/recent`, which the office replays into ACTIVITY on load). The store handles them before any `onEvents` listener.
- Bus listeners (`bus.listen`) run inside `publish`, often while the engine holds a case lock: keep them to quick store writes and further publishes, never engine calls.
- The office chat is server-side now: never add user or agent messages with `say()` (that is for this-browser-only prompts and errors). Approval notes come from `team._on_event`, not from the button handlers.
- `Panel.tsx` renders its hint and row meta with `dangerouslySetInnerHTML`: anything a person typed or named (task text, names, server error text) goes through `esc()` from `office/data.ts`.
- Under swiftshader every click in the 3D office takes about 2 s (Playwright waits for stable frames). Give office clicks 6 s or more in scripts.
- Office department cards (`scene.placeBinds`): they scale with the room (`room`, down to 0.7 of full size below about 1150 × 830 px of office), stay clear of the bar, the panel, the key hints (shown above 1180 px wide) and the zoom buttons (`opts.obstacles`), and a card that would cover one already placed moves up, down or sideways to a free spot. Check new office chrome against cards at 1024–1920 px widths: nothing should overlap.
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
Web app (done), 3D office as home (done), Windows installer in `exe/` (done), Android APK in `apk/` (done, client of a server), team presence and shared chat (done), Flows Live + Builder (done), real channels: email, WhatsApp, Twilio calls, the call page, n8n webhooks, an access key (done; tested against stand-ins and GreenMail, not yet with the owner's real accounts), free language models instead of Anthropic (done; tested against stand-ins and a real local Llama 3.2 1B llamafile, not yet with the owner's Groq/Gemini keys), shared workspaces by code through Firebase Realtime Database (done; tested against Google's emulator with the real rules, not yet on the owner's Firebase project).
Real UPI payments from Razorpay test mode and the CSV import with guardrails (done; tested against the Razorpay stand-in, not yet with the owner's own test keys).
Still to do: try the owner's Razorpay test keys end to end (a payment link paid with `success@razorpay`, then a refund); the owner creates the Firebase project and pastes its address (free.md), then build it in with `VITE_NIRNAYA_RELAY` and deploy `web/` to Vercel (offer to do it with the Vercel connector once the address exists); connect the owner's real Gmail, Meta app and Twilio trial (channels.md lists what is needed); open the EXE on real Windows and the APK on a real phone (neither could run here); code-sign the EXE; a release keystore for the APK; an optional "share on Wi-Fi" switch in the desktop app so a phone can use its server (it listens on 127.0.0.1 only today; set `NIRNAYA_ACCESS_KEY` before exposing a server).
