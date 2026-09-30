// Two people on one Nirnaya server: do they see each other, and what the agents are doing for each other?
// Asha and Ravi each open the office in their own browser. Presence, the shared agent chat, who asked for a
// task, who approved a case, and a flow one saves and the other runs must all show up for both, live.
// Usage: node e2e/team.mjs   (NIRNAYA_URL, default http://127.0.0.1:8000; SHOTS=dir for screenshots)
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const URL = process.env.NIRNAYA_URL ?? "http://127.0.0.1:8000";
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); }
  catch (e) { results.push(false); console.log(`  ✗ ${name}\n      ${e.message.split("\n")[0]}`); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
const api = async (p, init) => (await fetch(URL + p, { headers: { "Content-Type": "application/json" }, ...init })).json();
async function until(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("timed out waiting");
}

console.log(`Team e2e against ${URL}`);
const browser = await chromium.launch({ channel: "chromium", args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const errors = [];
async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${URL}/?as=${name}`);
  await page.locator(".o-root").waitFor();
  await page.getByText("LIVE · NIRNAYA").waitFor({ timeout: 15000 });
  return page;
}
const asha = await person("Asha");
const ravi = await person("Ravi");
const panel = (p) => p.getByTestId("task-panel");
const chat = (p) => p.getByTestId("chat");
const nav = (p, name) => p.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name, exact: true }).click();

await step("each sees the other in the office's top bar", async () => {
  await asha.locator('[data-testid="people"] [data-person="Ravi"]').waitFor({ timeout: 10000 });
  await ravi.locator('[data-testid="people"] [data-person="Asha"]').waitFor({ timeout: 10000 });
  const people = (await api("/api/team")).people.map((p) => p.name);
  expect(people.includes("Asha") && people.includes("Ravi"), `server has ${people}`);
});

await step("when Ravi looks at Resolution, Asha sees him on that department's card", async () => {
  await ravi.locator(".o-top").click({ position: { x: 700, y: 26 } });
  await ravi.keyboard.press("2");
  await asha.locator('.o-card[data-pod="resolution"] .o-here').waitFor({ timeout: 10000 });
  expect(((await asha.locator('.o-card[data-pod="resolution"] .o-here').getAttribute("title")) ?? "").includes("Ravi"), "no Ravi on the card");
  await ravi.keyboard.press("Escape");
});

await step("Asha asks an agent something; Ravi sees her question and the agent's answer", async () => {
  await asha.locator(".o-top").click({ position: { x: 700, y: 26 } });
  await asha.keyboard.press("1");
  await asha.getByRole("textbox", { name: "Message" }).fill("Asha here: what are you working on?");
  await asha.getByRole("button", { name: "SEND" }).click();
  await chat(asha).getByText("Asha here: what are you working on?").waitFor();
  await ravi.locator(".o-top").click({ position: { x: 700, y: 26 } });
  await ravi.keyboard.press("1");
  const q = chat(ravi).locator(".o-m-user.theirs", { hasText: "Asha here: what are you working on?" });
  await q.waitFor({ timeout: 10000 });
  expect((await q.innerText()).startsWith("ASHA"), "her name is not on her message");
  await chat(ravi).locator(".o-m-agent", { hasText: "I'm Triage" }).first().waitFor({ timeout: 10000 });
  await asha.keyboard.press("Escape");
  await ravi.keyboard.press("Escape");
});

await step("a task Asha gives Oversight shows on Ravi's board as hers", async () => {
  await panel(asha).getByRole("button", { name: "Department" }).click();
  await asha.locator(".o-menu button", { hasText: "OVERSIGHT" }).first().click();
  await panel(asha).getByRole("textbox", { name: "Task" }).fill("Verify the audit trail");
  await panel(asha).getByRole("button", { name: "ADD", exact: true }).click();
  await panel(ravi).locator(".o-row", { hasText: "Verify the audit trail" }).filter({ hasText: "for Asha" }).first().waitFor({ timeout: 15000 });
});

let caseId = null;
await step("a case waiting for approval: Ravi approves it in Approvals; Asha's office says Ravi did", async () => {
  const c = await api("/api/cases", { method: "POST", body: JSON.stringify({ customer_id: "C-1003", by: "Asha",
    message: "There is a transaction of ₹18,500 at QuickPay Store that was not done by me, please help" }) });
  caseId = c.id;
  await until(async () => (await api(`/api/cases/${caseId}`)).pending);
  await ravi.keyboard.press("w");
  await nav(ravi, "Approvals");
  const card = ravi.locator("div", { has: ravi.getByText(caseId, { exact: true }) }).filter({ has: ravi.getByRole("button", { name: "Approve" }) }).last();
  await card.getByRole("button", { name: "Approve" }).click();
  await until(async () => (await api(`/api/cases/${caseId}`)).status === "resolved");
  await asha.locator(".o-toast, [aria-live] button", { hasText: `Ravi approved ${caseId}` }).first().waitFor({ timeout: 10000 });
  await panel(asha).locator(".o-row", { hasText: "Unauthorised" }).filter({ hasText: "after Ravi’s OK" }).first().waitFor({ timeout: 15000 });
  const note = (await api("/api/office/chats")).fraud?.find((m) => m.text.startsWith(`Ravi approved ${caseId}`));
  expect(note, "no note in the Risk & Fraud chat");
  const trail = (await api(`/api/cases/${caseId}`)).trail.find((t) => t.kind === "approval.granted");
  expect(trail.actor === "Ravi", `trail actor ${trail.actor}`);
  if (SHOTS) await asha.screenshot({ path: `${SHOTS}/team-asha-office.png` });
});

let flowId = null;
await step("Asha saves a flow; Ravi finds it in his Builder, runs it, and Asha watches it finish", async () => {
  const f = await api("/api/flows", { method: "POST", body: JSON.stringify({ name: "Team check", by: "Asha", nodes: [
    { id: "s", type: "start", x: 40, y: 120, config: {} },
    { id: "t", type: "task", x: 300, y: 120, config: { dept: "oversight", text: "Check for drift" } },
    { id: "n", type: "notify", x: 560, y: 120, config: { dept: "oversight", text: "Drift check for the team: {result}" } },
  ], edges: [{ from: "s", to: "t", port: "next" }, { from: "t", to: "n", port: "next" }] }) });
  flowId = f.id;
  for (const p of [asha, ravi]) {
    await p.keyboard.press("Escape");
    if (!(await p.getByRole("navigation", { name: "Views" }).count())) await p.keyboard.press("w");
    await nav(p, "Flows");
    await p.getByRole("tab", { name: "Builder" }).click();
    await p.getByRole("combobox", { name: "Flow" }).selectOption(flowId);
  }
  await asha.getByText("here too").waitFor({ timeout: 10000 }); // Ravi has the same flow open
  await ravi.getByRole("button", { name: "Run", exact: true }).click();
  await until(async () => (await asha.locator('[data-node="n"]').getAttribute("data-state")) === "done");
  expect((await asha.locator('[data-node="t"]').innerText()).includes("PSI"), "Asha doesn't see the drift result");
  await asha.getByTestId("canvas").focus();
  await asha.keyboard.press("Escape");
  await asha.getByTestId("runs").getByText(/Ravi/).first().waitFor();
  if (SHOTS) await asha.screenshot({ path: `${SHOTS}/team-asha-flow.png` });
});

await step("Ravi edits the flow; Asha, with no changes of her own, gets his version live", async () => {
  await ravi.locator('[data-node="n"]').click({ position: { x: 60, y: 14 } });
  await ravi.getByRole("textbox", { name: "Message" }).fill("Ravi's version: {result}");
  await ravi.getByRole("button", { name: "Save", exact: true }).click();
  await asha.locator('[data-node="n"]', { hasText: "Ravi's version" }).waitFor({ timeout: 10000 });
  await asha.getByText(/^v2 · Ravi/).waitFor();
});

await step("when one leaves, the other stops seeing them", async () => {
  await ravi.context().close();
  await until(async () => !(await api("/api/team")).people.some((p) => p.name === "Ravi"), 15000);
  await asha.locator('[data-testid="people"] [data-person="Ravi"]').waitFor({ state: "detached", timeout: 10000 });
});

await step("no uncaught errors", async () => { expect(!errors.length, errors.join(" | ")); });

if (flowId) await fetch(`${URL}/api/flows/${flowId}?by=e2e`, { method: "DELETE" });
await browser.close();
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
