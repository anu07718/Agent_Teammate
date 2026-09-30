// Flows end to end: build a flow on the canvas by drag and drop, wire it with the mouse, save, run it,
// answer its "Ask a person" step on the canvas, and check the agents really did the work.
// Usage: node e2e/flows.mjs   (NIRNAYA_URL, default http://127.0.0.1:8000; SHOTS=dir for screenshots)
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
const api = async (p) => (await fetch(URL + p)).json();
async function until(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("timed out waiting");
}

console.log(`Flows e2e against ${URL}`);
const browser = await chromium.launch({ channel: "chromium", args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 940 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const node = (id) => page.locator(`[data-node="${id}"]`);
const center = async (loc) => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
async function wireUp(fromPort, toNode) {
  const a = await center(page.locator(`[data-out="${fromPort}"]`));
  const b = await center(node(toNode));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}
const name = `E2E flow ${Date.now() % 100000}`;
let flowId = null;

await step("the office's FLOWS button opens Flows, and Live shows the ten-step pipeline", async () => {
  await page.goto(`${URL}/?as=Asha`);
  await page.locator(".o-root").waitFor();
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.getByTestId("pipeline").waitFor();
  expect(await page.locator("[data-step]").count() === 10, "not ten steps");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/flows-live.png` });
});

await step("a new flow: nodes dragged from the palette land on the canvas", async () => {
  await page.getByRole("tab", { name: "Builder" }).click();
  await page.getByTestId("canvas").waitFor();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("textbox", { name: "Flow name" }).fill(name);
  await node("start1").waitFor();
  const cb = await page.getByTestId("canvas").boundingBox();
  // Start sits in the middle after "New": the new nodes go in a row above it
  const at = (fx, fy) => ({ x: Math.round(cb.width * fx), y: Math.round(cb.height * fy) });
  await page.dragAndDrop('[data-palette="task"]', '[data-testid="canvas"]', { targetPosition: at(0.16, 0.22) });
  await node("task1").waitFor();
  await page.dragAndDrop('[data-palette="notify"]', '[data-testid="canvas"]', { targetPosition: at(0.42, 0.22) });
  await node("notify1").waitFor();
  await page.dragAndDrop('[data-palette="approval"]', '[data-testid="canvas"]', { targetPosition: at(0.68, 0.22) });
  await node("approval1").waitFor();
  await page.dragAndDrop('[data-palette="wait"]', '[data-testid="canvas"]', { targetPosition: at(0.84, 0.78) });
  await node("wait1").waitFor();
});

await step("each node is set up in the side panel", async () => {
  await node("task1").click({ position: { x: 60, y: 14 } });
  await page.getByRole("combobox", { name: "Department" }).selectOption("oversight");
  await page.getByRole("textbox", { name: "Task" }).fill("Verify the audit trail");
  await node("notify1").click({ position: { x: 60, y: 14 } });
  await page.getByRole("textbox", { name: "Message" }).fill("E2E says: {result}");
  await node("approval1").click({ position: { x: 60, y: 14 } });
  await page.getByRole("textbox", { name: "Question" }).fill("Ship it?");
  await node("wait1").click({ position: { x: 60, y: 14 } });
  await page.getByRole("spinbutton", { name: "Seconds" }).fill("0");
  expect((await node("task1").innerText()).includes("Verify the audit trail"), "task summary not updated");
});

await step("wires are drawn from an output dot to the next node, and one can be deleted", async () => {
  await wireUp("start1:next", "task1");
  await wireUp("task1:next", "notify1");
  await wireUp("notify1:next", "approval1");
  await wireUp("approval1:no", "wait1");
  expect(await page.locator("[data-edge]").count() === 4, `wires: ${await page.locator("[data-edge]").count()}`);
  // wrong branch on purpose: select that wire, delete it, draw the "yes" one instead
  await page.locator('[data-edge="approval1>wait1"] .fl-hit').dispatchEvent("pointerdown");
  await page.getByRole("button", { name: "Delete wire" }).click();
  expect(await page.locator("[data-edge]").count() === 3, "the wire was not deleted");
  await wireUp("approval1:yes", "wait1");
  expect(await page.locator("[data-edge]").count() === 4, "the yes wire was not drawn");
});

await step("a bad task is refused on save with a reason, a good flow saves", async () => {
  await node("task1").click({ position: { x: 60, y: 14 } });
  await page.getByRole("textbox", { name: "Task" }).fill("make me a sandwich");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "doesn't know" }).waitFor();
  await page.getByRole("textbox", { name: "Task" }).fill("Verify the audit trail");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText(/^v1 · Asha/).waitFor();
  const all = await api("/api/flows");
  const f = all.flows.find((x) => x.name === name);
  expect(f && f.nodes.length === 5 && f.edges.length === 4 && f.by === "Asha", "not saved on the server");
  flowId = f.id;
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/flows-built.png` });
});

await step("Run: the agents do each step, live on the canvas, and the person's OK is asked on the node", async () => {
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await until(async () => (await node("approval1").getAttribute("data-state")) === "waiting");
  expect((await node("task1").getAttribute("data-state")) === "done", "the task is not done");
  expect((await node("task1").innerText()).includes("Chain intact"), "no trail result on the task node");
  expect((await node("notify1").getAttribute("data-state")) === "done", "the post is not done");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/flows-waiting.png` });
  await node("approval1").getByRole("button", { name: "Yes" }).click();
  await until(async () => (await node("wait1").getAttribute("data-state")) === "done");
  await page.getByTestId("canvas").focus();
  await page.keyboard.press("Escape"); // nothing selected: the side panel lists this flow's runs
  await page.getByTestId("runs").getByText("100%").first().waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/flows-done.png` });
});

await step("the run is on the server: an op by the flow, the post in the Oversight chat, 100%", async () => {
  const d = await api("/api/flows");
  const r = d.runs.filter((x) => x.flow_id === flowId).at(-1);
  expect(r.state === "done" && r.progress === 1, `run ${r.state} ${r.progress}`);
  expect(r.nodes.approval1.text.startsWith("Asha said yes"), r.nodes.approval1.text);
  const op = (await api("/api/office")).ops.find((o) => o.id === r.nodes.task1.out.op_id);
  expect(op && op.agent === "trail" && op.by === `flow · ${name}`, "no op by the flow");
  const chat = (await api("/api/office/chats")).human ?? [];
  expect(chat.some((m) => m.text.startsWith("E2E says: Chain intact")), "no post in the Oversight lead's chat");
});

await step("the office shows the flow's work: the post in the Support lead's chat", async () => {
  await page.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: "Office", exact: true }).click();
  await page.locator(".o-root").waitFor();
  await page.keyboard.press("6");
  await page.getByTestId("chat").getByText("E2E says: Chain intact").first().waitFor({ timeout: 15000 });
});

await step("no uncaught errors", async () => { expect(!errors.length, errors.join(" | ")); });

await browser.close();
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
