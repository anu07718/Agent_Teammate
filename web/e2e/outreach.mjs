// Outreach in a real browser: a sentence typed to Intake asks back for what is missing, then shows the desks
// it will go through; a payment waits in the office for an OK, is sealed, paid once and messaged through n8n
// (a stand-in started here that answers like the workflow in n8n); a request goes out with no OK; Settings →
// Outreach shows the routes and tests n8n; the Ledger shows the payout.
// Usage: node e2e/outreach.mjs   (NIRNAYA_URL, default http://127.0.0.1:8000; SHOTS=dir)
import { chromium } from "playwright";
import { createServer } from "node:http";
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
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/outreach-fail-${results.length}.png` }).catch(() => {});
  }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
const api = async (p, init) => (await fetch(URL + p, { headers: { "Content-Type": "application/json" }, ...init })).json();
async function until(fn, ms = 30000, every = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, every)); }
  throw new Error("timed out waiting");
}

// the n8n workflow, as a stand-in: checks the token, answers a dry run, "sends" the rest
const TOKEN = "tok-e2e-outreach";
const posts = [];
const n8n = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const j = JSON.parse(body || "{}");
    const send = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers["x-nirnaya-token"] !== TOKEN) return send(401, { ok: false, error: "bad token" });
    posts.push(j);
    if (j.dry_run) return send(200, { ok: true, dry_run: true, id: "dry-run" });
    send(200, { ok: true, channel: j.channel, id: `n8n-${posts.length}` });
  });
});
await new Promise((r) => n8n.listen(0, "127.0.0.1", r));
const N8N = `http://127.0.0.1:${n8n.address().port}/webhook/nirnaya-outreach`;

console.log(`Outreach, in a browser, against ${URL}`);
const browser = await chromium.launch({ channel: "chromium", args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 940 } });
page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });

const panel = () => page.getByTestId("task-panel");
const rail = () => page.getByTestId("rail");
const box = () => panel().getByRole("textbox", { name: "Task" });
const hint = (re) => page.locator(".o-hint").filter({ hasText: re });
const add = () => panel().getByRole("button", { name: "ADD", exact: true }).click();
const opIds = async () => new Set((await api("/api/office")).ops.map((o) => o.id));
const newOp = async (known) => until(async () => (await api("/api/office")).ops.find((o) => !known.has(o.id) && o.kind === "outreach"));
const ME = `Ira ${Date.now() % 1000}`;
async function toDept(name) {
  await panel().getByRole("button", { name: "Department" }).click();
  await page.locator(".o-menu button", { hasText: name }).first().click();
}

await step("set up: n8n is connected (the stand-in) and the office opens", async () => {
  await api("/api/channels", { method: "PUT", body: JSON.stringify({ hook: { url: N8N, token: TOKEN, outreach: "auto" } }) });
  await api("/api/outreach", { method: "PUT", body: JSON.stringify({ per_contact_hour: 20, from_name: "Ira" }) });
  await page.goto(`${URL}/?as=${encodeURIComponent(ME)}`);
  await page.locator(".o-root").waitFor();
  await panel().getByText("LIVE · NIRNAYA").waitFor({ timeout: 20000 });
});

await step("Intake asks back for what is missing: how much, then an email or a phone, then what a call is about", async () => {
  await toDept("INTAKE");
  await box().fill("make a payment to anushka");
  await page.locator(".o-hint.err").filter({ hasText: "How much" }).waitFor();
  await box().fill("pay anushka 500");
  await page.locator(".o-hint.err").filter({ hasText: "email or phone" }).waitFor();
  await box().fill("call rahul 9876543210");
  await page.locator(".o-hint.err").filter({ hasText: "about" }).waitFor();
  await box().fill("whatsapp 9876543210: happy birthday");
  await page.locator(".o-hint.err").filter({ hasText: "only send messages about money" }).waitFor();
});

let payOp;
await step("a payment shows its desks, waits for an OK in the office, then is paid once and messaged via n8n", async () => {
  await box().fill("pay ₹500 to anushka@example.com for dinner");
  await hint(/Pay ₹500 to Anushka for dinner by email/).filter({ hasText: "waits for your OK" }).filter({ hasText: "email via n8n" }).waitFor();
  const known = await opIds();
  await add();
  payOp = await newOp(known);
  const row = panel().locator(`.o-row[data-id="${payOp.id}"]`);
  await row.locator(".o-st", { hasText: "WAITING" }).waitFor({ timeout: 20000 });
  expect(!posts.length, "something was sent before the OK");
  await row.click();
  const appr = rail().locator(`.o-appr[data-op="${payOp.id}"]`);
  await appr.getByText(/Pay ₹500 to Anushka/).waitFor();
  await appr.getByText(/Sealed/).waitFor();
  await appr.getByRole("button", { name: "APPROVE" }).click();
  const done = await until(async () => (await api("/api/office")).ops.find((o) => o.id === payOp.id && o.state === "done"));
  expect(done.ok && done.approved_by === ME, `${done.ok} ${done.approved_by} ${done.result}`);
  const sent = posts.find((p) => p.op_id === payOp.id);
  expect(sent && sent.channel === "email" && sent.text.includes("₹500") && sent.text.includes("no real money"), JSON.stringify(sent));
  expect(done.steps.map((s) => s.agent).join(",").startsWith("sentry,pii,triage,kyc,fraud,router,seal"), done.steps.map((s) => s.agent).join(","));
  await row.locator(".o-st", { hasText: "DONE" }).waitFor();
  await page.keyboard.press("Escape");
});

await step("a request for money goes out with no OK, and Anushka's email is remembered for next time", async () => {
  await panel().locator(".o-top, .o-head").first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await box().fill("ask anushka for ₹300 for the cab by email");
  await hint(/Ask Anushka for ₹300 for the cab by email/).filter({ hasText: "contact from an earlier task" }).waitFor();
  const known = await opIds();
  await add();
  const op = await newOp(known);
  const done = await until(async () => (await api("/api/office")).ops.find((o) => o.id === op.id && o.state === "done"));
  expect(done.ok && !done.approved, done.result);
  const sent = posts.find((p) => p.op_id === op.id);
  expect(sent && sent.to.email === "anushka@example.com" && sent.text.includes("₹300"), JSON.stringify(sent));
});

await step("Settings → Outreach shows where each channel goes and tests n8n with a dry run", async () => {
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: "Settings", exact: true }).click();
  const routes = page.getByTestId("outreach-routes");
  await routes.getByText("Email: via n8n").waitFor();
  const n = posts.length;
  await routes.getByRole("button", { name: "Test n8n" }).click();
  await page.getByText(/n8n answered the dry run/).waitFor();
  expect(posts.length === n + 1 && posts[n].dry_run === true, "the dry run did not reach n8n");
  await page.getByTestId("outreach-people").getByText("Anushka").waitFor();
});

await step("the Ledger shows the payout and the float", async () => {
  await page.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: "Ledger", exact: true }).click();
  await page.getByTestId("float").waitFor();
  const led = await api("/api/ledger");
  expect(led.payouts.length >= 1 && led.payouts.some((p) => p.op_id === payOp.id && p.amount === 500), JSON.stringify(led.payouts));
});

await step("no uncaught errors and no server errors", async () => { expect(!errors.length, errors.join(" | ")); });

await browser.close();
n8n.close();
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
