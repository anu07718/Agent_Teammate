# Using Nirnaya, step by step

This guide is for someone who has never opened Nirnaya. It goes from starting the app to knowing, for
sure, that your agents are working and finishing their tasks. Then it covers everything else you can do.
Installing from source is in [run.md](run.md).

**What you are looking at.** Nirnaya is a team of 19 agents in six departments: Intake, Resolution,
Verification, Decision, Commit & Reply and Oversight. They handle payment-support cases for customers.
The cases are failed UPI debits, refunds, duplicate charges and unauthorised payments. Every case goes
through ten steps. At the end, the agents either act on their own, act with an undo, or stop and ask
you. Departments also take tasks you give them in plain words, now or on a schedule.

---

## 1. Start it

| You have | Do this | You are in when |
|---|---|---|
| **A computer, from the source** | `make run` (or the steps in [run.md](run.md)), then open **http://127.0.0.1:8000** | the 3D office appears and the Task Status panel says **LIVE · NIRNAYA** |
| **Windows** | Run `Nirnaya-Setup-0.1.0-x64.exe` from `exe/dist/`. If SmartScreen appears, choose **More info → Run anyway**. Then open **Nirnaya** from the Start menu or the desktop | the window says *Starting the Nirnaya server…* for a few seconds (longest the first time), then shows the office with **LIVE · NIRNAYA** |
| **An Android phone** | First start a server on a computer on the same Wi-Fi: `python -m nirnaya --host 0.0.0.0 --port 8000`. Install `Nirnaya-0.1.0.apk` from `apk/dist/` and open it. Type the computer's address, for example `192.168.1.20:8000`, and press **CONNECT** | the office appears; on a phone, the Task Status panel is a sheet at the bottom |

If the panel says **OFFLINE**, the app cannot reach its server. See [Troubleshooting](#11-troubleshooting).

## 2. Tell it who you are

Click the round avatar at the top right, type your name, and press **Save**. You start as
"Guest ABC". Your name goes on everything you do: the cases you open, the tasks you give, your
approvals, your chat messages and the flows you save. Your teammates see it too.

Shortcut: open `http://127.0.0.1:8000/?as=Asha` to arrive as Asha.

## 3. Your first case: watch the agents work

The **Task Status** panel on the right is where you give work to the office.

1. The button at the top left of the panel shows the department. It starts on **INTAKE**, which takes
   customer messages.
2. Press **SAMPLES** and choose **Failed UPI, 3 days late**. The customer (Aarav) and the message fill in.
   You can also type your own message and pick the customer and the channel (chat, whatsapp, email,
   voice, app) from the two small menus.
3. The line under the box tells you who will take it, for example *Probably UPI Disputes · triage
   confirms when you press Add · Aarav (C-1001) over chat*. Read it before you press anything.
4. Press **ADD**, or press Enter.

What you should see:
- A new card at the top of the list. Its chip shows how far it has got (for example **30%**), with
  "step 3 of 10 · evidence" and a progress bar.
- A token travelling from department to department in the office, and desks working.
- After a few seconds the card says **DONE · resolved alone**. The failed debit was reversed, and ₹100 a
  day was paid for the delay.

Click the card to fly to the desk that handled it: the rail on the left shows that agent, its chat and
its activity. To read the whole case (each step, the evidence, the score, the reply), press **WORKSPACE**
and pick it in **Cases**.

Each sample has a known right outcome. If you get these, the case pipeline works:

| Sample | Customer | What should happen |
|---|---|---|
| Failed UPI, 3 days late | Aarav | Resolved alone (ACT): reversal plus compensation |
| Failed UPI, today | Aarav | Resolved alone: the status is shared, still within the deadline |
| Hinglish complaint | Aarav | Resolved alone, and the reply is in Hinglish |
| Charged twice | Meera | Resolved with an undo (HEDGE): the duplicate is refunded |
| Where is my refund | Meera | Resolved alone: the refund status is shared |
| Unauthorised ₹18,500 | Rohan | The UPI ID is blocked at once, a dispute is raised, and the credit **waits for you** (ESCALATE) |
| Sent to wrong UPI ID | Rohan | Resolved alone: a dispute is raised |
| It actually went through | Priya | Resolved alone: the customer is told the payment succeeded |
| Refund over a week late | Priya | Resolved alone |
| Prompt injection | Aarav | **REFUSED** at intake |
| OTP shared | Meera | **REFUSED**, and the customer is told never to share an OTP |

## 4. When the agents need you: approvals

Some actions are not safe to take alone, such as an ₹18,500 credit. The agents do everything up to that
point, seal the evidence, and wait.

How you know: the amber **⚠ 1** button in the top bar counts what is waiting. The desk that needs you
stands up and waves, and the card says **WAITING**.

1. Click **⚠** in the top bar, or the card. The rail opens on that desk with **needs your approval**.
   It shows the action, the amount, the agents' score against the certified threshold, and the seal.
2. Choose:
   - **APPROVE** — it runs now. The card turns **DONE · resolved after Asha's OK**.
   - **REJECT** — type what should change in the chat box and press **SEND**. The case closes, and the
     customer is told a specialist will follow up.
   - **OPEN ↗** — see the whole case first.

You can also do this from **Workspace → Approvals**. There you can press **Edit** to change the amount and
then **Approve edited**.

**The seal.** In that desk's chat, type `move the ground` (or press **Move the ground** in Approvals).
The bank's ledger changes under the case. Now try **APPROVE**. The seal no longer matches, so the old
approval does not apply. The case is checked again and sealed again, and you approve the new seal. This
is how Nirnaya avoids acting on stale facts.

## 5. Give a department a task

Every department takes plain-language tasks. Change the department with the button at the top left of
the panel, then type a task or press **SAMPLES** for what it can do:

| Department | Try | Done by | You get |
|---|---|---|---|
| Verification | `Check T-5001`, `Pull the evidence for T-5006` | Evidence | the live status of that payment from the bank systems |
| Decision | `Run the benchmark` | Calibrator | "pass^3 100% over 12 scenarios × 3 phrasings · … · 0 wrong autonomous action(s)" |
| Decision | `List the certified thresholds`, `Score refund_duplicate 349` | Router | the thresholds, or a score for one action and amount |
| Decision | `Recalibrate` | Calibrator | **waits for your OK** first, because it changes how the agents decide |
| Commit & Reply | `Undo NR-…` with the number of a case whose card says *done alone, with an undo* | Commit | the action is reversed and the customer is told |
| Commit & Reply | `check: ₹500 will be credited in 2 hours, guaranteed` | Promise Guard | **FLAGGED**: "Would be blocked: contains a guarantee, ₹500 is not in the evidence" |
| Oversight | `Verify the audit trail` | Ledger Trail | "Chain intact · N entries" |
| Oversight | `Tamper test on the audit trail` | Ledger Trail | proof that an edit is caught |
| Oversight | `Check for drift` | Drift Monitor | the drift score, for example "PSI 0.00 · audit error 0% · no drift" |
| Oversight | `Write today's digest` | Support Lead | a summary of the day |

If a department can't do what you typed, the line under the box turns red and lists what it can do,
before you press ADD. For a long task, press **⤢** to open the big editor.

A task that needs an OK (such as Recalibrate) shows **WAITING**. Click it and press **APPROVE** in the
rail. To say no, press **REJECT**, type the reason, and press **SEND**. Approvals in the workspace lists it
too.

## 6. Make it repeat, or book it for later

**Repeat.** Type a task, press **REPEAT**, and choose how often. The choices are every weekday, every day,
one day of the week (Monday to Sunday), every hour 9–5 on weekdays, or every 5 minutes. Set the time in
**At**. Tick **needs my OK** if each run should wait for you. Then press **ADD**. Or just write it:
`every weekday at 9am, write today's digest`, `Mondays at 10:30 run the benchmark`, `every minute check
for drift`. The line under the box shows the schedule it understood.

The **Scheduled** filter lists your routines. Each one has **RUN NOW**, **PAUSE** / **RESUME** and
**DELETE**. Routines that come with the office (TAT watch, drift check, nightly benchmark) can be paused
and run, but not deleted.

**Book it.** Press **CALENDAR** in the top bar (or the **P** key). Click a day and write the task. Pick
the department and the time, then press **ADD**. To make it repeat from that day, press **Repeat** first
and choose a cadence. A booked task runs at its time. Its card has **CANCEL** and **CALENDAR**. In the
calendar: **WEEK** / **MONTH**, **‹ ›** to move, **TODAY**, the department buttons to show or hide each
department, **⏱ Routines** and **✓ Done** to show or hide them, and a search box. Click an event to see
it, and **DELETE** it if you made it.

## 7. Talk to the agents

Click any agent's name tag in the office, or a department card. You can also press **1–6** to go to a
department's lead. The rail on the left shows:
- **CHAT** — ask in your own words, or press a chip: *What are you working on?*, *What can you do?*,
  *Which systems do you use?*. Each agent answers about its own job and what it actually did. The
  Support Lead also has *What is waiting on me?*. Everyone on the team sees the same chat.
- **ACTIVITY** — the steps this agent handled and its recent work.
- **‹** goes back from an agent to its department's lead. **Esc** goes back to the whole office.

## 8. See the whole office

- **Filters** above the cards: **All**, **Scheduled**, **Backlog**, **In progress**, **Waiting**, **Done**.
  Each shows its count.
- **B — the board**: every department's work in five columns (Scheduled, Backlog, In progress, Waiting
  on approval, Done). Click a card to open its desk.
- **G — the Brain**: what the agents know (customers, accounts, UPI IDs, payments, merchants, cases,
  policies). Search it, or switch groups off and on.
- **D** dark mode, **+ / −** zoom, **⌂** the whole office again, **F** Flows, **W** the workspace.

## 9. Flows: your own workflows, run by the agents

Press **FLOWS** in the top bar (or **F**).

**Live** shows how the agents are working right now. It has the ten steps every case goes through, the
desks on each step, how many cases are at each step, and every case's progress. Click a case to light up
the steps it has passed, and press **Open NR-…** to see it. Department tasks and flow runs that are
going now are listed beside it. Click a run to open its flow.

**Builder** is where you draw a workflow. Here is one to build: *every morning, verify the audit trail;
if it fails, ask me.* (The same flow comes with the app as **Morning audit check**.)

1. Press **New** and type a name in the name box.
2. **Start** is already there. Click it and, in **When** on the right, write `every weekday at 9am`.
   Leave **When** empty to run the flow by hand.
3. With Start still selected, click **Department task** in the palette on the left. It appears, already
   wired from Start. You can also drag a node onto the canvas instead. On the right, choose **Oversight**
   and the chip **Verify the audit trail**.
4. Click **Check**. It is wired from the task. Set **Check** to *the step succeeded*, **How** to *is*,
   and **Value** to *true*.
5. Click **Post to team chat** (wired to the Check's **yes**). Write `Morning check: {result}`.
6. Click the Check again, then **Ask a person** (wired to **no**). Write the question.
7. Press **Save**. Then press **Run** to try it now.

Each node lights up as the agents work: *running*, then *done* with its result. Nodes on the branch not
taken show *skipped*. The bar at the top shows the run's progress. When a run reaches **Ask a person**, it
waits. Answer **Yes** or **No** on the node, in Approvals, or at the Support Lead's desk in the office.

| Node | Fields | What happens |
|---|---|---|
| Start | When (empty = by hand) | where a run begins; on a schedule it runs by itself |
| Customer message | Customer, Channel, the message (or a sample chip) | opens a real case; waits until it is resolved, or until someone approves it |
| Department task | Department (Verification, Decision, Commit & Reply, Oversight), the task (or an example chip) | that department does it, as if you typed it in the office |
| Check | what to check, how, the value | goes out **yes** or **no** |
| Ask a person | the question (`{case}` and `{result}` fill in) | waits for a yes or no from anyone on the team |
| Post to team chat | the department, the message | posts in that department lead's chat |
| Wait | seconds | pauses |

What a Check can look at, and how:

| Check | How | Value |
|---|---|---|
| the step succeeded | is, is not | true, false |
| the case's route | is, is not | ACT, HEDGE, ESCALATE, REFUSE |
| the case's status | is, is not | resolved, refused, parked |
| the step's result text | is, is not, contains | any words |
| the case's amount (₹) | is, is not, >, < | a number (₹ and commas are fine) |

In a chat post or a question, these fill in from the run: `{result}`, `{case}`, `{route}`, `{status}`,
`{by}`, `{flow}`.

Other controls:
- Drag from a node's right-hand dot to another node to wire them by hand. Click a wire to select it, then
  press **Delete wire**.
- **Delete node**, or the Delete key, removes what you selected. **Esc** selects nothing.
- Drag the background to move around. Scroll, or use **+**, **−** and **✋** (fit), to zoom.
- **Copy** makes a copy to change. **Delete** asks *Sure?* first. **Stop** ends a running flow.
  **Ctrl+S** saves.
- With nothing selected, the right side lists this flow's runs. Click one to see it on the canvas.

If **Save** shows a red line, it tells you what to fix. For example, a department doesn't know that
task, a task has a schedule in it (put the schedule on Start), the wires go round in a loop, or there is
nothing to compare with. Nothing is saved until it is right.

## 10. The workspace

Press **WORKSPACE** in the top bar (or **W**). The views are along the left; **1–9** and **0** switch
between them.

| View | What to do there |
|---|---|
| **Cases** | Filter the list. Open a case and read its tabs: **Timeline** (the ten steps and the conversation), **Evidence**, **Decision** (the score against the threshold), **Shadow & Seal**, **Trail & checkpoints**. Mark an autonomous decision right or wrong with 👍 / 👎 (these become training labels). Press **Undo** on a hedged action. **Packet** opens the evidence packet; **Export .xlsx** downloads the case as a workbook |
| **Approvals** | Everything waiting for a person: sealed cases (**Approve**, **Edit** then **Approve edited**, **Reject**, **Move the ground**), department tasks (**Approve**, **Reject** with a note), and flow questions (**Yes**, **No** with a note, **Open flow**) |
| **Flows** | as in section 9 |
| **Supervisor** | For each action: the error ceiling **α** and the autonomy (**Suggest**, **Hedge**, **Act**). Also the certified thresholds, the reliability chart, deflection against precision, **Recalibrate**, the drift monitor (**Inject drift** to see it fail closed, **Clear**), and the routines with **Run** |
| **Brain** | The context graph: highlight, click a node, follow its links. Case memory: search past cases and what held |
| **Ledger** | The simulated bank as a spreadsheet. Switch a system's outage on and off to see the agents cope. Land an outside event on a payment (an auto-reversal or a merchant refund; each lands once). **Reset world** puts it back |
| **Benchmark** | Choose **k** (1, 2 or 3) and **Run benchmark**: simulated customers, each asked k ways. Wrong autonomous actions should be 0 |
| **Trail** | The hash-chained audit log. **Verify chain** says it is intact; **Tamper test** shows an edit being caught. Case links open the case |
| **Settings** | The server address (for the phone and the Windows app), how to connect another agent over MCP, evidence parsing (upload a statement: UTRs are found and phone numbers tokenised), and **Simulate a crash and restart** (parked approvals survive) |

The header has the live log (every step, tool call and decision as it happens; the backtick key `` ` `` opens it too) and
the theme switch. The footer's count takes you to
Approvals. On a phone, the tab bar at the bottom has Office, Cases, Approvals, Flows, Supervisor and
Settings.

### Working as a team

Everyone who opens the same server address works in the same office. Teammates' avatars show in the top
bar, with the view or department each one is on. Chats, approvals, tasks and flows are shared and carry
the name of whoever did them. When a teammate approves something, it pops up for you. If someone saves a
flow you are editing, you are told and nothing is overwritten. To work together, open the server's
address on each computer. The phone app connects to it too.

---

## Checklist: are my agents working and finishing their tasks?

Five minutes, in this order. Each line says what you should see.

1. **Connected.** The panel says **LIVE · NIRNAYA**.
2. **A case resolves alone.** INTAKE → SAMPLES → *Failed UPI, 3 days late* → ADD. Within about 10
   seconds the card says **DONE · resolved alone**.
3. **A case waits for you, and your OK completes it.** SAMPLES → *Unauthorised ₹18,500* → ADD. **⚠ 1**
   appears and the card says **WAITING**. Click ⚠, then **APPROVE**. The card turns **DONE · resolved
   after <you>'s OK**.
4. **Unsafe input is refused.** SAMPLES → *Prompt injection* → ADD. The card says **REFUSED**.
5. **Departments do their tasks.**
   - OVERSIGHT → `Verify the audit trail` → ADD. The card says **DONE**; click it and the result reads
     "Chain intact · N entries".
   - DECISION → `Run the benchmark`. The result shows 0 wrong autonomous actions.
6. **A task waits for an OK.** DECISION → `Recalibrate` → **WAITING** → APPROVE → **DONE**.
7. **Routines run.** OVERSIGHT → `every minute check for drift` → ADD. Within a minute, a ⏱ card
   appears with the result. Delete the routine afterwards from the **Scheduled** filter.
8. **Flows run end to end.** FLOWS → Builder → pick **Model health** → **Run**. Every node turns *done*
   and the run reaches 100%.
9. **Nothing drifted and nothing was tampered with.**
   - Workspace → Supervisor: Drift (PSI) says *within range* and the drift monitor says **stable**.
   - Workspace → Trail → **Verify chain** says "Chain intact".

If all nine pass, the agents are working. To check everything automatically, run the end-to-end tests
(`make e2e`, or the scripts in `web/e2e/`; see the README). `web/e2e/workflow.mjs` does exactly this
checklist in a real browser.

## 11. Troubleshooting

| You see | It means | Do this |
|---|---|---|
| **OFFLINE** in the panel | the app can't reach its server | On a computer, start it (`make run`). In the phone app or the Windows app, check Workspace → Settings → Server URL and press Save |
| The phone says it can't connect | the server only listens on its own computer, or the phone is on another network | Start the server with `--host 0.0.0.0`, put both on the same Wi-Fi, allow port 8000 through the computer's firewall |
| The Windows window says the server did not start | another program is using ports 8765–8769, or the data folder can't be written | Press **Open the log**, close whatever uses the port, and press **Try again** |
| The line under the box is red | that department can't do what you typed | Read the list it gives, or press SAMPLES |
| A card stays **WAITING** | it needs a person | Click it (or ⚠) and APPROVE or REJECT |
| Every action hedges or asks you, even easy ones | the drift alarm is on: the agents fail closed | Supervisor → look at the drift card; **Clear** after a test, or **Recalibrate** |
| A booked task did not run | it is in the past, or it was cancelled | Book it again for a time ahead; times are your computer's clock |
| A flow will not save | the red line names the node and the problem | Fix that node, then Save |
| You want a clean start | — | Ledger → **Reset world** resets the bank. Starting the server with `--reset` clears all cases |
