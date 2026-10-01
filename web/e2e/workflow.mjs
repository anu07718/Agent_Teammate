// workflow.md, followed step by step in a real browser, the way a new user would: arrive, set a name,
// send a sample customer message and watch it resolve, approve one that waits, see one refused, give
// departments tasks, approve a task that needs an OK, set a routine and see it run, build the morning
// audit flow from the guide and run it, run Model health, and check drift and the audit trail.
// Usage: node e2e/workflow.mjs   (NIRNAYA_URL, default http://127.0.0.1:8000; SHOTS=dir)
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const URL = process.env.NIRNAYA_URL ?? "http://127.0.0.1:8000";
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const results = [];
let page;
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push(true); console.log(`  ✓ ${name} (${Math.round((Date.now() - t0) / 1000)}s)`); }
  catch (e) {
    results.push(false);
    const lines = e.message.split("\n").filter((l) => l.trim());
    console.log(`  ✗ ${name}\n      ${[lines[0], ...lines.slice(1).slice(-4)].join("\n      ")}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/wf-fail-${results.length}.png` }).catch(() => {});
  }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
const api = async (p, init) => (await fetch(URL + p, { headers: { "Content-Type": "application/json" }, ...init })).json();
async function until(fn, ms = 30000, every = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, every)); }
  throw new Error("timed out waiting");
}

console.log(`workflow.md, step by step, against ${URL}`);
const browser = await chromium.launch({ channel: "chromium", args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
// a browser that has never seen Nirnaya: no name yet
const ctx = await browser.newContext({ viewport: { width: 1600, height: 940 } });
page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
const panel = () => page.getByTestId("task-panel");
const rail = () => page.getByTestId("rail");
const card = (re) => panel().getByTestId("task-rows").locator(".o-row", { hasText: re }).first();
const calm = () => page.locator(".o-top").click({ position: { x: 760, y: 26 } });
const ME = `Neha ${Date.now() % 1000}`;
async function toDept(name) {
  await panel().getByRole("button", { name: "Department" }).click();
  await page.locator(".o-menu button", { hasText: name }).first().click();
}
async function sample(label) {
  await panel().getByRole("button", { name: "Samples", exact: true }).click();
  await page.locator(".o-menu button", { hasText: label }).first().click();
}
const add = () => panel().getByRole("button", { name: "ADD", exact: true }).click();
const newCase = async (known) => until(async () => (await api("/api/cases")).find((c) => !known.has(c.id) && c.opened_by === ME));
const caseIds = async () => new Set((await api("/api/cases")).map((c) => c.id));
const opIds = async () => new Set((await api("/api/office")).ops.map((o) => o.id));
const newOp = async (known) => until(async () => (await api("/api/office")).ops.find((o) => !known.has(o.id) && o.by === ME));

await step("1. Start it: the office opens and the panel says LIVE · NIRNAYA", async () => {
  await page.goto(URL);
  await page.locator(".o-root").waitFor();
  await panel().getByText("LIVE · NIRNAYA").waitFor({ timeout: 20000 });
});

await step("2. Tell it who you are: you start as a guest; the avatar sets your name, and the server knows it", async () => {
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("nirnaya.me") || "{}"));
  expect(/^Guest [A-Z0-9]{3}$/.test(saved.name), `first name ${saved.name}`);
  await page.getByRole("button", { name: "Your name" }).click();
  await page.locator("#my-name").fill(ME);
  await page.locator("form", { has: page.locator("#my-name") }).getByRole("button", { name: "Save" }).click();
  await until(async () => (await api("/api/team")).people.some((p) => p.name === ME));
});

let first;
await step("3. Your first case: SAMPLES → Failed UPI, 3 days late → the line names who takes it → ADD → DONE · resolved alone", async () => {
  await panel().getByRole("button", { name: "Department" }).waitFor();
  expect((await panel().getByRole("button", { name: "Department" }).innerText()).includes("INTAKE"), "the panel does not start on Intake");
  await sample("Failed UPI, 3 days late");
  await page.locator(".o-hint").filter({ hasText: /Probably .+ · triage confirms when you press Add · Aarav \(C-1001\) over chat/ }).waitFor();
  const known = await caseIds();
  await add();
  first = await newCase(known);
  await panel().locator(`.o-row[data-id="${first.id}"]`).waitFor();
  const done = await until(async () => { const c = await api(`/api/cases/${first.id}`); return c.status !== "running" ? c : null; });
  expect(done.status === "resolved" && done.route === "ACT", `${done.status} ${done.route}`);
  await panel().locator(`.o-row[data-id="${first.id}"]`).getByText("resolved alone").waitFor();
  await panel().locator(`.o-row[data-id="${first.id}"]`).click();
  await rail().locator("h3").first().waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/wf-first-case.png` });
  await page.keyboard.press("Escape");
});

let parkedCase;
await step("4. When the agents need you: Unauthorised ₹18,500 waits, ⚠ opens it, APPROVE resolves it after your OK", async () => {
  await calm();
  await sample("Unauthorised ₹18,500");
  const known = await caseIds();
  await add();
  parkedCase = await newCase(known);
  await until(async () => (await api(`/api/cases/${parkedCase.id}`)).pending);
  await panel().locator(`.o-row.waiting[data-id="${parkedCase.id}"]`).waitFor();
  await page.locator(".o-top .o-btn.amber").click();
  const appr = rail().locator(`.o-appr[data-case="${parkedCase.id}"]`);
  await appr.waitFor();
  await appr.getByText("needs your approval").waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/wf-approval.png` });
  await appr.getByRole("button", { name: "APPROVE" }).click();
  const c = await until(async () => { const x = await api(`/api/cases/${parkedCase.id}`); return x.status === "resolved" ? x : null; });
  expect(c.approved_by === ME || c.trail.some((t) => t.kind === "approval.granted" && t.actor === ME), "not approved by me");
  await panel().locator(`.o-row[data-id="${parkedCase.id}"]`).getByText(`resolved after ${ME}’s OK`).waitFor();
  await page.keyboard.press("Escape");
});

await step("checklist 4: unsafe input is refused (Prompt injection → REFUSED)", async () => {
  await calm();
  await sample("Prompt injection");
  const known = await caseIds();
  await add();
  const c = await newCase(known);
  await until(async () => (await api(`/api/cases/${c.id}`)).status === "refused");
  await panel().locator(`.o-row[data-id="${c.id}"] .o-st`, { hasText: "REFUSED" }).waitFor();
});

await step("5. Departments do their tasks: Oversight verifies the trail (Chain intact), Decision runs the benchmark (0 wrong)", async () => {
  await toDept("OVERSIGHT");
  await panel().getByRole("textbox", { name: "Task" }).fill("Verify the audit trail");
  await page.locator(".o-hint").filter({ hasText: "Goes to Ledger Trail" }).waitFor();
  let known = await opIds();
  await add();
  let op = await newOp(known);
  op = await until(async () => (await api("/api/office")).ops.find((o) => o.id === op.id && o.state === "done"));
  expect(op.ok && /^Chain intact · \d+ entries/.test(op.result), op.result);
  await panel().locator(`.o-row[data-id="${op.id}"] .o-st`, { hasText: "DONE" }).waitFor();
  await toDept("DECISION");
  await panel().getByRole("textbox", { name: "Task" }).fill("Run the benchmark");
  known = await opIds();
  await add();
  op = await newOp(known);
  op = await until(async () => (await api("/api/office")).ops.find((o) => o.id === op.id && o.state === "done"), 60000);
  expect(op.ok && op.result.includes("0 wrong autonomous action(s)"), op.result);
  // a task the department does not know: the line says what it can do, before ADD
  await panel().getByRole("textbox", { name: "Task" }).fill("make me a sandwich");
  await page.locator(".o-hint.err").filter({ hasText: "Decision can:" }).waitFor();
  await panel().getByRole("textbox", { name: "Task" }).fill("");
});

await step("checklist 6: a task that needs an OK: Recalibrate → WAITING → APPROVE → DONE", async () => {
  await toDept("DECISION");
  await panel().getByRole("textbox", { name: "Task" }).fill("Recalibrate");
  await page.locator(".o-hint").filter({ hasText: "waits for your OK" }).waitFor();
  const known = await opIds();
  await add();
  const op = await newOp(known);
  const row = panel().locator(`.o-row[data-id="${op.id}"]`);
  await row.locator(".o-st", { hasText: "WAITING" }).waitFor();
  await row.click();
  await rail().locator(`.o-appr[data-op="${op.id}"]`).getByRole("button", { name: "APPROVE" }).click();
  const done = await until(async () => (await api("/api/office")).ops.find((o) => o.id === op.id && o.state === "done"));
  expect(done.ok && done.approved_by === ME, `${done.ok} ${done.approved_by}`);
  await row.locator(".o-st", { hasText: "DONE" }).waitFor();
  await page.keyboard.press("Escape");
});

await step("6 / checklist 7: “every minute check for drift” becomes a routine, runs within a minute, and DELETE removes it", async () => {
  await calm();
  await toDept("OVERSIGHT");
  await panel().getByRole("textbox", { name: "Task" }).fill("every minute check for drift");
  await page.locator(".o-hint").filter({ hasText: /⏱ Routine · every minute · Drift Monitor/i }).waitFor();
  const before = new Set((await api("/api/office")).routines.map((r) => r.id));
  await add();
  const r = await until(async () => (await api("/api/office")).routines.find((x) => !before.has(x.id)));
  expect(r.when.kind === "minutes" && r.when.every === 1 && r.kind === "drift-check", JSON.stringify(r));
  const ran = await until(async () => (await api("/api/office")).ops.find((o) => o.routine === r.id && o.state === "done"), 75000, 1000);
  expect(ran.ok && /no drift/.test(ran.result), `the routine's run: ${ran.result}`);
  await panel().getByRole("tab", { name: /^Scheduled\s*\d+$/ }).click();
  const row = panel().locator(".o-row", { hasText: r.desc }).filter({ hasText: `set by ${ME}` }).first();
  await row.getByRole("button", { name: "DELETE" }).click();
  await until(async () => !(await api("/api/office")).routines.some((x) => x.id === r.id));
  await panel().getByRole("tab", { name: /^All\s*\d+$/ }).click();
});

await step("7. Talk to the agents: click a name tag, ask “What are you working on?”, the answer comes from that agent", async () => {
  await calm();
  await page.keyboard.press("6");
  await rail().locator("h3", { hasText: "SUPPORT LEAD" }).waitFor();
  await page.locator('.o-pill[data-agent="trail"]').click();
  await rail().locator("h3", { hasText: "LEDGER TRAIL" }).waitFor();
  await rail().getByRole("button", { name: "What are you working on?" }).click();
  await rail().getByTestId("chat").getByText(/I'm Ledger Trail/).last().waitFor();
  await rail().getByRole("button", { name: "Back to the department lead" }).click();
  await rail().locator("h3", { hasText: "SUPPORT LEAD" }).waitFor();
  await page.keyboard.press("Escape");
});

let built;
await step("9. Flows: build the guide's morning audit flow (New, When, palette clicks wire themselves, Save) and Run it", async () => {
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.getByTestId("pipeline").waitFor();
  await page.getByRole("tab", { name: "Builder" }).click();
  await page.getByTestId("canvas").waitFor();
  const tool = (n) => page.locator(".fl-tools").getByRole("button", { name: n, exact: true });
  const side = page.locator('aside[aria-label="Settings"]');
  const fit = () => page.getByTestId("canvas").getByRole("button", { name: "Fit to screen" }).click();
  await tool("New").click();
  await page.getByRole("textbox", { name: "Flow name" }).fill(`${ME}'s morning check`);
  await page.locator('[data-node="start1"]').click({ position: { x: 60, y: 14 } });
  await side.getByRole("textbox", { name: "When" }).fill("every weekday at 9am");
  await page.locator('[data-palette="task"]').click();
  await side.getByRole("combobox", { name: "Department" }).selectOption("oversight");
  await side.locator(".fl-chip", { hasText: "Verify the audit trail" }).click();
  await page.locator('[data-palette="if"]').click();
  await side.getByRole("combobox", { name: "Check" }).selectOption("ok");
  await side.getByRole("combobox", { name: "How" }).selectOption("is");
  await side.getByRole("combobox", { name: "Value" }).selectOption("true");
  await page.locator('[data-palette="notify"]').click();
  await side.getByRole("textbox", { name: "Message" }).fill("Morning check: {result}");
  await fit();
  await page.locator('[data-node="if1"]').click({ position: { x: 60, y: 14 } });
  await page.locator('[data-palette="approval"]').click();
  await side.getByRole("textbox", { name: "Question" }).fill("The audit trail did not verify. Look at it now?");
  await fit();
  await tool("Save").click();
  await page.locator(".fl-tools").getByText(/^v1 · /).waitFor();
  const id = await page.getByRole("combobox", { name: "Flow" }).inputValue();
  built = (await api("/api/flows")).flows.find((f) => f.id === id);
  const port = (a, b) => built.edges.find((e) => e.from === a && e.to === b)?.port;
  expect(port("start1", "task1") && port("task1", "if1") && port("if1", "notify1") === "yes" && port("if1", "approval1") === "no", JSON.stringify(built.edges));
  expect(built.when?.kind === "weekdays" && built.when.at === "09:00", JSON.stringify(built.when));
  const before = new Set((await api("/api/flows")).runs.map((r) => r.id));
  await tool("Run").click();
  const r0 = await until(async () => (await api("/api/flows")).runs.find((r) => r.flow_id === id && !before.has(r.id)));
  const r = await until(async () => { const x = (await api("/api/flows")).runs.find((y) => y.id === r0.id); return x.state === "done" ? x : null; });
  expect(r.nodes.task1.state === "done" && r.nodes.if1.text.endsWith("→ yes") && r.nodes.notify1.state === "done" && r.nodes.approval1.state === "skipped", JSON.stringify(Object.fromEntries(Object.entries(r.nodes).map(([k, v]) => [k, v.state]))));
  await until(async () => (await page.locator('[data-node="notify1"]').getAttribute("data-state")) === "done");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/wf-flow.png` });
});

await step("checklist 8: Model health runs end to end, every node done, 100%", async () => {
  const mh = (await api("/api/flows")).flows.find((f) => f.name === "Model health");
  await page.getByRole("combobox", { name: "Flow" }).selectOption(mh.id);
  const before = new Set((await api("/api/flows")).runs.map((r) => r.id));
  await page.locator(".fl-tools").getByRole("button", { name: "Run", exact: true }).click();
  const r0 = await until(async () => (await api("/api/flows")).runs.find((r) => r.flow_id === mh.id && !before.has(r.id)));
  const r = await until(async () => { const x = (await api("/api/flows")).runs.find((y) => y.id === r0.id); return ["done", "failed"].includes(x.state) ? x : null; }, 60000);
  expect(r.state === "done" && r.progress === 1 && Object.values(r.nodes).every((n) => n.state === "done"), `${r.state} ${r.progress}`);
  await page.getByTestId("canvas").focus();
  await page.keyboard.press("Escape");
  await page.getByTestId("runs").getByText("100%").first().waitFor();
});

await step("checklist 9: Supervisor shows no drift alarm; Trail → Verify chain says Chain intact", async () => {
  await page.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: "Supervisor", exact: true }).click();
  await page.getByRole("heading", { name: "Supervisor console" }).waitFor();
  const d = (await api("/api/supervisor")).drift;
  expect(!d.alarm, `drift alarm on: ${d.reason}`);
  await page.getByText("within range").first().waitFor();
  await page.locator("section", { hasText: "Drift monitor" }).getByText("stable").first().waitFor();
  await page.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: "Trail", exact: true }).click();
  await page.getByRole("button", { name: "Verify chain" }).click();
  await page.getByText(/Chain intact: \d+ entries/).waitFor();
});

await step("clean up the flow this walk-through made", async () => {
  if (built) await api(`/api/flows/${built.id}?by=${encodeURIComponent(ME)}`, { method: "DELETE" });
});

await step("no uncaught errors and no server errors", async () => { expect(!errors.length, errors.join(" | ")); });

await browser.close();
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
