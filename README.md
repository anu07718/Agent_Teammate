# Nirnaya

**The support teammate that knows when to stop.**

Paytm AI Hackathon · Track 3: Autonomous AI Teammates

Nirnaya resolves payment-support cases end to end (failed UPI debits, refunds, duplicate charges,
unauthorised transactions) and decides, per action, whether it may act alone. It acts when a calibrated
score clears a threshold certified to keep wrong autonomous actions under a ceiling α. It hedges (acts
with an undo) when the action is reversible. It escalates with a sealed evidence packet otherwise, and
refuses what should never run.

![The Nirnaya office](docs/screenshots/office.png)

## Run it

```bash
make install      # Python backend (editable) + web dependencies
make run          # builds the web app, serves everything on http://127.0.0.1:8000
```

Or with Docker: `docker build -t nirnaya . && docker run -p 8000:8000 -v nirnaya:/data nirnaya`.

Development with hot reload: `make dev` (API on :8000, web on :5173).
Optional: `ANTHROPIC_API_KEY` to let Claude refine understanding and draft replies (rules run without it),
`SENTRY_DSN` / `VITE_SENTRY_DSN` for error monitoring. Everything else works offline on a simulated bank.

Try it from the office's Task Status bar: pick a customer, press **SAMPLES**, choose one, press **ADD**.
- a failed UPI debit three days late gets reversed with ₹100/day compensation, on its own
- a duplicate charge is refunded with an undo
- an unauthorised ₹18,500 blocks the UPI ID at once and parks the credit for a human: the Risk desk
  stands up and waves, and its chat holds the sealed evidence packet with APPROVE / REJECT
- an injection attempt is refused

Then say *move the ground* in that chat and try to approve. The Seal no longer matches the ledger, so the
old approval does not apply and the case is checked again.

Other departments take tasks in plain words: pick **OVERSIGHT** and type *verify the audit trail*, pick
**DECISION** and type *run the benchmark*, or put one on the timetable: *every weekday at 9am, write
today's digest*.

## The app

**The office** is the home screen: a 3D office where the 19 agents sit at desks in six departments around
the Brain, in the order a case meets them (Intake → Resolution → Verification → Decision → Commit &
Reply → Oversight).

- **Department cards** float over every pod with that department's real numbers and DOING / NEXT / DONE.
- **The top bar** shows the systems Nirnaya is connected to (UPI switch, core banking, refund engine,
  CRM, wallet, disputes, card and UPI controls, messaging). A tile pulses and a dot rides the wire into
  the department whenever a tool is called; a tile goes grey during an outage or when its circuit opens.
- **The Task Status panel** on the right takes a sentence for any department (a customer message for
  Intake or Resolution, a task for the others, or a routine with its schedule in words) and reads back
  who will take it before you press ADD. Below it, every case and task as a live card.
- **Click a department or an agent** to fly in: the rail on the left shows the agent's deliverables,
  anything waiting for your OK (the sealed packet), and a chat grounded in what it actually did.
- Case tokens travel between departments as the case moves, desks show their last lines on screen,
  and the Brain glints on the nodes the Evidence desk reads.
- Keys: **1–6** departments · **B** the company board · **G** the Brain · **P** the calendar (click a day
  to book a task or start a routine) · **C** chat with the lead · **D** dark mode · **W** the workspace.

| ![Approval at the Risk desk](docs/screenshots/office-approval.png) | ![The office in dark mode](docs/screenshots/office-dark.png) |
|---|---|

**The workspace** (W, or the WORKSPACE button) is the operator's view:

| View | What it is for |
|---|---|
| **Office** | Back to the 3D office |
| **Cases** | An IDE-style workspace: cases grouped by state, tabs per case. Each case shows its superstep timeline, conversation, evidence, decision (score vs certified threshold), shadow diff, seal, audit trail and checkpoint chain |
| **Approvals** | Sealed evidence packets: approve, edit or reject. Every decision becomes a training label |
| **Supervisor** | Per-action error ceiling α and autonomy rung, certified thresholds per amount band, the reliability diagram, deflection vs precision, drift monitor, routines |
| **Brain** | Context graph (customers, accounts, UPI IDs, transactions, merchants, cases, policies) and case memory with what held |
| **Ledger** | The simulated live systems as a spreadsheet; outages and outside events to test resilience |
| **Benchmark** | Simulated customers, pass^k over paraphrases, experiment history |
| **Trail** | Hash-chained audit log with verification and a tamper test |
| **Settings** | Server address (for the phone and desktop builds), integrations, MCP config, evidence parsing, crash-and-restart |

| ![Cases](docs/screenshots/workspace.png) | ![Supervisor](docs/screenshots/supervisor.png) |
|---|---|

## How a case runs

`intake → understand → evidence → plan → calibrate → shadow → route → commit → respond → learn`,
with a checkpoint after every step. Each checkpoint is chained to the previous one and stamped with the
workflow and policy hashes.

1. **Intake.** The PII tokeniser swaps phone, card, account, UPI ID, PAN and Aadhaar for format-preserving
   tokens. **Sentry** screens for injection, credential sharing, velocity and outsized amounts in under
   200 ms, with no model on the path.
2. **Understand.** Intent and details in English and Hinglish; Claude refines them when configured.
3. **Evidence.** Parallel read-only calls through the Tool Gateway to the UPI switch, core banking, the
   refund engine and the CRM, plus similar past cases and the context graph.
4. **Plan.** A specialist (UPI disputes, refunds, risk, accounts) proposes typed actions. A plan cannot
   move money.
5. **Calibrate.** A logistic model scores each action; isotonic calibration makes the score mean what it
   says. On held-out data, expected calibration error drops from 0.051 (stated confidence) to 0.004.
6. **Shadow.** The plan runs on a copy of the ledger; a recheck confirms the live systems have not moved.
7. **Route.** Learn-then-Test thresholds per action and amount band: with 95% confidence, wrong autonomous
   actions stay under α. Bigger amounts get a stricter α. Where nothing can be certified, the action never
   runs alone.
8. **Commit.** Only through the Gateway, and only if all of these hold:
   - the Seal H(payload ‖ recheck ‖ ledger version ‖ policy hash) matches the live ledger
   - the account belongs to the customer
   - the amount is within the policy cap
   - the idempotency key is unused

   Commits are exactly-once, and three failures open a tool's circuit breaker.
9. **Respond.** Every amount and reference in the reply must appear in the evidence, and nothing may
   promise more than policy allows (Promise Guard).
10. **Learn.** A hash-chained trail. The drift monitor halves every α and caps autonomy when live cases
    stop looking like the calibration set.

A parked case waits in its checkpoint, not in memory: restart the process and the approval still lands on
exactly what was sealed. Other agents can use Nirnaya over **MCP** at `/mcp`: they can submit cases,
read status, search the graph and memory, or score an action.

## Tests

```bash
make test-backend   # 42 tests: the α ceiling on fresh data, stale approvals refused, exactly-once commits,
                    # restart durability, checkpoint chaining, tamper detection, drift fail-closed, MCP, HTTP,
                    # office ops, plain-words schedules, routines, the Brain graph and agent chat
make test-web       # typecheck + production build
make run & make e2e # drives the real UI in Chromium: 17 end-to-end checks through the office and the
                    # workspace, including approvals in the office chat and a phone layout
```

The benchmark (Benchmark view, or `POST /api/benchmark/run`) scores 12 scenarios × 3 phrasings.
Currently: pass^3 = 100%, 80% handled alone, 0 wrong autonomous actions. That is on the seeded
scenarios, not live traffic. Calibration labels are synthetic until pilot data exists; every approval,
rejection, undo and audit adds a real one.

## Repository

| Path | Contents |
|---|---|
| `backend/nirnaya/` | Engine, API, MCP server (Python, FastAPI) |
| `backend/tests/` | pytest suite |
| `web/` | Web app (React, Vite, Tailwind): the 3D office in `web/src/office/` (three.js), the workspace views, Univer ledger, Playwright e2e in `web/e2e/` |
| `docs/REPO-SCAN.md` | What Nirnaya takes from each of the 18 reference projects, and their licences |
| `ppt.md` | The submission deck |
| `architecture/` | Architecture and tech-stack diagrams (draw.io source, PNG, SVG) |

<sub>`TRACK_SELECTION_ANALYSIS.md` is kept as background: the earlier survey of the hackathon tracks.</sub>
