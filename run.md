# Nirnaya — run guide

Commands from a fresh clone through web, Android APK, and Windows EXE. Also how to open the database and talk to the agents.

**Needs:** Python **3.10+** (3.11 recommended on Windows), Node **22**, Git. On Windows use `py -3.11` (or the full path to `python.exe`) if `python` / `python3` is missing from PATH. `make` is optional — the same steps work without it.

---

## 0. Clone once

```bash
git clone <this-repo-url> Agent_Teammate
cd Agent_Teammate
```

Optional env (everything else works offline on the simulated bank):

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude refines understanding and drafts replies |
| `NIRNAYA_MODEL` | Model id (default `claude-opus-5-5`) |
| `NIRNAYA_LLM` | `off` or `auto` |
| `NIRNAYA_DB` | Override SQLite path |
| `NIRNAYA_STEP_DELAY` | Animation pacing (`0` in tests) |
| `SENTRY_DSN` / `VITE_SENTRY_DSN` | Error monitoring |
| `NIRNAYA_WEB` | Folder with built web assets |

---

## 1. Web portal (first install → run)

### Install

```bash
# with Make
make install

# or by hand (Windows-friendly)
py -3.11 -m pip install -e "backend[dev,llm,docs,monitoring]"
cd web && npm ci && cd ..
```

### Run (production build + API on one port)

```bash
# with Make
make run
# → http://127.0.0.1:8000

# or by hand
cd web && npm run build && cd ..
cd backend && py -3.11 -m nirnaya --port 8000
```

Open **http://127.0.0.1:8000** — the 3D office is the home screen.

### Run (dev: hot reload)

```bash
# with Make (API :8000, Vite :5173; Vite proxies /api and /mcp)
make dev

# or two terminals on Windows
# terminal A:
cd backend
py -3.11 -m uvicorn "nirnaya.api:create_app" --factory --reload --port 8000

# terminal B:
cd web
npm run dev
# → http://127.0.0.1:5173
```

### Useful server flags

```bash
py -3.11 -m nirnaya --host 127.0.0.1 --port 8000
py -3.11 -m nirnaya --host 0.0.0.0 --port 8000   # LAN (for the phone APK)
py -3.11 -m nirnaya --db "C:\path\to\nirnaya.db"
py -3.11 -m nirnaya --web "..\web\dist"
py -3.11 -m nirnaya --reset                       # wipe DB and start empty
py -3.11 -m nirnaya --log nirnaya.log             # file log (desktop / no console)
```

### Quick try in the UI

1. Open the office → Task Status (right).
2. Pick a customer → **SAMPLES** → choose one → **ADD**.
3. Keys: **1–6** departments · **B** board · **G** Brain · **P** calendar · **C** chat with lead · **D** dark · **W** workspace.

### Health check

```bash
curl http://127.0.0.1:8000/api/health
```

### Docker (optional)

```bash
docker build -t nirnaya .
docker run -p 8000:8000 -v nirnaya:/data nirnaya
```

---

## 2. Android APK

The APK is a **client**. It does not run the Python server on the phone. You need a Nirnaya server on the same Wi‑Fi (or hosted).

### Use the prebuilt APK

1. Copy `apk/dist/Nirnaya-0.1.0.apk` to the phone.
2. Allow “install unknown apps” for the app you opened it from. Needs Android 7.0+.
3. On a PC on the same Wi‑Fi, start a server that listens on the network:

```bash
cd backend
py -3.11 -m nirnaya --host 0.0.0.0 --port 8000
```

4. Find the PC’s LAN IP (`ipconfig` on Windows, `ip addr` on Linux), e.g. `192.168.1.20`.
5. Open Nirnaya on the phone → enter `192.168.1.20:8000` → **CONNECT**.  
   Change later: Workspace → Settings → Server.

> The Windows EXE server listens on `127.0.0.1` only — the phone cannot use it. Use `--host 0.0.0.0` as above. Only do that on a network you trust (no login on the server).

### Build the APK yourself

Needs Node 22, JDK 21, Android SDK (platform 36, build-tools 36):

```bash
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
make apk
# or: bash apk/build.sh
# → apk/dist/Nirnaya-<ver>.apk
```

Release signing (optional): set `NIRNAYA_KEYSTORE`, `NIRNAYA_KEYSTORE_PASS`, `NIRNAYA_KEY_ALIAS`, `NIRNAYA_KEY_PASS`.

More detail: [apk/README.md](apk/README.md).

---

## 3. Windows EXE

### Use the prebuilt installer

1. Run `exe/dist/Nirnaya-Setup-0.1.0-x64.exe` (64-bit Windows 10/11, no admin).
2. If SmartScreen appears: **More info → Run anyway** (not code-signed yet).
3. Launch from Start menu / desktop shortcut.

The window starts a bundled server on a free port in **8765–8769** and opens the same office UI. Data lives under `%LOCALAPPDATA%\Nirnaya` (`nirnaya.db`, `nirnaya.log`).

To use Claude: set `ANTHROPIC_API_KEY` in Windows user environment variables, then reopen Nirnaya.

### Build the installer yourself

On Linux/WSL (needs `nsis`, Node 22, Python + pip):

```bash
sudo apt install nsis unzip curl
make exe
# or: bash exe/build.sh
# → exe/build/Nirnaya/ and exe/dist/Nirnaya-Setup-<ver>-x64.exe
```

More detail: [exe/README.md](exe/README.md).

---

## 4. Database

SQLite. Default location when you run from source:

| How you run | DB path |
|---|---|
| `python -m nirnaya` / `make run` | `backend/data/nirnaya.db` |
| Env `NIRNAYA_DB` or `--db PATH` | that path |
| Windows EXE | `%LOCALAPPDATA%\Nirnaya\nirnaya.db` |
| Docker volume `nirnaya:/data` | inside the container under `/data` (see image) |

### Open it

```bash
# CLI
sqlite3 backend/data/nirnaya.db
.tables
.schema
```

Or any SQLite GUI (DB Browser for SQLite, VS Code SQLite extension) → open the `.db` file.

### Reset

```bash
py -3.11 -m nirnaya --reset --port 8000
# deletes the DB (and -wal/-shm) then starts fresh
```

### Useful API reads (same data the UI uses)

```bash
curl http://127.0.0.1:8000/api/cases
curl http://127.0.0.1:8000/api/trail
curl http://127.0.0.1:8000/api/ledger
curl http://127.0.0.1:8000/api/graph
curl "http://127.0.0.1:8000/api/memory/search?q=upi"
curl http://127.0.0.1:8000/api/supervisor
```

In the UI: **W** → Cases / Trail / Ledger / Brain / Supervisor.

---

## 5. Agents & departments

Nineteen agents in six departments (order a case meets them). Each lead takes work typed to that department when no specialist fits.

| Department | Lead | Agents |
|---|---|---|
| **Intake** | triage | triage, pii (Tokeniser), sentry |
| **Resolution** | upi | upi, refund, fraud, kyc |
| **Verification** | evidence | evidence, shadow, recheck |
| **Decision** | router | router, calibrator, seal |
| **Commit & Reply** | commit | commit, guard, responder |
| **Oversight** | human | human (Support Lead), trail, drift |

Personas live in `backend/nirnaya/personas/*.md`.

### In the office UI

- Click a **department** or **agent** → left rail (deliverables, approvals, chat).
- Task Status: pick a department, type a sentence, **ADD** (customer message for Intake/Resolution; ops/routines for others).
- Examples: Oversight → *verify the audit trail*; Decision → *run the benchmark*; *every weekday at 9am, write today's digest*.

### List agents (API)

```bash
curl http://127.0.0.1:8000/api/state
# → agents[], departments[], cases[], customers[], presets[], …
curl http://127.0.0.1:8000/api/office
```

### Chat with one agent

```bash
curl -X POST http://127.0.0.1:8000/api/agents/upi/ask ^
  -H "Content-Type: application/json" ^
  -d "{\"question\": \"What did you last do?\"}"

# Unix:
# curl -X POST http://127.0.0.1:8000/api/agents/upi/ask \
#   -H "Content-Type: application/json" \
#   -d '{"question":"What did you last do?"}'
```

Office chat (same idea):

```bash
curl -X POST http://127.0.0.1:8000/api/office/chat ^
  -H "Content-Type: application/json" ^
  -d "{\"agent_id\": \"human\", \"message\": \"verify the audit trail\"}"
```

### Submit a case (Intake path)

```bash
curl -X POST http://127.0.0.1:8000/api/cases ^
  -H "Content-Type: application/json" ^
  -d "{\"customer_id\": \"C001\", \"message\": \"UPI debit failed but money left my account\"}"
```

Customer ids come from `/api/state` → `customers`.

### MCP (other agents calling Nirnaya)

Endpoint: **`POST /mcp`**. Tools include `submit_case`, `case_status`, `graph_search`, `memory_search`, `score_action`, plus read tools for UPI/bank/refund/CRM.

---

## 6. Tests (optional)

```bash
# backend (~43 tests)
cd backend && py -3.11 -m pytest -q

# web typecheck + build
cd web && npx tsc -b --noEmit && npm run build

# e2e needs a server on :8000
# terminal A: make run / py -3.11 -m nirnaya
# terminal B:
cd web && npm run e2e
cd web && node e2e/phone-client.mjs   # phone-sized client flow
```

---

## Cheat sheet

| Goal | Command |
|---|---|
| First install | `make install` or pip + `npm ci` above |
| Open web portal | `make run` → http://127.0.0.1:8000 |
| Dev hot reload | `make dev` → :5173 + :8000 |
| Phone APK | install `apk/dist/Nirnaya-0.1.0.apk` + server `--host 0.0.0.0` |
| Windows EXE | run `exe/dist/Nirnaya-Setup-0.1.0-x64.exe` |
| Rebuild APK / EXE | `make apk` / `make exe` |
| Database file | `backend/data/nirnaya.db` (or EXE path above) |
| Agents list | `GET /api/state` or click desks in the office |
| Agent chat | `POST /api/agents/{id}/ask` or click agent → chat |
