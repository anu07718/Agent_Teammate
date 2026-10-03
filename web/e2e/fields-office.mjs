// The office, every control: each department in the menu, each sample message (with the outcome it must
// have), each customer and channel, each department's example tasks (the right desk does it), approving
// and rejecting a task, each REPEAT cadence, the filters, booking from the calendar, the calendar's own
// controls, the board, the Brain, the big editor, every agent's chat, the keys, zoom, dark mode, your name.
// Usage: node e2e/fields-office.mjs   (NIRNAYA_URL, default http://127.0.0.1:8000; SHOTS=dir)
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const URL = process.env.NIRNAYA_URL ?? "http://127.0.0.1:8000";
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push(true); console.log(`  ✓ ${name} (${Math.round((Date.now() - t0) / 1000)}s)`); }
  catch (e) { results.push(false); const lines = e.message.split("\n").filter((l) => l.trim()); console.log(`  ✗ ${name}\n      ${[lines[0], ...lines.slice(1).slice(-4)].join("\n      ")}`); if (SHOTS) await page.screenshot({ path: `${SHOTS}/fail-${results.length}.png` }).catch(() => {}); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
const api = async (p, init) => { const r = await fetch(URL + p, { headers: { "Content-Type": "application/json" }, ...init }); return r.json(); };
async function until(fn, ms = 25000, every = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, every)); }
  throw new Error("timed out waiting");
}

console.log(`Office, every control, against ${URL}`);
await api("/api/sim/reset", { method: "POST" });
const browser = await chromium.launch({ channel: "chromium", args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 940 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
const panel = () => page.getByTestId("task-panel");
const rail = () => page.getByTestId("rail");
const hint = () => page.locator(".o-hint");
const DEPTS = ["INTAKE", "RESOLUTION", "VERIFICATION", "DECISION", "COMMIT & REPLY", "OVERSIGHT"];
async function toDept(name) {
  await panel().getByRole("button", { name: "Department" }).click();
  await page.locator(".o-menu button", { hasText: name }).first().click();
  await page.locator(".o-menu").waitFor({ state: "detached" });
}
async function add() { await panel().getByRole("button", { name: "ADD", exact: true }).click(); }
const newCase = async (known) => until(async () => (await api("/api/cases")).find((c) => !known.has(c.id) && c.status !== "running"));
// a new task in one of these states; by default one this tester started (quiet routines run tasks too)
const newOp = async (known, states = ["done"], mine = (o) => o.by === "Tester") => until(async () => (await api("/api/office")).ops.find((o) => !known.has(o.id) && states.includes(o.state) && mine(o)));
const caseIds = async () => new Set((await api("/api/cases")).map((c) => c.id));
const opIds = async () => new Set((await api("/api/office")).ops.map((o) => o.id));
// a day cell's empty bottom strip (events stack from the top and would open themselves instead)
const clickDay = async (cell) => { const b = await cell.boundingBox(); await cell.click({ position: { x: 8, y: b.height - 5 } }); };
const calm = () => page.locator(".o-top").click({ position: { x: 760, y: 26 } }); // focus the page without hitting a button

await page.goto(`${URL}/?as=Tester`);
await page.getByText("LIVE · NIRNAYA").waitFor({ timeout: 20000 });

await step("the department menu lists all six, and each changes what the bar asks for", async () => {
  await panel().getByRole("button", { name: "Department" }).click();
  const items = await page.locator(".o-menu button").allInnerTexts();
  expect(DEPTS.every((d) => items.some((t) => t.includes(d))) && items.length === 6, `menu: ${items.join(" | ")}`);
  await page.keyboard.press("Escape");
  await page.locator(".o-menu").waitFor({ state: "detached" });
  for (const d of DEPTS) {
    await toDept(d);
    const ph = await panel().getByRole("textbox", { name: "Task" }).getAttribute("placeholder");
    const isCase = d === "INTAKE" || d === "RESOLUTION";
    expect(isCase ? ph.startsWith("Type a customer message") : ph.startsWith("Type a task for"), `${d}: ${ph}`);
    expect(await panel().getByRole("combobox", { name: "Customer" }).count() === (isCase ? 1 : 0), `${d}: customer picker`);
  }
});

const EXPECT = {
  "Failed UPI, 3 days late": { status: "resolved", route: "ACT", acts: ["reverse_failed_debit", "tat_compensation"] },
  "Failed UPI, today": { status: "resolved", route: "ACT", acts: ["share_status"] },
  "Hinglish complaint": { status: "resolved", route: "ACT", reply: /aapke|wapas|paisa/i },
  "Charged twice": { status: "resolved", route: "HEDGE", acts: ["refund_duplicate"] },
  "Where is my refund": { status: "resolved", route: "ACT", acts: ["share_status"] },
  "Unauthorised ₹18,500": { status: "parked", route: "ESCALATE", acts: ["block_instrument", "raise_dispute", "chargeback_credit"] },
  "Sent to wrong UPI ID": { status: "resolved", route: "ACT", acts: ["raise_dispute"] },
  "It actually went through": { status: "resolved", route: "ACT", acts: ["share_status"] },
  "Refund over a week late": { status: "resolved", route: "ACT" },
  "Prompt injection": { status: "refused", route: "REFUSE" },
  "OTP shared": { status: "refused", route: "REFUSE" },
};
const byLabel = {};
await step("every sample message lands with the outcome it should have (11 samples)", async () => {
  await toDept("INTAKE");
  const presets = (await api("/api/state")).presets;
  expect(presets.length === 11, `${presets.length} presets`);
  const bad = [];
  for (const p of presets) {
    const known = await caseIds();
    await panel().getByRole("button", { name: "Samples", exact: true }).click();
    await page.locator(".o-menu button", { hasText: p.label }).first().click();
    expect((await panel().getByRole("combobox", { name: "Customer" }).inputValue()) === p.customer, `${p.label}: customer not set to ${p.customer}`);
    expect((await panel().getByRole("textbox", { name: "Task" }).inputValue()) === p.text, `${p.label}: text not filled`);
    await add();
    const c = await newCase(known);
    const d = await api(`/api/cases/${c.id}`);
    byLabel[p.label] = d;
    const want = EXPECT[p.label];
    const acts = d.decisions.map((x) => x.action.type);
    const reply = [...d.conversation].reverse().find((m) => m.role === "nirnaya")?.text ?? "";
    if (d.status !== want.status || d.route !== want.route) bad.push(`${p.label}: ${d.status}/${d.route}`);
    if (want.acts && want.acts.join() !== acts.join()) bad.push(`${p.label}: actions ${acts}`);
    if (want.reply && !want.reply.test(reply)) bad.push(`${p.label}: reply “${reply.slice(0, 60)}”`);
    if (!reply) bad.push(`${p.label}: no reply to the customer`);
  }
  expect(!bad.length, bad.join(" · "));
  // the cards on the board say the same
  await panel().locator(".o-row", { hasText: "REFUSED" }).first().waitFor();
  await panel().locator(".o-row.waiting", { hasText: "Unauthorised" }).first().waitFor();
});

await step("every customer and every channel reaches the case as picked (4 customers, 5 channels)", async () => {
  await toDept("RESOLUTION");
  const custs = await panel().getByRole("combobox", { name: "Customer" }).locator("option").evaluateAll((os) => os.map((o) => o.value));
  const chans = await panel().getByRole("combobox", { name: "Channel" }).locator("option").evaluateAll((os) => os.map((o) => o.value));
  expect(custs.join() === "C-1001,C-1002,C-1003,C-1004", `customers ${custs}`);
  expect(chans.join() === "chat,whatsapp,email,voice,app", `channels ${chans}`);
  for (let i = 0; i < chans.length; i++) {
    const cust = custs[i % custs.length], ch = chans[i];
    await panel().getByRole("combobox", { name: "Customer" }).selectOption(cust);
    await panel().getByRole("combobox", { name: "Channel" }).selectOption(ch);
    await panel().getByRole("textbox", { name: "Task" }).fill(`Did my last payment go through? (${ch} test)`);
    await hint().filter({ hasText: `(${cust}) over ${ch}` }).waitFor();
    const known = await caseIds();
    await add();
    const c = await newCase(known);
    expect(c.customer_id === cust && c.channel === ch, `${c.id}: ${c.customer_id}/${c.channel}, wanted ${cust}/${ch}`);
    expect(c.opened_by === "Tester", `${c.id} opened by ${c.opened_by}`);
  }
});

const TASKS = {
  VERIFICATION: [["Check T-5001", "evidence", true], ["Pull the evidence for T-5006", "evidence", true]],
  DECISION: [["Run the benchmark", "calibrator", true], ["List the certified thresholds", "router", true], ["Score refund_duplicate 349", "router", true]],
  "COMMIT & REPLY": [["check: ₹500 will be credited in 2 hours, guaranteed", "guard", false]],
  OVERSIGHT: [["Verify the audit trail", "trail", true], ["Tamper test on the audit trail", "trail", true], ["Check for drift", "drift", true], ["Write today's digest", "human", true]],
};
await step("every department's example tasks run on the right desk, with a result (10 tasks + undo)", async () => {
  const bad = [];
  for (const [dept, list] of Object.entries(TASKS)) {
    await toDept(dept);
    await panel().getByRole("button", { name: "Samples", exact: true }).click();
    const offered = await page.locator(".o-menu button").allInnerTexts();
    await page.keyboard.press("Escape");
    for (const [text, agent, ok] of list) {
      if (!offered.some((o) => o.trim() === text)) bad.push(`${dept} doesn't offer “${text}”`);
      await panel().getByRole("textbox", { name: "Task" }).fill(text);
      await hint().filter({ hasText: /Goes to/ }).waitFor();
      const known = await opIds();
      await add();
      const op = await newOp(known);
      if (op.agent !== agent) bad.push(`“${text}” went to ${op.agent}, not ${agent}`);
      if (op.ok !== ok) bad.push(`“${text}” ok=${op.ok}: ${op.result}`);
      if (!op.result) bad.push(`“${text}” has no result`);
      if (op.by !== "Tester") bad.push(`“${text}” by ${op.by}`);
    }
  }
  // Undo needs a hedged case: the duplicate charge from the samples
  const hedged = byLabel["Charged twice"]?.id;
  await toDept("COMMIT & REPLY");
  await panel().getByRole("textbox", { name: "Task" }).fill(`Undo ${hedged}`);
  const known = await opIds();
  await add();
  const op = await newOp(known);
  if (op.agent !== "commit" || !op.ok) bad.push(`undo: ${op.agent} ${op.ok} ${op.result}`);
  const c = await api(`/api/cases/${hedged}`);
  if (!c.decisions.some((d) => d.undone)) bad.push(`${hedged} was not undone`);
  // a task a department does not know is answered with what it can do, before ADD
  await toDept("VERIFICATION");
  await panel().getByRole("textbox", { name: "Task" }).fill("make me a sandwich");
  await hint().filter({ hasText: "can:" }).waitFor();
  await panel().getByRole("textbox", { name: "Task" }).fill("");
  expect(!bad.length, bad.join(" · "));
});

await step("a task that needs an OK: APPROVE in the rail runs it, REJECT with a note stops it", async () => {
  await toDept("DECISION");
  for (const yes of [true, false]) {
    const known = await opIds();
    await panel().getByRole("textbox", { name: "Task" }).fill("Recalibrate");
    await add();
    const op = await newOp(known, ["waiting"]);
    await calm();
    await page.locator('.o-pill[data-agent="calibrator"]').click();
    const card = rail().locator(`.o-appr[data-op="${op.id}"]`);
    await card.waitFor();
    if (yes) {
      await card.getByRole("button", { name: "APPROVE" }).click();
      const done = await until(async () => (await api("/api/office")).ops.find((o) => o.id === op.id && o.state === "done"));
      expect(done.ok && done.approved_by === "Tester", `approved: ${done.ok} ${done.approved_by}`);
      await rail().getByText(`Tester approved “${op.title}”`).first().waitFor();
    } else {
      await card.getByRole("button", { name: "REJECT" }).click();
      await rail().getByRole("textbox", { name: "Message" }).fill("not before the audit");
      await rail().getByRole("button", { name: "SEND" }).click();
      const done = await until(async () => (await api("/api/office")).ops.find((o) => o.id === op.id && o.state === "done"));
      expect(done.rejected && done.note === "not before the audit" && done.rejected_by === "Tester", `rejected: ${JSON.stringify(done).slice(0, 120)}`);
    }
    await page.keyboard.press("Escape");
  }
});

const CADENCES = [["weekdays", "Every weekday"], ["daily", "Every day"], ["0", "Mondays"], ["1", "Tuesdays"], ["2", "Wednesdays"], ["3", "Thursdays"],
  ["4", "Fridays"], ["5", "Saturdays"], ["6", "Sundays"], ["hourly", "Every hour, 9–5, weekdays"], ["m5", "Every 5 minutes"]];
const wantWhen = (cad, at) => cad === "hourly" ? { kind: "hourly", every: 1, from: "09:00", to: "17:00", weekdays_only: true }
  : cad === "m5" ? { kind: "minutes", every: 5 } : cad === "weekdays" || cad === "daily" ? { kind: cad, at } : { kind: "weekly", days: [Number(cad)], at };
await step("every REPEAT cadence makes the routine it says, and DELETE removes it (11 cadences)", async () => {
  await toDept("OVERSIGHT");
  const bad = [];
  for (const [cad, label] of CADENCES) {
    await panel().getByRole("textbox", { name: "Task" }).fill("Write today's digest");
    await panel().getByRole("button", { name: "Repeat", exact: true }).click();
    await page.getByRole("combobox", { name: "How often" }).selectOption(cad);
    const timed = cad !== "hourly" && cad !== "m5";
    expect((await page.getByLabel("At", { exact: true }).isDisabled()) === !timed, `${label}: time box enabled=${!timed}`);
    if (timed) await page.getByLabel("At", { exact: true }).fill("10:30");
    await hint().filter({ hasText: `Repeats ${label.toLowerCase()}` }).waitFor();
    const before = new Set((await api("/api/office")).routines.map((r) => r.id));
    await add();
    const r = await until(async () => (await api("/api/office")).routines.find((x) => !before.has(x.id)));
    const want = wantWhen(cad, "10:30");
    if (JSON.stringify(Object.fromEntries(Object.entries(r.when).filter(([k]) => k in want))) !== JSON.stringify(want)) bad.push(`${label}: ${JSON.stringify(r.when)}`);
    if (r.kind !== "digest" || r.agent !== "human" || r.by !== "Tester") bad.push(`${label}: ${r.kind} ${r.agent} ${r.by}`);
    const row = panel().locator(".o-row", { hasText: r.desc }).filter({ hasText: "set by Tester" }).first();
    await row.getByRole("button", { name: "DELETE" }).click();
    await until(async () => !(await api("/api/office")).routines.some((x) => x.id === r.id));
  }
  expect(!bad.length, bad.join(" · "));
});

await step("a routine's RUN NOW, PAUSE, RESUME and “needs my OK” all do what they say", async () => {
  await toDept("OVERSIGHT");
  await panel().getByRole("textbox", { name: "Task" }).fill("Verify the audit trail");
  await panel().getByRole("button", { name: "Repeat", exact: true }).click();
  await page.getByRole("combobox", { name: "How often" }).selectOption("daily");
  await page.getByLabel("At", { exact: true }).fill("07:15");
  await page.getByLabel("needs my OK").check();
  const before = new Set((await api("/api/office")).routines.map((r) => r.id));
  await add();
  const r = await until(async () => (await api("/api/office")).routines.find((x) => !before.has(x.id)));
  expect(r.needs_ok && r.kind === "trail-verify", `routine ${r.kind} needs_ok=${r.needs_ok}`);
  const row = () => panel().locator(".o-row", { hasText: r.desc }).filter({ hasText: "set by Tester" }).first();
  await row().getByRole("button", { name: "PAUSE" }).click();
  await until(async () => (await api("/api/office")).routines.find((x) => x.id === r.id)?.paused);
  await row().getByText("PAUSED").waitFor();
  await row().getByRole("button", { name: "RESUME" }).click();
  await until(async () => { const x = (await api("/api/office")).routines.find((y) => y.id === r.id); return !x.paused && x.next_at; });
  const known = await opIds();
  await row().getByRole("button", { name: "RUN NOW" }).click();
  const op = await newOp(known, ["waiting"], (o) => o.routine === r.id);
  await api(`/api/office/ops/${op.id}/reject`, { method: "POST", body: JSON.stringify({ note: "test", by: "Tester" }) });
  await row().getByRole("button", { name: "DELETE" }).click();
  await until(async () => !(await api("/api/office")).routines.some((x) => x.id === r.id));
});

await step("each filter shows exactly what its count says", async () => {
  const snap = await api("/api/office");
  const chips = [["All", "all"], ["Scheduled", "sched"], ["Backlog", "next"], ["In progress", "doing"], ["Waiting", "waiting"], ["Done", "done"]];
  await calm();
  await page.keyboard.press("0");
  for (const [label] of chips) {
    const chip = panel().getByRole("tab", { name: new RegExp(`^${label}\\s*\\d+$`) });
    await chip.click();
    await page.waitForTimeout(300);
    const n = Number((await chip.innerText()).replace(/\D+/g, ""));
    const rows = await panel().getByTestId("task-rows").locator(".o-row").count();
    expect(rows === Math.min(n, label === "Scheduled" ? n : 80), `${label}: count ${n}, rows ${rows}`);
  }
  await panel().getByRole("tab", { name: /^All\s*\d+$/ }).click();
  void snap;
});

await step("a task booked on the calendar runs at its time; CANCEL on its card removes it", async () => {
  await calm();
  await page.keyboard.press("p");
  const cal = page.getByTestId("calendar");
  await cal.locator(".o-day.today").waitFor();
  await clickDay(cal.locator(".o-day.today"));
  const pop = page.locator(".o-pop");
  await pop.waitFor();
  const depts = await pop.locator("select").first().locator("option").allInnerTexts();
  expect(depts.length === 6, `booking departments: ${depts}`);
  await pop.locator("textarea").fill("Verify the audit trail");
  await pop.locator("select").first().selectOption("oversight");
  await pop.locator('input[type="time"]').fill("23:59");
  const known = await opIds();
  await pop.getByRole("button", { name: "ADD" }).click();
  await pop.getByText(/Booked for/).waitFor();
  const op = await newOp(known, ["scheduled"]);
  const due = new Date(op.due_at * 1000);
  expect(due.getHours() === 23 && due.getMinutes() === 59 && op.agent === "trail", `booked for ${due} by ${op.agent}`);
  await pop.waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  await panel().getByRole("tab", { name: /^Scheduled\s*\d+$/ }).click();
  const card = panel().locator(`.o-row[data-id="${op.id}"]`);
  await card.getByRole("button", { name: "CANCEL" }).click();
  await until(async () => !(await api("/api/office")).ops.some((o) => o.id === op.id));
  await panel().getByRole("tab", { name: /^All\s*\d+$/ }).click();
});

await step("booking a repeat from a calendar day starts a routine from that day (5 cadences offered)", async () => {
  await calm();
  await page.keyboard.press("p");
  const cal = page.getByTestId("calendar");
  await cal.getByRole("button", { name: "next" }).click();
  await clickDay(cal.locator(".o-day:not(.out)").nth(10));
  const pop = page.locator(".o-pop");
  await pop.locator("textarea").fill("Check for drift");
  await pop.locator("select").first().selectOption("oversight");
  await pop.locator('input[type="time"]').fill("08:40");
  await pop.getByRole("button", { name: "Repeat" }).click();
  const cads = await pop.locator("select").nth(1).locator("option").allInnerTexts();
  expect(cads.length === 5, `cadences ${cads}`);
  await pop.locator("select").nth(1).selectOption("2");
  const before = new Set((await api("/api/office")).routines.map((r) => r.id));
  await pop.getByRole("button", { name: "ADD" }).click();
  await pop.getByText(/Routine set/).waitFor();
  const r = await until(async () => (await api("/api/office")).routines.find((x) => !before.has(x.id)));
  expect(r.when.kind === "weekly" && r.when.days[0] === 2 && r.when.at === "08:40" && r.when.start && r.kind === "drift-check", JSON.stringify(r.when));
  await api(`/api/office/routines/${r.id}`, { method: "DELETE" });
  await cal.getByRole("button", { name: "TODAY" }).click();
  await page.keyboard.press("Escape");
});

await step("the calendar's controls: week, month, back, forward, today, departments, routines, done, search", async () => {
  await calm();
  await page.keyboard.press("p");
  const cal = page.getByTestId("calendar");
  const title = () => cal.locator(".ttl").innerText();
  const month = await title();
  await cal.getByRole("button", { name: "WEEK" }).click();
  expect(/\d+–\d+ \w{3}/.test(await title()), `week title ${await title()}`);
  expect(await cal.locator(".o-day").count() === 7, "week view is not 7 days");
  await cal.getByRole("button", { name: "MONTH" }).click();
  expect((await title()) === month && (await cal.locator(".o-day").count()) >= 28, "month view did not come back");
  await cal.getByRole("button", { name: "next" }).click();
  expect((await title()) !== month, "next did not move");
  await cal.getByRole("button", { name: "previous" }).click();
  await cal.getByRole("button", { name: "previous" }).click();
  await cal.getByRole("button", { name: "TODAY" }).click();
  expect((await title()) === month, "TODAY did not return");
  for (const d of ["Intake", "Resolution", "Verification", "Decision", "Commit & Reply", "Oversight"]) {
    const b = cal.locator(".tools button", { hasText: new RegExp(d, "i") }).first();
    await b.click();
    expect((await b.evaluate((e) => getComputedStyle(e).opacity)) === "0.4", `${d} did not switch off`);
    await b.click();
  }
  const routinesBefore = await cal.locator(".o-ev.routine").count();
  await cal.getByRole("button", { name: "⏱ Routines" }).click();
  expect((await cal.locator(".o-ev.routine").count()) === 0 && routinesBefore > 0, `routines ${routinesBefore} → still shown`);
  await cal.getByRole("button", { name: "⏱ Routines" }).click();
  await cal.getByRole("button", { name: "✓ Done" }).click();
  expect((await cal.locator(".o-ev.done").count()) === 0, "done still shown");
  await cal.getByRole("button", { name: "✓ Done" }).click();
  await cal.getByPlaceholder("Search tasks and routines…").fill("benchmark");
  const titles = await cal.locator(".o-ev .t").allInnerTexts();
  expect(titles.length > 0 && titles.every((t) => /benchmark/i.test(t)), `search: ${titles.slice(0, 3)}`);
  await cal.getByPlaceholder("Search tasks and routines…").fill("");
  await cal.locator(".crail .rt").first().click();
  expect(await cal.locator(".crail .rt.on").count() === 1, "routine filter not on");
  await cal.locator(".crail .rt").first().click();
  await cal.getByRole("button", { name: "Close the calendar" }).click();
  await page.locator(".o-cal.on").waitFor({ state: "detached" });
});

await step("the board: five columns for six departments, counts that add up, a card opens its desk", async () => {
  await calm();
  await page.keyboard.press("b");
  const board = page.getByTestId("board");
  await page.locator(".o-board.on").waitFor();
  expect(await board.locator(".ld").count() === 6 && (await board.locator(".lh").count()) === 6, "lanes");
  const doneStat = Number((await board.locator(".stats span", { hasText: "DONE" }).innerText()).replace(/\D+/g, ""));
  const snapDone = (await api("/api/state")).cases.filter((c) => c.status !== "running" && !c.pending).length;
  expect(doneStat >= snapDone, `board DONE ${doneStat} < ${snapDone}`);
  await board.locator(".o-tk.waiting").first().click();
  await page.locator(".o-board.on").waitFor({ state: "detached" });
  await rail().locator(".o-appr").first().waitFor();
  await page.keyboard.press("Escape");
});

await step("the Brain: search, every group switches off and on, close", async () => {
  await calm();
  await page.keyboard.press("g");
  const b = page.getByTestId("brain");
  await page.locator(".o-brain.on").waitFor();
  await b.getByText(/\d+ NODES · \d+ LINKS/).waitFor();
  const groups = await b.locator(".o-bchips button").allInnerTexts();
  expect(groups.length >= 7, `groups ${groups}`);
  for (const g of groups) {
    const chip = b.locator(".o-bchips button", { hasText: g }).first();
    await chip.click();
    expect(!(await chip.getAttribute("class"))?.includes("on"), `${g} did not switch off`);
    await chip.click();
    expect((await chip.getAttribute("class"))?.includes("on"), `${g} did not switch back on`);
  }
  await b.getByRole("textbox", { name: "Search the Brain" }).fill("C-1001");
  await b.getByRole("button", { name: "Close the Brain" }).click();
  await page.locator(".o-brain.on").waitFor({ state: "detached" });
});

await step("the big editor adds a long task", async () => {
  await toDept("OVERSIGHT");
  await panel().getByTitle(/big editor/).click();
  const box = page.locator(".o-bigbox");
  await box.locator("textarea").fill("Write today's digest");
  const known = await opIds();
  await box.getByRole("button", { name: "ADD" }).click();
  const op = await newOp(known);
  expect(op.kind === "digest" && op.ok, `${op.kind} ${op.ok}`);
});

await step("every one of the 19 agents answers in its own role, and shows its ACTIVITY", async () => {
  const agents = (await api("/api/state")).agents;
  expect(agents.length === 19, `${agents.length} agents`);
  const bad = [];
  for (const a of agents) {
    await calm();
    await page.locator(`.o-pill[data-agent="${a.id}"]`).click();
    await rail().locator("h3", { hasText: a.name.toUpperCase() }).waitFor();
    for (const [chip, check] of [["What can you do?", (t) => t.length > 20], ["Which systems do you use?", (t) => /work with|don't call/i.test(t)], ["What are you working on?", (t) => t.includes(`I'm ${a.name}`)]]) {
      const n = ((await api("/api/office/chats"))[a.id] ?? []).length;
      await rail().getByRole("button", { name: chip }).click();
      const msgs = await until(async () => { const m = (await api("/api/office/chats"))[a.id] ?? []; return m.length >= Math.min(120, n + 2) && m.at(-1).who === "agent" && m.at(-2).text === chip ? m : null; }, 15000);
      const reply = msgs.at(-1).text;
      if (!check(reply)) bad.push(`${a.name} · “${chip}” → “${reply.slice(0, 50)}”`);
      if (msgs.at(-2).by !== "Tester") bad.push(`${a.name}: question by ${msgs.at(-2).by}`);
      await rail().getByTestId("chat").getByText(reply.slice(0, 40), { exact: false }).last().waitFor();
    }
    await rail().getByRole("button", { name: "ACTIVITY" }).click();
    await rail().getByText("Steps handled").waitFor();
    await rail().getByRole("button", { name: "CHAT" }).click();
    if (!a.lead) {
      await rail().getByRole("button", { name: "Back to the department lead" }).click();
      await rail().locator("h3 .star").waitFor();
    }
    await page.keyboard.press("Escape");
  }
  await calm();
  await page.locator('.o-pill[data-agent="human"]').click();
  await rail().getByRole("button", { name: "What is waiting on me?" }).click();
  await rail().locator(".o-m-agent", { hasText: /waiting on you|Nothing is waiting/ }).last().waitFor();
  await page.keyboard.press("Escape");
  expect(!bad.length, bad.join(" · "));
});

await step("keys 1–6 open each department's lead, 0 and ⌂ go back, + and − zoom, D is dark, F and W leave", async () => {
  const leads = (await api("/api/office")).pods.map((p) => p.lead);
  const names = Object.fromEntries((await api("/api/state")).agents.map((a) => [a.id, a.name.toUpperCase()]));
  for (let i = 0; i < 6; i++) {
    await calm();
    await page.keyboard.press(String(i + 1));
    await rail().locator("h3", { hasText: names[leads[i]] }).waitFor();
  }
  await page.getByRole("button", { name: "◂ OVERVIEW" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom out" }).click();
  await page.getByRole("button", { name: "Overview" }).click();
  await calm();
  await page.keyboard.press("d");
  await page.locator(".o-root.o-dark").waitFor();
  await page.keyboard.press("d");
  await page.locator(".o-root:not(.o-dark)").waitFor();
  await page.keyboard.press("f");
  await page.getByTestId("pipeline").waitFor();
  await page.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: "Office", exact: true }).click();
  await page.locator(".o-root").waitFor();
  await calm();
  await page.keyboard.press("w");
  await page.getByRole("navigation", { name: "Views" }).first().waitFor();
  await page.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: "Office", exact: true }).click();
  await page.locator(".o-root").waitFor();
});

await step("the top bar's buttons: CALENDAR, FLOWS, WORKSPACE and the waiting count all go where they say", async () => {
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await page.locator(".o-cal.on").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.getByTestId("pipeline").waitFor();
  await page.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: "Office", exact: true }).click();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: "Office", exact: true }).click();
  await page.locator(".o-top .o-btn.amber").click();
  await rail().locator(".o-appr").first().waitFor();
  await page.keyboard.press("Escape");
});

await step("your name: click your avatar, rename, and the server knows you by it", async () => {
  await page.getByRole("button", { name: "Your name" }).click();
  await page.locator("#my-name").fill("Tester Two");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await until(async () => (await api("/api/team")).people.some((p) => p.name === "Tester Two"));
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("nirnaya.me"))).name === "Tester Two", "not saved in the browser");
});

await step("no uncaught errors and no server errors", async () => { expect(!errors.length, errors.join(" | ")); });

await browser.close();
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
