// The workspace, every control: navigation (buttons, keys, footer, phone tab bar), the case list and a
// case's tabs and actions (undo, audits, packet, .xlsx), Approvals (approve, edit the amount, reject, move
// the ground, tasks and flows waiting for an OK), the Supervisor (every α box, every autonomy rung, the
// action picker, recalibrate, drift, routines), the Brain, the Ledger (every outage, every outside event,
// reset), the Benchmark at k = 1, 2, 3, the Trail, Settings (server, evidence upload, restart), your name.
// Every action is checked on the server, not only on the screen.
// Usage: node e2e/fields-workspace.mjs   (NIRNAYA_URL, default http://127.0.0.1:8000; SHOTS=dir)
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL = process.env.NIRNAYA_URL ?? "http://127.0.0.1:8000";
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const results = [];
let page;
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push(true); console.log(`  ✓ ${name} (${Math.round((Date.now() - t0) / 1000)}s)`); }
  catch (e) { results.push(false); const lines = e.message.split("\n").filter((l) => l.trim()); console.log(`  ✗ ${name}\n      ${[lines[0], ...lines.slice(1).slice(-4)].join("\n      ")}`); if (SHOTS) await page.screenshot({ path: `${SHOTS}/ws-fail-${results.length}.png` }).catch(() => {}); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
const api = async (p, init) => (await fetch(URL + p, { headers: { "Content-Type": "application/json" }, ...init })).json();
const post = (p, b) => api(p, { method: "POST", body: JSON.stringify(b ?? {}) });
async function until(fn, ms = 25000, every = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, every)); }
  throw new Error("timed out waiting");
}
const finished = (id) => until(async () => { const c = await api(`/api/cases/${id}`); return c.status !== "running" ? c : null; });
const parked = (id) => until(async () => { const c = await api(`/api/cases/${id}`); return c.pending ? c : null; });

console.log(`Workspace, every control, against ${URL}`);
await post("/api/sim/reset");
const presets = Object.fromEntries((await api("/api/state")).presets.map((p) => [p.id, p]));
const open = async (id) => { const p = presets[id]; return (await post("/api/cases", { customer_id: p.customer, message: p.text, by: "Setup" })).id; };
// the cases this test works on
const C = { failed: await open("failed-past-tat"), dup: await open("duplicate"), unauthA: await open("unauthorized") };
await finished(C.failed); await finished(C.dup); await parked(C.unauthA);
C.unauthB = await open("unauthorized"); await parked(C.unauthB);
C.unauthC = await open("unauthorized"); await parked(C.unauthC);
// two tasks and two flow steps waiting for an OK
const opA = (await post("/api/office/tasks", { dept: "decision", text: "Recalibrate", by: "Setup" })).op;
const opB = (await post("/api/office/tasks", { dept: "decision", text: "Recalibrate", by: "Setup" })).op;
const gate = await post("/api/flows", { name: `Gate ${Date.now() % 10000}`, by: "Setup", nodes: [
  { id: "s", type: "start", x: 0, y: 0, config: {} }, { id: "a", type: "approval", x: 260, y: 0, config: { question: "Ship the weekly report?" } },
  { id: "y", type: "notify", x: 520, y: -80, config: { dept: "oversight", text: "Shipped: {result}" } },
  { id: "n", type: "notify", x: 520, y: 80, config: { dept: "oversight", text: "Held back: {result}" } },
], edges: [{ from: "s", to: "a", port: "next" }, { from: "a", to: "y", port: "yes" }, { from: "a", to: "n", port: "no" }] });
const runY = await post(`/api/flows/${gate.id}/run`, { by: "Setup" });
const runN = await post(`/api/flows/${gate.id}/run`, { by: "Setup" });
await until(async () => (await api("/api/flows")).waiting.length >= 2);

const browser = await chromium.launch({ channel: "chromium", args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 940 }, acceptDownloads: true });
page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
const nav = () => page.getByRole("navigation", { name: "Views" }).first();
const go = async (name) => { await nav().getByRole("button", { name, exact: true }).click(); await page.waitForTimeout(250); };
const toast = (re) => page.locator("[aria-live] button", { hasText: re }).first();
await page.goto(`${URL}/?as=Wendy`);
await page.locator(".o-root").waitFor();
await page.getByRole("button", { name: "Workspace", exact: true }).click();
await nav().waitFor();

const VIEWS = [
  ["Office", () => page.locator(".o-root").waitFor()],
  ["Cases", () => page.getByRole("textbox", { name: "Filter cases" }).waitFor()],
  ["Approvals", () => page.getByRole("heading", { name: "Approvals" }).waitFor()],
  ["Channels", () => page.getByRole("heading", { name: "Channels", exact: true }).waitFor()],
  ["Flows", () => page.getByTestId("pipeline").waitFor()],
  ["Supervisor", () => page.getByRole("heading", { name: "Supervisor console" }).waitFor()],
  ["Brain", () => page.getByText("Context graph").waitFor()],
  ["Ledger", () => page.getByRole("heading", { name: "Ledger", exact: true }).waitFor()],
  ["Benchmark", () => page.getByRole("heading", { name: "Simulated customers" }).waitFor()],
  ["Trail", () => page.getByRole("heading", { name: "Ledger Trail" }).waitFor()],
  ["Dashboard", () => page.getByTestId("dash-kpis").waitFor()],
  ["Settings", () => page.getByText("Use Nirnaya from another agent (MCP)").waitFor()],
];
await step("every view opens from its button, and the first ten from their key (1–9, 0); Dashboard and Settings have none", async () => {
  expect((await nav().getByRole("button").count()) === 12, "not twelve views");
  for (const [name, check] of VIEWS.slice(1)) { await go(name); await check(); }
  for (let i = 1; i < 10; i++) {
    await page.evaluate(() => document.activeElement?.blur()); // keys go to the page, not a focused field
    await page.keyboard.press(i === 9 ? "0" : String(i + 1));
    await VIEWS[i][1]();
  }
  expect((await nav().getByRole("button", { name: "Trail", exact: true }).getAttribute("title")) === "Trail (0)", "Trail is not key 0");
  expect((await nav().getByRole("button", { name: "Settings", exact: true }).getAttribute("title")) === "Settings", "Settings shows a key");
  expect((await nav().getByRole("button", { name: "Dashboard", exact: true }).getAttribute("title")) === "Dashboard", "Dashboard shows a key");
  await go("Office");
  await page.locator(".o-root").waitFor();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
});

await step("the header: the live log opens with the cases' steps, the theme switches, the footer's count goes to Approvals", async () => {
  await go("Cases");
  await page.getByRole("button", { name: "Toggle the live log" }).click();
  const log = page.locator(".font-mono.text-\\[11\\.5px\\]").last();
  await log.getByText(/NR-\d+ (learn|commit|route|parked|resolved)/).first().waitFor();
  await page.getByRole("button", { name: "Toggle the live log" }).click();
  const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  await page.getByRole("button", { name: "Toggle theme" }).click();
  expect((await page.evaluate(() => document.documentElement.classList.contains("dark"))) === !dark, "theme did not switch");
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.locator("footer").getByRole("button", { name: /awaiting approval/ }).click();
  await VIEWS[2][1]();
});

await step("Cases: the filter narrows the list; each tab of a case shows its part", async () => {
  await go("Cases");
  const f = page.getByRole("textbox", { name: "Filter cases" });
  await f.fill("Meera");
  const rows = await page.locator("aside button", { hasText: "NR-" }).allInnerTexts();
  expect(rows.length > 0 && rows.every((r) => r.includes("Meera")), `filter: ${rows}`);
  await f.fill("");
  await page.locator("aside button", { hasText: C.dup }).first().click();
  for (const [tab, what] of [["Timeline", "Supersteps"], ["Evidence", "Sentry and understanding"], ["Decision", "Calibrated"], ["Shadow & Seal", "Shadow ledger diff"], ["Trail & checkpoints", "Audit trail for this case"]]) {
    await page.getByRole("tab", { name: tab }).click();
    await page.getByText(what, { exact: false }).first().waitFor();
  }
  await page.getByRole("tab", { name: "Decision" }).click();
  await page.getByText("Features the score is built on").first().click();
  await page.getByText("intent_conf").first().waitFor();
  await page.getByRole("tab", { name: "Timeline" }).click();
});

await step("Cases: audit thumbs label the decision, Undo reverses the hedge, the tab closes", async () => {
  await page.locator("aside button", { hasText: C.failed }).first().click();
  await page.getByTitle("Audit: this autonomous decision was right").click();
  await toast("Labelled correct").waitFor();
  await until(async () => (await api(`/api/cases/${C.failed}`)).labels.some((l) => l.source === "audit" && l.correct));
  await page.locator("aside button", { hasText: C.dup }).first().click();
  await page.getByTitle("Audit: this autonomous decision was wrong").click();
  await until(async () => (await api(`/api/cases/${C.dup}`)).labels.some((l) => l.source === "audit" && !l.correct));
  await page.getByRole("button", { name: "Undo" }).click();
  await until(async () => (await api(`/api/cases/${C.dup}`)).decisions.some((d) => d.undone));
  const tr = (await api(`/api/cases/${C.dup}`)).trail.find((t) => t.kind === "action.undone");
  expect(tr && tr.actor === "Wendy", `undo by ${tr?.actor}`);
  await page.getByRole("button", { name: `Close ${C.dup}` }).click();
  await page.getByRole("button", { name: `Close ${C.dup}` }).waitFor({ state: "detached" });
});

await step("Cases: the evidence packet opens as a page, and Export .xlsx downloads a real workbook", async () => {
  await page.locator("aside button", { hasText: C.failed }).first().click();
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Packet" }).click()]);
  await popup.waitForLoadState();
  expect((await popup.content()).includes(C.failed), "the packet page does not show the case");
  await popup.close();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export .xlsx" }).click()]);
  const path = await dl.path();
  const buf = (await import("node:fs")).readFileSync(path);
  expect(dl.suggestedFilename() === `${C.failed}.xlsx` && buf.slice(0, 2).toString() === "PK", `download ${dl.suggestedFilename()}`);
  for (const sheet of ["xl/worksheets/sheet1.xml", "xl/worksheets/sheet4.xml"]) expect(buf.includes(Buffer.from(sheet)), `no ${sheet} in the workbook`);
});

await step("Approvals lists every kind of waiting item: sealed cases, department tasks, flow steps", async () => {
  await go("Approvals");
  for (const id of [C.unauthA, C.unauthB, C.unauthC]) await page.getByText(id, { exact: true }).first().waitFor();
  await page.getByText("Department tasks waiting for an OK").waitFor();
  await page.getByText(opA.id, { exact: true }).waitFor();
  await page.getByText("Flows asking a person").waitFor();
  expect((await page.getByText("Ship the weekly report?").count()) >= 2, "flow steps missing");
  const n = await nav().getByRole("button", { name: "Approvals" }).innerText();
  const w = (await api("/api/state")).waiting;
  expect(Number(n) === w.cases + w.ops + w.flows, `badge ${n} vs ${JSON.stringify(w)}`);
});

const card = (id) => page.locator("section", { has: page.getByText(id, { exact: true }) }).filter({ has: page.getByRole("button", { name: /Approve|Reject/ }) }).first();
await step("Approvals: Edit the amount, then Approve edited, commits the edited amount once", async () => {
  const c = card(C.unauthA);
  await c.getByRole("button", { name: "Edit" }).click();
  await c.getByRole("spinbutton", { name: "Amount for chargeback_credit" }).fill("12000");
  await c.getByRole("button", { name: "Approve edited" }).click();
  const d = await until(async () => { const x = await api(`/api/cases/${C.unauthA}`); return x.status === "resolved" ? x : null; });
  expect(d.commits.at(-1).edited && d.commits.at(-1).by === "Wendy", `commit ${JSON.stringify(d.commits.at(-1)).slice(0, 80)}`);
  const cb = d.decisions.find((x) => x.action.type === "chargeback_credit");
  expect(cb.committed && cb.action.amount === 12000, `chargeback ${cb.action.amount} committed=${cb.committed}`);
});

await step("Approvals: Reject closes the case with a specialist follow-up", async () => {
  await card(C.unauthB).getByRole("button", { name: "Reject" }).click();
  const d = await until(async () => { const x = await api(`/api/cases/${C.unauthB}`); return x.status === "resolved" ? x : null; });
  expect(d.decisions.some((x) => x.route === "REJECTED" && x.rejected_by === "Wendy"), "not rejected by Wendy");
  expect(d.conversation.at(-1).text.includes("specialist"), "no follow-up reply");
});

await step("Approvals: Move the ground, then Approve: the seal catches it and the case is re-sealed; approving again commits", async () => {
  const before = await api(`/api/cases/${C.unauthC}`);
  await card(C.unauthC).getByRole("button", { name: "Move the ground" }).click();
  await toast(/merchant refund|auto-reversal/).waitFor();
  await card(C.unauthC).getByRole("button", { name: "Approve" }).click();
  const moved = await until(async () => { const x = await api(`/api/cases/${C.unauthC}`); return x.seal_broken ? x : null; });
  expect(moved.seal_broken.why.includes("ledger moved"), moved.seal_broken.why);
  const again = await until(async () => { const x = await api(`/api/cases/${C.unauthC}`); return x.pending && x.pending.seal !== before.pending.seal ? x : x.status === "resolved" ? x : null; });
  if (again.pending) {
    await page.waitForTimeout(800);
    await card(C.unauthC).getByRole("button", { name: "Approve" }).click();
    await until(async () => (await api(`/api/cases/${C.unauthC}`)).status === "resolved");
  }
});

await step("Approvals: a department task approved here runs; one rejected with a note does not", async () => {
  const a = card(opA.id);
  await a.getByRole("button", { name: "Approve" }).click();
  const doneA = await until(async () => (await api("/api/office")).ops.find((o) => o.id === opA.id && o.state === "done"));
  expect(doneA.ok && doneA.approved_by === "Wendy", `A: ${doneA.ok} ${doneA.approved_by}`);
  const b = card(opB.id);
  await b.getByRole("textbox", { name: `Note for ${opB.id}` }).fill("labels are too few");
  await b.getByRole("button", { name: "Reject" }).click();
  const doneB = await until(async () => (await api("/api/office")).ops.find((o) => o.id === opB.id && o.state === "done"));
  expect(doneB.rejected && doneB.note === "labels are too few" && doneB.rejected_by === "Wendy", `B: ${JSON.stringify(doneB).slice(0, 100)}`);
});

await step("Approvals: a flow step answered Yes goes down its yes wire; No with a note goes down no", async () => {
  const flowCard = (rid) => page.locator("section", { has: page.getByText(rid, { exact: true }) }).first();
  await flowCard(runY.id).getByRole("button", { name: "Yes" }).click();
  await flowCard(runN.id).getByRole("textbox", { name: `Note for ${runN.id}` }).fill("not this week");
  await flowCard(runN.id).getByRole("button", { name: "No" }).click();
  const runs = await until(async () => { const r = (await api("/api/flows")).runs; const y = r.find((x) => x.id === runY.id), n = r.find((x) => x.id === runN.id); return y?.state === "done" && n?.state === "done" ? { y, n } : null; });
  expect(runs.y.nodes.y.state === "done" && runs.y.nodes.n.state === "skipped", "yes run took the wrong wire");
  expect(runs.n.nodes.n.state === "done" && runs.n.nodes.y.state === "skipped" && runs.n.nodes.a.text.includes("not this week"), "no run took the wrong wire");
  // both flow questions are answered: the flows section empties (other people's items may still wait)
  await until(async () => (await api("/api/flows")).waiting.length === 0);
  await page.getByText("Flows asking a person").waitFor({ state: "detached" });
});

await step("Supervisor: every α box and every autonomy rung changes that action's policy on the server (8 actions)", async () => {
  await go("Supervisor");
  const actions = (await api("/api/supervisor")).actions;
  expect(actions.length === 8, `${actions.length} actions`);
  const bad = [];
  for (const a of actions) {
    const box = page.getByRole("spinbutton", { name: `Error ceiling for ${a.label}` });
    const want = Math.min(25, Math.round(a.alpha * 100 * 2 * 100) / 100);
    await box.fill(String(want));
    await box.blur();
    const got = await until(async () => { const x = (await api("/api/supervisor")).actions.find((y) => y.id === a.id); return Math.abs(x.alpha * 100 - want) < 1e-6 ? x : null; }).catch(() => null);
    if (!got) bad.push(`${a.label}: α did not become ${want}%`);
    const group = page.getByRole("radiogroup", { name: `Autonomy for ${a.label}` });
    for (const [i, r] of ["Suggest", "Hedge", "Act"].entries()) {
      await group.getByRole("radio", { name: r }).click();
      const ok = await until(async () => (await api("/api/supervisor")).actions.find((y) => y.id === a.id).rung === i, 8000).catch(() => false);
      if (!ok) bad.push(`${a.label}: rung ${r} not applied`);
      const shown = await until(async () => (await group.getByRole("radio", { name: r }).getAttribute("aria-checked")) === "true", 5000).catch(() => false);
      if (!shown) bad.push(`${a.label}: ${r} not shown as picked`);
    }
    // put it back as it was
    await box.fill(String(Math.round(a.alpha * 100 * 100) / 100));
    await box.blur();
    await group.getByRole("radio", { name: ["Suggest", "Hedge", "Act"][a.rung] }).click();
    await until(async () => { const x = (await api("/api/supervisor")).actions.find((y) => y.id === a.id); return x.rung === a.rung && Math.abs(x.alpha - a.alpha) < 1e-9; }, 8000).catch(() => bad.push(`${a.label}: not restored`));
  }
  const tr = (await api("/api/trail?limit=40")).filter((t) => t.kind === "policy.changed");
  if (!tr.every((t) => t.actor === "Wendy")) bad.push("policy changes not attributed to Wendy");
  expect(!bad.length, bad.join(" · "));
});

await step("Supervisor: the action picker redraws the chart for every action", async () => {
  const sel = page.getByRole("combobox", { name: "Action" });
  const opts = await sel.locator("option").evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
  expect(opts.length === 8, `${opts.length} options`);
  for (const [v, label] of opts) {
    await sel.selectOption(v);
    await page.getByRole("img", { name: `Deflection versus precision for ${label}` }).waitFor();
  }
});

await step("Supervisor: Recalibrate, Inject drift, Clear, and each routine's Run", async () => {
  const labels = (await api("/api/supervisor")).stats.labels;
  await page.getByRole("button", { name: /^Recalibrate with/ }).click();
  await toast("Recalibrated").waitFor();
  expect((await api("/api/supervisor")).calibration.real_labels === labels, "calibration did not use the labels");
  await page.getByRole("button", { name: "Inject drift" }).click();
  await until(async () => (await api("/api/supervisor")).drift.alarm);
  await page.getByText("failing closed").first().waitFor();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await until(async () => !(await api("/api/supervisor")).drift.alarm);
  const routines = (await api("/api/supervisor")).routines;
  for (const r of routines) {
    const li = page.locator("li", { hasText: r.name }).first();
    await li.getByRole("button", { name: "Run" }).click();
    await until(async () => ((await api("/api/supervisor")).routines.find((x) => x.id === r.id)?.runs ?? 0) > (r.runs ?? 0), 40000);
  }
});

await step("Brain: highlight, pick a node, follow a link, search the case memory", async () => {
  await go("Brain");
  await page.locator("svg g title", { hasText: "customer:" }).first().waitFor({ state: "attached" });
  await page.getByRole("textbox", { name: "Highlight nodes" }).fill("C-1002");
  await page.locator("svg g", { has: page.locator("title", { hasText: "customer: C-1002" }) }).first().click(); // the Brain names customers by id (what the agents see)
  await page.locator("h3 .font-mono", { hasText: "customer:C-1002" }).waitFor();
  const link = page.locator("section", { has: page.locator("h3 .font-mono") }).locator("ul button").first();
  const to = await link.innerText();
  await link.click();
  if (!to.startsWith("case:")) await page.locator("h3 .font-mono", { hasText: to }).waitFor();
  await go("Brain");
  await page.getByRole("textbox", { name: "Search memory" }).fill("charged twice duplicate");
  await page.getByRole("textbox", { name: "Search memory" }).press("Enter");
  await page.getByText("Refund duplicate").first().waitFor();
  // a hit from this server's own cases opens the case; a past case from the seed history is plain text
  expect((await page.getByRole("button", { name: /^H-\d+$/ }).count()) === 0, "past-case ids look clickable but have no page");
  const own = page.getByRole("button", { name: /^NR-\d+$/ }).first();
  await own.waitFor();
  const id = await own.innerText();
  await own.click();
  await page.locator("h2.font-mono", { hasText: id }).waitFor();
});

await step("Ledger: the spreadsheet loads; every system's outage switches on and off", async () => {
  await go("Ledger");
  await page.locator("canvas:visible").first().waitFor({ timeout: 30000 }); // the sheet (Univer also keeps a hidden doc canvas)
  const systems = ["UPI switch", "Core banking", "Refund engine", "CRM", "Wallet ledger", "Dispute desk", "Card & UPI control", "Messaging"];
  for (const s of systems) {
    const b = page.getByRole("button", { name: s, exact: true });
    await b.click();
    await page.getByRole("button", { name: `${s} · down` }).waitFor();
    expect((await api("/api/ledger")).down.includes(s), `${s} not down on the server`);
    await page.getByRole("button", { name: `${s} · down` }).click();
    await page.getByRole("button", { name: s, exact: true }).waitFor();
    expect(!(await api("/api/ledger")).down.includes(s), `${s} still down`);
  }
  await page.getByRole("button", { name: "Refresh" }).click();
});

await step("Ledger: each payment's outside event lands once (the right kind), then Reset world puts it back", async () => {
  await page.getByRole("button", { name: "Reset world" }).click();
  await until(async () => (await api("/api/ledger")).transactions.every((t) => t.version === 1));
  const before = (await api("/api/ledger")).transactions;
  const bad = [];
  for (const t of before) {
    const b = page.getByRole("button", { name: `Move the ground on ${t.id}` });
    if (!t.can) { if (!(await b.isDisabled())) bad.push(`${t.id} should be disabled`); continue; }
    await b.click();
    const after = await until(async () => { const x = (await api("/api/ledger")).transactions.find((y) => y.id === t.id); return x.version > t.version ? x : null; });
    if (t.can === "reversal_lands" && after.reversal !== "REVERSED") bad.push(`${t.id}: not reversed`);
    if (t.can === "merchant_refund" && after.refund !== "PROCESSED") bad.push(`${t.id}: not refunded`);
    await until(async () => b.isDisabled(), 8000).catch(() => bad.push(`${t.id}: button still enabled after it landed`));
  }
  const kinds = before.map((t) => t.can);
  expect(kinds.includes("reversal_lands") && kinds.includes("merchant_refund"), `kinds ${kinds}`);
  await page.getByRole("button", { name: "Reset world" }).click();
  await until(async () => (await api("/api/ledger")).transactions.every((t) => t.version === 1));
  expect(!bad.length, bad.join(" · "));
});

await step("Ledger: feed your own data: Preview refuses a bad row and saves nothing, Import keeps the good one, Remove takes it out", async () => {
  await page.getByLabel("What to import").selectOption("customers");
  await page.getByLabel("CSV text").fill("name,phone,upi_id\nKavya Rao,+91 98450 12345,kavya.rao@okaxis\nK,12345,bad@@\n");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByTestId("import-result").getByText(/1 pass/i).waitFor();
  await page.locator('li[data-line="3"]').getByText(/10-digit Indian mobile/).waitFor();
  expect(!(await api("/api/state")).customers.some((c) => c.name === "Kavya Rao"), "a preview saved a customer");
  await page.getByRole("button", { name: /^Import \d/ }).click();
  const b = await until(async () => (await api("/api/data")).batches.find((x) => x.customers === 1));
  expect((await api("/api/state")).customers.some((c) => c.name === "Kavya Rao"), "the good row was not imported");
  await page.locator(`li[data-batch="${b.batch}"]`).getByRole("button", { name: /^Remove/ }).click();
  await until(async () => !(await api("/api/data")).batches.some((x) => x.batch === b.batch));
  expect(!(await api("/api/state")).customers.some((c) => c.name === "Kavya Rao"), "Remove left the customer");
});

await step("Benchmark: k = 1, 2 and 3 each run and are archived", async () => {
  await go("Benchmark");
  for (const k of ["1", "2", "3"]) {
    const n = (await api("/api/benchmark/runs")).length;
    await page.getByLabel("k", { exact: true }).selectOption(k);
    await page.getByRole("button", { name: "Run benchmark" }).click();
    await page.getByText(`pass^${k}`, { exact: true }).first().waitFor({ timeout: 90000 });
    await page.getByRole("button", { name: "Run benchmark" }).waitFor({ timeout: 90000 });
    const runs = await until(async () => { const r = await api("/api/benchmark/runs"); return r.length > n ? r : null; }, 90000);
    const last = runs[0].k === Number(k) ? runs[0] : runs.find((r) => r.k === Number(k));
    expect(last && last.wrong_autonomous === 0, `k=${k}: ${JSON.stringify(last).slice(0, 80)}`);
  }
});

await step("Trail: Verify chain says intact; Tamper test catches the edit; a case link opens the case", async () => {
  await go("Trail");
  await page.getByRole("button", { name: "Verify chain" }).click();
  await page.getByText(/Chain intact: \d+ entries/).waitFor();
  await page.getByRole("button", { name: "Tamper test" }).click();
  await page.getByText(/Chain broken at entry #\d+/).waitFor();
  await page.locator("table button", { hasText: C.failed }).first().click();
  await page.getByRole("tab", { name: "Timeline" }).waitFor();
  expect((await page.locator("h2.font-mono").innerText()).includes(C.failed), "the case did not open");
});

await step("Settings, language model: every free provider's row, the order, a key saved and never shown, Test on a stand-in model, off and on", async () => {
  // a stand-in OpenAI-compatible server, as LM Studio, llamafile or Ollama would be
  const { createServer } = await import("node:http");
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "tiny-local-1b" }, { id: "nomic-embed" }] }));
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  try {
    await go("Settings");
    const rows = page.locator("[data-provider]");
    await rows.first().waitFor();
    const ids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-provider")));
    expect(JSON.stringify(ids) === JSON.stringify(["groq", "gemini", "openrouter", "mistral", "ollama", "custom"]), `rows ${ids}`);
    for (const id of ids) {
      const r = page.locator(`[data-provider="${id}"]`);
      for (const name of ["Save", "Test"]) expect(await r.getByRole("button", { name }).count() === 1, `${id}: no ${name}`);
      expect(await r.getByRole("combobox").count() === 1, `${id}: no model menu`);
      expect(/free|computer|server/i.test(await r.innerText()), `${id}: no free-tier note`);
    }
    // order: move Gemini up, then back
    await page.getByRole("button", { name: "Move Google Gemini up" }).click();
    await until(async () => (await api("/api/llm")).providers[0].id === "gemini");
    await page.getByRole("button", { name: "Move Google Gemini down" }).click();
    await until(async () => (await api("/api/llm")).providers[0].id === "groq");
    // a key saves on the server and the page never gets it back
    const groq = page.locator('[data-provider="groq"]');
    await groq.getByLabel("Groq key").fill("gsk_e2e_secret_key");
    await groq.getByRole("button", { name: "Save" }).click();
    await toast("Groq saved").waitFor();
    const d = await api("/api/llm");
    expect(d.providers[0].key_set && !JSON.stringify(d).includes("gsk_e2e_secret_key"), "the key came back");
    await groq.getByPlaceholder(/saved/).waitFor();
    await groq.getByText("Remove the saved key").click();
    await until(async () => !(await api("/api/llm")).providers[0].key_set);
    // a local server: Test lists its chat models (not the embedding one) and says it works
    const custom = page.locator('[data-provider="custom"]');
    await custom.getByLabel("Use Another OpenAI-compatible server").check();
    await custom.getByLabel("Another OpenAI-compatible server address").fill(`http://127.0.0.1:${fake.address().port}/v1`);
    await custom.getByRole("button", { name: "Test" }).click();
    const res = custom.getByTestId("test-custom");
    await until(async () => /Works: tiny-local-1b answered “OK”/.test(await res.innerText()), 20000);
    expect(/1 free model/.test(await res.innerText()), await res.innerText());
    await until(async () => (await api("/api/state")).integrations.llm.enabled);
    // the top bar names it (its label shows on wide screens, so read the text itself)
    await until(async () => /REASONS WITH LOCAL/.test(await page.getByTestId("reasons-with").first().textContent()));
    // the master switch, then tidy up
    await page.getByLabel("Use a language model").uncheck();
    await until(async () => !(await api("/api/state")).integrations.llm.enabled);
    await page.getByLabel("Use a language model").check();
    await custom.getByLabel("Use Another OpenAI-compatible server").uncheck();
    await until(async () => !(await api("/api/state")).integrations.llm.enabled);
  } finally {
    fake.close();
  }
});

await step("Settings: the server address saves and stays live; an evidence file is parsed; restart keeps parked approvals", async () => {
  await go("Settings");
  const box = page.getByRole("textbox", { name: "Server URL" });
  const saveServer = page.locator("form", { has: box }).getByRole("button", { name: "Save", exact: true });
  await box.fill(URL);
  await saveServer.click();
  await toast("Server updated").waitFor();
  await page.getByText("LIVE").first().waitFor();
  await box.fill("");
  await saveServer.click();
  const f = join(tmpdir(), `statement-${Date.now()}.txt`);
  writeFileSync(f, "Bank statement\n30 Sep: UPI debit ₹18,500 to QuickPay Store, UTR 412345678906, not done by me.\nCall me on 9123456789.");
  await page.locator('input[type="file"]').setInputFiles(f);
  await page.getByText(/UTRs: 412345678906/).waitFor();
  await page.getByText(/identifier\(s\) tokenised/).waitFor();
  expect(!(await page.locator("pre").last().innerText()).includes("9123456789"), "the phone number was not tokenised");
  expect((await page.locator("pre").first().innerText()).includes("/mcp"), "no MCP address");
  const pending = await post("/api/cases", { customer_id: "C-1003", by: "Wendy", message: presets.unauthorized.text });
  await parked(pending.id);
  await page.getByRole("button", { name: "Simulate a crash and restart" }).click();
  await toast(/Restarted from checkpoints/).waitFor();
  expect((await api("/api/approvals")).some((a) => a.case.id === pending.id), "the parked approval did not survive the restart");
  await post(`/api/cases/${pending.id}/reject`, { by: "Wendy", note: "cleanup" });
});

await step("your name from the workspace header", async () => {
  await page.getByRole("button", { name: "Your name" }).click();
  await page.locator("#my-name").fill("Wendy W");
  await page.locator("form", { has: page.locator("#my-name") }).getByRole("button", { name: "Save" }).click();
  await until(async () => (await api("/api/team")).people.some((p) => p.name === "Wendy W"));
});

await step("on a phone: the tab bar's seven tabs each open their view, with nothing off the screen; Cases shows the list or a case", async () => {
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  phone.on("pageerror", (e) => errors.push(`phone: ${e.message}`));
  await phone.goto(`${URL}/?as=Pat`);
  await phone.locator(".o-root").waitFor();
  await phone.getByRole("button", { name: "Workspace", exact: true }).click();
  const bar = phone.getByRole("navigation", { name: "Views" }).last();
  const tabs = await bar.getByRole("button").allInnerTexts();
  expect(tabs.map((t) => t.trim()).join() === "Office,Cases,Approvals,Channels,Flows,Dashboard,Settings", `tabs ${tabs}`);
  for (const t of ["Cases", "Approvals", "Channels", "Flows", "Dashboard", "Settings"]) {
    await bar.getByRole("button", { name: t }).click();
    await phone.waitForTimeout(600);
    expect(!(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), `${t} scrolls sideways`);
  }
  // Cases on a phone: the list fills the screen; a case opens over it; ◂ Cases goes back
  await bar.getByRole("button", { name: "Cases" }).click();
  const filter = phone.getByRole("textbox", { name: "Filter cases" });
  await filter.waitFor();
  expect((await filter.boundingBox()).width > 300, "the case list does not fill the phone");
  const first = phone.locator("aside button").filter({ hasText: /NR-\d+/ }).first();
  const id = (await first.innerText()).match(/NR-\d+/)[0];
  await first.click();
  await phone.getByRole("button", { name: "Back to the cases" }).waitFor();
  expect(!(await filter.isVisible()), "the list is still beside the case");
  await phone.getByRole("tab", { name: "Timeline" }).waitFor();
  expect((await phone.getByRole("button", { name: "Back to the cases" }).boundingBox()).x < 40, "no back button at the left");
  expect(!(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), `${id} scrolls sideways`);
  await phone.getByRole("button", { name: "Back to the cases" }).click();
  await filter.waitFor();
  await bar.getByRole("button", { name: "Office" }).click();
  await phone.locator(".o-root").waitFor();
  await phone.close();
});

await step("no uncaught errors and no server errors", async () => { expect(!errors.length, errors.join(" | ")); });
await browser.close();
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
