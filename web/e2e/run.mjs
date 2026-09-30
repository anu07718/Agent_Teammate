// End-to-end: drives the real web app against a running Nirnaya server (default http://127.0.0.1:8000).
// Usage: npm run e2e            (NIRNAYA_URL to point elsewhere; SHOTS=dir to save screenshots)
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const URL = process.env.NIRNAYA_URL ?? "http://127.0.0.1:8000";
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✗ ${name}\n      ${e.message.split("\n")[0]}`);
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const api = async (path, init) => (await fetch(URL + path, init)).json();
async function waitFor(fn, ms = 15000, every = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error("timed out waiting");
}

// the office is a WebGL scene: software GL keeps it running headless
const browser = await chromium.launch({ channel: "chromium", args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 940 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const nav = () => page.getByRole("navigation", { name: "Views" }).first();
const go = (name) => nav().getByRole("button", { name, exact: true }).click();
const shot = (n) => SHOTS && page.screenshot({ path: `${SHOTS}/${n}.png` });
const panel = () => page.getByTestId("task-panel");
const rail = () => page.getByTestId("rail");
const newCase = async (known, pred = () => true) => waitFor(async () => {
  const cs = await api("/api/cases");
  return cs.find((c) => !known.has(c.id) && c.status !== "running" && pred(c)) ?? null;
});
async function sample(label) {
  await panel().getByRole("button", { name: "Samples", exact: true }).click();
  await page.locator(".o-menu button", { hasText: label }).first().click();
  await panel().getByRole("button", { name: "ADD", exact: true }).click();
}
async function toDept(name) {
  await panel().getByRole("button", { name: "Department" }).click();
  await page.locator(".o-menu button", { hasText: name }).first().click();
}
async function typeTask(text) {
  await panel().getByRole("textbox", { name: "Task" }).fill(text);
}

console.log(`Nirnaya e2e against ${URL}`);
await api("/api/sim/reset", { method: "POST" });

await step("the office loads: six departments, nineteen desks, live", async () => {
  await page.goto(URL, { waitUntil: "load" });
  await page.getByText("LIVE · NIRNAYA").waitFor({ timeout: 12000 });
  await waitFor(async () => (await page.locator("[data-pod]").count()) === 6);
  await waitFor(async () => (await page.locator(".o-pill[data-agent]").count()) === 19);
  await page.locator("[data-conn]").first().waitFor();
  await shot("e2e-01-office");
});

await step("a customer message from the bar: a failed UPI debit is reversed with compensation, alone", async () => {
  const known = new Set((await api("/api/cases")).map((c) => c.id));
  await sample("Failed UPI, 3 days late");
  const c = await newCase(known);
  const d = await api(`/api/cases/${c.id}`);
  const r = Object.fromEntries(d.decisions.map((x) => [x.action.type, x.route]));
  expect(r.reverse_failed_debit === "ACT" && r.tat_compensation === "ACT", `routes ${JSON.stringify(r)}`);
  expect(d.guard.ok && c.owner === "upi", "reply failed the Promise Guard, or the wrong desk owns it");
  await page.locator(`.o-row[data-id="${c.id}"] .o-st`, { hasText: "DONE" }).waitFor();
});

let parked;
await step("an unauthorised ₹18,500 is blocked now and the credit waits, sealed, at the Risk desk", async () => {
  const known = new Set((await api("/api/cases")).map((c) => c.id));
  await sample("Unauthorised ₹18,500");
  parked = await waitFor(async () => (await api("/api/approvals")).find((a) => !known.has(a.case.id)));
  expect(parked.pending.seal && parked.pending.actions[0].type === "chargeback_credit", "nothing sealed");
  await page.locator(`.o-row[data-id="${parked.case.id}"] .o-st`, { hasText: "WAITING" }).click();
  await rail().locator(`.o-appr[data-case="${parked.case.id}"]`).getByText("SEALED EVIDENCE PACKET").waitFor();
  await rail().getByText("RISK & FRAUD").first().waitFor();
  await shot("e2e-02-approval");
});

await step("moving the ground from the chat makes the old approval not apply", async () => {
  // the chat is shared and kept on the server, so earlier runs' replies may be there: wait for a new one
  const before = await rail().getByText(/ledger moved to version/).count();
  await rail().getByRole("button", { name: "move the ground" }).click();
  await waitFor(async () => (await rail().getByText(/ledger moved to version/).count()) > before);
  await rail().locator(`.o-appr[data-case="${parked.case.id}"]`).getByRole("button", { name: "APPROVE" }).click();
  const c = await waitFor(async () => {
    const d = await api(`/api/cases/${parked.case.id}`);
    return d.seal_broken ? d : null;
  });
  expect(c.seal_broken.why.includes("ledger moved"), c.seal_broken.why);
});

await step("the re-sealed approval then commits exactly once", async () => {
  const again = await waitFor(async () => (await api("/api/approvals")).find((a) => a.case.id === parked.case.id));
  expect(again.pending.seal !== parked.pending.seal, "seal did not change");
  await page.waitForTimeout(600);
  await rail().locator(`.o-appr[data-case="${parked.case.id}"]`).getByRole("button", { name: "APPROVE" }).click();
  await waitFor(async () => (await api(`/api/cases/${parked.case.id}`)).status === "resolved");
});

await step("a task typed to a department runs there: Oversight verifies the audit trail", async () => {
  await page.keyboard.press("Escape");
  await toDept("OVERSIGHT");
  await typeTask("verify the audit trail");
  await panel().getByText("LEDGER TRAIL").first().waitFor();
  const known = new Set((await api("/api/office")).ops.map((o) => o.id));
  await panel().getByRole("button", { name: "ADD", exact: true }).click();
  const op = await waitFor(async () => (await api("/api/office")).ops.find((o) => !known.has(o.id) && o.state === "done"));
  expect(op.ok && op.result.includes("Chain intact"), op.result);
});

await step("an op that would change the model waits for your OK; REJECT with a note stops it", async () => {
  await toDept("DECISION");
  await typeTask("Recalibrate");
  const known = new Set((await api("/api/office")).ops.map((o) => o.id));
  await panel().getByRole("button", { name: "ADD", exact: true }).click();
  const op = await waitFor(async () => (await api("/api/office")).ops.find((o) => !known.has(o.id) && o.state === "waiting"));
  await page.locator(`.o-row[data-id="${op.id}"]`).click();
  await rail().locator(`.o-appr[data-op="${op.id}"]`).getByRole("button", { name: "REJECT" }).click();
  await rail().getByRole("textbox", { name: "Message" }).fill("not before the audit");
  await rail().getByRole("button", { name: "SEND" }).click();
  const done = await waitFor(async () => (await api("/api/office")).ops.find((o) => o.id === op.id && o.state === "done"));
  expect(done.rejected && done.result.includes("not before the audit"), done.result);
  await page.keyboard.press("Escape");
});

await step("a routine in plain words lands on the timetable and runs on RUN NOW", async () => {
  await toDept("OVERSIGHT");
  await typeTask("every weekday at 9am, write today's digest");
  await panel().getByText(/every weekday · 09:00/).waitFor();
  await panel().getByRole("button", { name: "ADD", exact: true }).click();
  const r = await waitFor(async () => (await api("/api/office")).routines.find((x) => x.kind === "digest" && x.by !== "system"));
  const row = panel().locator(".o-row", { hasText: r.title }).first();
  await row.getByRole("button", { name: "RUN NOW" }).click();
  await waitFor(async () => (await api("/api/office")).ops.some((o) => o.routine === r.id && o.state === "done"));
  await api(`/api/office/routines/${r.id}`, { method: "DELETE" });
});

await step("the board, the Brain and the calendar open on their keys", async () => {
  await page.locator(".o-top").click({ position: { x: 700, y: 26 } });
  await page.keyboard.press("b");
  await page.locator(".o-board.on").waitFor();
  await shot("e2e-03-board");
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.locator(".o-brain.on").waitFor();
  await page.getByText(/NODES · \d+ LINKS/).waitFor();
  await page.keyboard.press("Escape");
  await page.keyboard.press("p");
  await page.locator(".o-cal.on").waitFor();
  await page.locator(".o-cal").getByText("Nightly benchmark").first().waitFor();
  await shot("e2e-04-calendar");
  await page.keyboard.press("Escape");
  await page.keyboard.press("d");
  await page.locator(".o-root.o-dark").waitFor();
  await page.keyboard.press("d");
});

await step("the workspace: a duplicate charge is hedged, then undone from the case view", async () => {
  // pin the action to "act with an undo" so the check does not depend on what the office has learned
  const pin = (rung) => api("/api/supervisor/policy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "refund_duplicate", rung }) });
  await pin(1);
  const known = new Set((await api("/api/cases")).map((c) => c.id));
  await toDept("INTAKE");
  await sample("Charged twice");
  const c = await newCase(known, (k) => k.intent === "duplicate_charge");
  expect(c.route === "HEDGE", `route ${c.route}`);
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await nav().waitFor();
  await go("Cases");
  await page.locator("aside").getByText(c.id).first().click();
  await page.getByRole("button", { name: /Undo/ }).click();
  await waitFor(async () => (await api(`/api/cases/${c.id}`)).decisions.some((d) => d.undone));
  await pin(2);
  await shot("e2e-05-case");
});

await step("the supervisor dial changes policy and re-certifies thresholds", async () => {
  const h0 = (await api("/api/health")).policy_hash;
  await go("Supervisor");
  const dial = page.getByRole("radiogroup", { name: "Autonomy for Raise a dispute with the other bank" });
  await dial.getByRole("radio", { name: "Hedge" }).click();
  await waitFor(async () => (await api("/api/health")).policy_hash !== h0);
  await waitFor(async () => (await dial.getByRole("radio", { name: "Hedge" }).getAttribute("aria-checked")) === "true");
  await dial.getByRole("radio", { name: "Act" }).click();
  await waitFor(async () => (await api("/api/supervisor")).actions.find((a) => a.id === "raise_dispute").rung === 2);
});

await step("the simulated-customer benchmark passes with no wrong autonomous action", async () => {
  await go("Benchmark");
  await page.getByRole("button", { name: /Run benchmark/ }).click();
  await page.getByText("Wrong autonomous actions").waitFor();
  const runs = await api("/api/benchmark/runs");
  expect(runs[0].wrong_autonomous === 0 && runs[0].pass_k >= 0.9, JSON.stringify(runs[0]));
});

await step("the audit chain verifies, and a tampered copy is caught", async () => {
  await go("Trail");
  await page.getByRole("button", { name: /Verify chain/ }).click();
  await page.getByText(/Chain intact/).waitFor();
  await page.getByRole("button", { name: /Tamper test/ }).click();
  await page.getByText(/Chain broken at entry/).waitFor();
});

await step("a crash and restart keeps parked approvals", async () => {
  const known = new Set((await api("/api/cases")).map((c) => c.id));
  await api("/api/cases", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customer_id: "C-1003", message: "There is a transaction of ₹18,500 at QuickPay Store that was not done by me, please help" }) });
  const id = await waitFor(async () => (await api("/api/approvals")).find((a) => !known.has(a.case.id))?.case.id);
  await go("Settings");
  await page.getByRole("button", { name: /Simulate a crash/ }).click();
  await page.getByText(/Restarted from checkpoints/).waitFor();
  const still = await api("/api/approvals");
  expect(still.some((a) => a.case.id === id), "approval lost in restart");
  await waitFor(async () => (await api(`/api/cases/${id}`)).status === "parked");
  const ok = await api(`/api/cases/${id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ by: "e2e" }) });
  expect(ok.status === "resolved", `status ${ok.status}`);
});

await step("the other workspace views render (brain, ledger), and Office goes back", async () => {
  await go("Brain");
  await page.getByText("Context graph").waitFor();
  await go("Ledger");
  await page.getByText("Live systems (simulated)").waitFor();
  await page.waitForTimeout(2500);
  await go("Office");
  await page.getByTestId("office").waitFor();
});

await step("on a phone the panel is a sheet under the office, and the workspace has a tab bar", async () => {
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.goto(URL, { waitUntil: "load" });
  await phone.getByTestId("task-panel").waitFor();
  if (SHOTS) await phone.screenshot({ path: `${SHOTS}/e2e-06-phone-office.png` });
  await phone.getByRole("button", { name: "Workspace", exact: true }).click();
  await phone.getByRole("navigation", { name: "Views" }).last().getByRole("button", { name: "Approvals" }).click();
  await phone.getByText("Approvals").first().waitFor();
  if (SHOTS) await phone.screenshot({ path: `${SHOTS}/e2e-07-phone.png` });
  await phone.close();
});

await step("no uncaught errors in the page", async () => expect(!errors.length, errors.join(" | ")));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
