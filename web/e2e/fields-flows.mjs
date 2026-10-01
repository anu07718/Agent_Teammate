// Flows, every control: the Live view (pick a case, open it, the runs going now), every palette node by
// click, Enter and drag, every field and option in the side panel, every reason a save is refused, every
// Check field and way on real runs, Ask a person yes and no, a case or a task that needs an OK, Stop, Copy,
// the flow picker, Delete, the three examples, every {placeholder} in a chat post, the canvas controls,
// the run list, and a Start on a schedule that runs by itself.
// Usage: node e2e/fields-flows.mjs   (NIRNAYA_URL, default http://127.0.0.1:8000; SHOTS=dir)
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const URL = process.env.NIRNAYA_URL ?? "http://127.0.0.1:8000";
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push(true); console.log(`  ✓ ${name} (${Math.round((Date.now() - t0) / 1000)}s)`); }
  catch (e) {
    results.push(false);
    const lines = e.message.split("\n").filter((l) => l.trim());
    console.log(`  ✗ ${name}\n      ${[lines[0], ...lines.slice(1).slice(-4)].join("\n      ")}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/fail-${results.length}.png` }).catch(() => {});
  }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
const api = async (p, body, method) => {
  const r = await fetch(URL + p, body === undefined ? { method: method ?? "GET" } : { method: method ?? "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
async function until(fn, ms = 30000, every = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, every)); }
  throw new Error("timed out waiting");
}
const run = (id) => api(`/api/flows`).then((d) => d.runs.find((r) => r.id === id));
const runsOf = async (fid) => (await api("/api/flows")).runs.filter((r) => r.flow_id === fid);
const finished = (id, ms = 60000) => until(async () => { const r = await run(id); return r && ["done", "failed", "stopped"].includes(r.state) ? r : null; }, ms);
const waitingRun = (id) => until(async () => { const r = await run(id); return r?.state === "waiting" ? r : null; });
const N = (id, t, x, y, config = {}) => ({ id, type: t, x, y, config });
const W = (from, to, port = "next") => ({ from, to, port });
const makeFlow = (name, nodes, edges) => api("/api/flows", { name, nodes, edges, by: "Flo" });

console.log(`Flows, every control, against ${URL}`);
const browser = await chromium.launch({ channel: "chromium", args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 940 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });

const nav = (label) => page.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: label, exact: true });
const tool = (name) => page.locator(".fl-tools").getByRole("button", { name, exact: true });
const side = () => page.locator('aside[aria-label="Settings"]');
const node = (id) => page.locator(`[data-node="${id}"]`);
const pick = (id) => node(id).click({ position: { x: 60, y: 14 } });
const pal = (t) => page.locator(`[data-palette="${t}"]`);
const flowSel = () => page.getByRole("combobox", { name: "Flow" });
const alertBox = () => page.locator(".fl-banner");
const state = (id) => node(id).getAttribute("data-state");
const text = async (id) => (await node(id).locator(".fl-state").innerText().catch(() => "")).replace(/\s+/g, " ");
const fit = () => page.getByTestId("canvas").getByRole("button", { name: "Fit to screen" }).click();
const deselect = async () => { await page.getByTestId("canvas").focus(); await page.keyboard.press("Escape"); };
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
async function save(version) {
  await tool("Save").click();
  await page.locator(".fl-tools").getByText(new RegExp(`^v${version ?? "\\d+"} · `)).waitFor();
}
async function refusedWith(re) {
  await tool("Save").click();
  await alertBox().filter({ hasText: re }).waitFor();
  await alertBox().getByRole("button", { name: "Dismiss" }).click();
  await alertBox().waitFor({ state: "detached" });
}
async function toBuilder() {
  if (await page.getByTestId("canvas").isVisible()) return;
  await nav("Flows").click();
  await page.getByRole("tab", { name: "Builder" }).click();
  await page.getByTestId("canvas").waitFor();
}
async function openFlow(id) {
  await toBuilder();
  await until(async () => (await flowSel().locator(`option[value="${id}"]`).count()) === 1); // a flow saved elsewhere arrives live
  if ((await flowSel().inputValue()) !== id) await flowSel().selectOption(id);
  await until(async () => (await flowSel().inputValue()) === id);
  await fit();
}
async function runHere(fid) {
  const before = new Set((await runsOf(fid)).map((r) => r.id));
  await tool("Run").click();
  return until(async () => (await runsOf(fid)).find((r) => !before.has(r.id)));
}

const flows0 = await api("/api/flows");
const presets = (await api("/api/state")).presets;

await page.goto(`${URL}/?as=Flo`);
await page.getByText("LIVE · NIRNAYA").waitFor({ timeout: 20000 });

// ── Live ──────────────────────────────────────────────────────────────────
let liveCase;
await step("Live: ten steps; a picked case lights the steps it passed; Show all; Open takes you to the case", async () => {
  const c = await api("/api/cases", { customer_id: "C-1002", message: "I was charged twice for ₹349 at CafeBrew", channel: "chat", by: "Flo" });
  liveCase = await until(async () => { const x = await api(`/api/cases/${c.id}`); return x.status !== "running" ? x : null; });
  await page.locator(".o-top").click({ position: { x: 760, y: 26 } });
  await page.keyboard.press("f");
  await page.getByTestId("pipeline").waitFor();
  expect(await page.locator("[data-step]").count() === 10, "not ten steps");
  const pc = (await api("/api/flows/pipeline")).cases.find((x) => x.id === c.id);
  expect(pc.passed.length === 10 && pc.progress === 1, `pipeline says ${pc.passed.length} steps, ${pc.progress}`);
  await page.locator(`[data-case="${c.id}"]`).click();
  await page.locator(".fl-step.lit-done").first().waitFor();
  expect(await page.locator(".fl-step.lit-done").count() === 10, "not every step lit");
  await page.getByText(`${c.id}`, { exact: true }).first().waitFor();
  await page.getByText("100% done").waitFor();
  await page.getByRole("button", { name: "Show all" }).click();
  expect(await page.locator(".fl-step.lit-done").count() === 0, "Show all left steps lit");
  await page.locator(`[data-case="${c.id}"]`).click();
  await page.getByRole("button", { name: `Open ${c.id}` }).click();
  await until(async () => (await nav("Cases").getAttribute("aria-current")) === "true");
  await page.getByText(c.id).first().waitFor();
  await nav("Flows").click();
  await page.getByTestId("pipeline").waitFor();
});

await step("Live: the counts match the server (cases in flight, tasks, waiting, flow runs, each task column)", async () => {
  const p = await api("/api/flows/pipeline");
  const badge = async (re) => Number((await page.getByText(re).first().innerText()).match(/\d+/)[0]);
  expect(await badge(/case\(s\) in flight/) === p.cases.filter((c) => c.status === "running").length, "cases in flight");
  expect(await badge(/task\(s\) running/) === p.ops.doing + p.ops.next, "tasks running");
  expect(await badge(/waiting for an OK/) === p.ops.waiting, "tasks waiting");
  expect(await badge(/flow run\(s\) going/) === p.runs.length, "flow runs going");
  for (const [k, label] of [["scheduled", "booked"], ["next", "next"], ["doing", "doing"], ["waiting", "waiting"]]) {
    const card = page.locator("section", { has: page.getByRole("heading", { name: "Department tasks" }) });
    const n = Number((await card.getByText(label, { exact: true }).locator("..").innerText()).match(/\d+/)[0]);
    expect(n === (p.ops[k] ?? 0), `${label}: ${n} on screen, ${p.ops[k]} on the server`);
  }
});

let gate;
await step("Live: a flow run going now is listed; clicking it opens that flow in the Builder; Yes on the node finishes it", async () => {
  gate = await makeFlow("Live gate", [N("s", "start", 40, 150), N("a", "approval", 320, 150, { question: "Go ahead?" })], [W("s", "a")]);
  const r = await api(`/api/flows/${gate.id}/run`, { by: "Flo" });
  await waitingRun(r.id);
  const row = page.getByRole("button").filter({ hasText: "Live gate" }).filter({ hasText: r.id });
  await row.waitFor();
  expect((await row.innerText()).includes("waiting"), "the run is not shown as waiting");
  await row.click();
  await page.getByRole("tab", { name: "Builder", selected: true }).waitFor();
  expect((await flowSel().inputValue()) === gate.id, "the Builder opened another flow");
  await until(async () => (await state("a")) === "waiting");
  await page.locator(".fl-runbar").getByText("waiting for a person").waitFor();
  await node("a").getByRole("button", { name: "Yes" }).click();
  const done = await finished(r.id);
  expect(done.state === "done" && done.nodes.a.text.startsWith("Flo said yes"), `${done.state}: ${done.nodes.a.text}`);
  await until(async () => (await state("a")) === "done");
});

// ── the palette ───────────────────────────────────────────────────────────
const NAME = `Every field ${Date.now() % 100000}`;
await step("palette: all seven nodes add — by click (wired to the selected node), by Enter, by drag; a second Start is refused", async () => {
  await toBuilder();
  await tool("New").click();
  await page.getByRole("textbox", { name: "Flow name" }).fill(NAME);
  await node("start1").waitFor();
  expect((await flowSel().inputValue()) === "" && (await flowSel().locator("option").first().innerText()).includes("(not saved)"), "new flow not shown as unsaved");
  await page.locator(".fl-tools").getByText("unsaved").waitFor();
  // start1 is selected after New: a click on the palette adds the node and wires it from start1
  await pal("task").click(); await node("task1").waitFor();
  await pal("if").click(); await node("if1").waitFor();
  await pal("notify").click(); await node("notify1").waitFor();
  await fit();
  await pick("if1");
  await pal("approval").click(); await node("approval1").waitFor();
  await fit();
  for (const e of ["start1>task1", "task1>if1", "if1>notify1", "if1>approval1"]) expect(await page.locator(`[data-edge="${e}"]`).count() === 1, `no wire ${e}`);
  // the Check's first wire takes “yes”, the second “no”
  expect((await page.locator('[data-edge="if1>notify1"] .fl-port-label').textContent()) === "yes", "first wire from Check is not yes");
  expect((await page.locator('[data-edge="if1>approval1"] .fl-port-label').textContent()) === "no", "second wire from Check is not no");
  // nothing selected: the side panel describes the flow
  await deselect();
  await side().getByRole("heading", { name: NAME }).waitFor();
  // drag a Wait into an empty corner
  const cb = await page.getByTestId("canvas").boundingBox();
  await page.dragAndDrop('[data-palette="wait"]', '[data-testid="canvas"]', { targetPosition: { x: Math.round(cb.width * 0.12), y: Math.round(cb.height * 0.86) } });
  await node("wait1").waitFor();
  expect(await page.locator('[data-edge$=">wait1"]').count() === 0, "a dropped node got wired");
  // Enter on a palette node, with nothing selected
  await deselect();
  await pal("case").focus();
  await page.keyboard.press("Enter");
  await node("case1").waitFor();
  expect(await page.locator('[data-edge$=">case1"]').count() === 0, "Enter wired the new node");
  // move it by dragging its header to an empty spot, below the rest
  const h = await node("case1").boundingBox();
  await page.mouse.move(h.x + 40, h.y + 12);
  await page.mouse.down();
  await page.mouse.move(h.x + 40, cb.y + cb.height * 0.86, { steps: 8 });
  await page.mouse.move(cb.x + cb.width * 0.62, cb.y + cb.height * 0.86, { steps: 8 });
  await page.mouse.up();
  await fit();
  // a second Start is refused
  await pal("start").click();
  await alertBox().filter({ hasText: "A flow has one Start" }).waitFor();
  await alertBox().getByRole("button", { name: "Dismiss" }).click();
  expect(await page.locator("[data-node]").count() === 7, `${await page.locator("[data-node]").count()} nodes`);
  // no two nodes on top of each other
  const boxes = await page.locator("[data-node]").evaluateAll((es) => es.map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.node, r.left, r.top, r.right, r.bottom]; }));
  for (const a of boxes) for (const b of boxes) if (a[0] < b[0]) expect(a[3] <= b[1] || b[3] <= a[1] || a[4] <= b[2] || b[4] <= a[2], `${a[0]} overlaps ${b[0]}`);
});

// ── the side panel ────────────────────────────────────────────────────────
let data;
await step("side panel: Start's When; the Customer message's 4 customers, 5 channels, message and 8 sample chips", async () => {
  data = await api("/api/flows");
  await pick("start1");
  await side().getByRole("textbox", { name: "When" }).fill("every weekday at 9am");
  await node("start1").getByText("⏱ every weekday at 9am").waitFor();
  await side().getByRole("textbox", { name: "When" }).fill("");
  await node("start1").getByText("run by hand").waitFor();
  await pick("case1");
  const cust = side().getByRole("combobox", { name: "Customer" });
  const ids = await cust.locator("option").evaluateAll((os) => os.map((o) => o.value));
  expect(ids.join() === data.customers.map((c) => c.id).join() && ids.length === 4, `customers ${ids}`);
  for (const c of data.customers) {
    await cust.selectOption(c.id);
    await node("case1").getByText(`${c.name.split(" ")[0]}:`).waitFor();
  }
  const chan = side().getByRole("combobox", { name: "Channel" });
  const chans = await chan.locator("option").allInnerTexts();
  expect(chans.join() === "chat,whatsapp,email,voice,app", `channels ${chans}`);
  for (const ch of chans) { await chan.selectOption(ch); expect((await chan.inputValue()) === ch, `channel ${ch}`); }
  await chan.selectOption("whatsapp");
  const chips = side().locator(".fl-chip");
  expect(await chips.count() === 8, `${await chips.count()} sample chips`);
  for (let i = 0; i < 8; i++) {
    await chips.nth(i).click();
    expect((await side().getByRole("textbox", { name: "Message" }).inputValue()) === presets[i].text, `chip ${presets[i].label}: message`);
    expect((await cust.inputValue()) === presets[i].customer, `chip ${presets[i].label}: customer`);
  }
  await side().getByRole("textbox", { name: "Message" }).fill("Did my last payment go through?");
  await node("case1").getByText("“Did my last payment go through?”").waitFor();
});

const TASK_EXAMPLES = {
  verification: ["Check T-5001", "Pull the evidence for T-5006"],
  decision: ["Run the benchmark", "List the certified thresholds", "Score refund_duplicate 349", "Recalibrate"],
  commit: ["Undo NR-1002", "check: ₹500 will be credited in 2 hours, guaranteed"],
  oversight: ["Verify the audit trail", "Tamper test on the audit trail", "Check for drift", "Write today's digest", "Find approvals past their TAT"],
};
await step("side panel: a Department task's 4 departments, what each can do, and every example chip", async () => {
  await pick("task1");
  const dept = side().getByRole("combobox", { name: "Department" });
  const opts = await dept.locator("option").evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
  expect(opts.map((o) => o[0]).join() === "verification,decision,commit,oversight", `departments ${opts}`);
  for (const [d, label] of opts) {
    await dept.selectOption(d);
    expect(label === data.depts.find((x) => x.id === d).name, `${d} is called ${label}`);
    expect((await side().getByRole("textbox", { name: "Task" }).inputValue()) === TASK_EXAMPLES[d][0], `${d}: task not reset to its first example`);
    await side().getByText(`It can: ${data.can[d].join("; ")}.`).waitFor();
    const chips = side().locator(".fl-chip");
    expect((await chips.allInnerTexts()).join("|") === TASK_EXAMPLES[d].join("|"), `${d} chips: ${await chips.allInnerTexts()}`);
    for (const t of TASK_EXAMPLES[d]) {
      await chips.filter({ hasText: t }).first().click();
      expect((await side().getByRole("textbox", { name: "Task" }).inputValue()) === t, `${d}: chip ${t}`);
      await node("task1").getByText(`${label} · ${t}`).waitFor();
    }
  }
  await dept.selectOption("oversight");
  await side().getByRole("textbox", { name: "Task" }).fill("Verify the audit trail");
});

const VALUES = { ok: ["true", "false"], route: ["ACT", "HEDGE", "ESCALATE", "REFUSE"], status: ["resolved", "refused", "parked"] };
await step("side panel: a Check offers each field with only the ways that make sense, and the right values", async () => {
  await pick("if1");
  const field = side().getByRole("combobox", { name: "Check" });
  const how = side().getByRole("combobox", { name: "How" });
  const fields = await field.locator("option").evaluateAll((os) => os.map((o) => o.value));
  expect(fields.join() === Object.keys(data.fields).join() && fields.length === 5, `fields ${fields}`);
  for (const f of fields) {
    await field.selectOption(f);
    const ways = await how.locator("option").allInnerTexts();
    expect(ways.join() === data.ops_for[f].join(), `${f}: ways ${ways}`);
    for (const w of ways) {
      await how.selectOption(w);
      if (VALUES[f]) {
        const vals = await side().getByRole("combobox", { name: "Value" }).locator("option").allInnerTexts();
        expect(vals.join() === VALUES[f].join(), `${f}: values ${vals}`);
        for (const v of vals) {
          await side().getByRole("combobox", { name: "Value" }).selectOption(v);
          await node("if1").getByText(`${f === "ok" ? "succeeded" : f} ${w} ${v}`).waitFor();
        }
      } else {
        const v = f === "amount" ? "1000" : "intact";
        await side().getByRole("textbox", { name: "Value" }).fill(v);
        await node("if1").getByText(`${f} ${w} ${v}`).waitFor();
      }
    }
  }
  // a way that does not fit the new field falls back to “is”
  await field.selectOption("amount"); await how.selectOption(">");
  await field.selectOption("route");
  expect((await how.inputValue()) === "is", "a route kept “>”");
  await field.selectOption("ok"); await how.selectOption("is");
  await side().getByRole("combobox", { name: "Value" }).selectOption("true");
});

await step("side panel: Ask a person's question; Post to team chat's 6 departments and message; Wait's seconds", async () => {
  await pick("approval1");
  await side().getByRole("textbox", { name: "Question" }).fill("The trail did not verify ({result}). Look now?");
  await node("approval1").getByText("“The trail did not verify ({result}). Look now?”").waitFor();
  await pick("notify1");
  const dept = side().getByRole("combobox", { name: "Department" });
  const opts = await dept.locator("option").evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
  expect(opts.length === 6 && opts.map((o) => o[0]).join() === data.depts.map((d) => d.id).join(), `notify departments ${opts}`);
  await side().getByRole("textbox", { name: "Message" }).fill("Field test: {result}");
  for (const [d, label] of opts) {
    await dept.selectOption(d);
    await node("notify1").getByText(`→ ${label}: Field test: {result}`).waitFor();
  }
  await dept.selectOption("oversight");
  await pick("wait1");
  await side().getByRole("spinbutton", { name: "Seconds" }).fill("2");
  await node("wait1").getByText("2 s").waitFor();
});

await step("wires and deleting: select a wire, Delete wire, redraw it by mouse; Delete node; the Delete key; Escape", async () => {
  await page.locator('[data-edge="if1>approval1"] .fl-hit').dispatchEvent("pointerdown");
  await side().getByText("if1 (no) → approval1").waitFor();
  await side().getByRole("button", { name: "Delete wire" }).click();
  expect(await page.locator('[data-edge="if1>approval1"]').count() === 0, "wire not deleted");
  await wireUp("if1:no", "approval1");
  expect(await page.locator('[data-edge="if1>approval1"]').count() === 1, "wire not redrawn");
  // a node wired to itself, or into Start, is not drawn
  const n0 = await page.locator("[data-edge]").count();
  await wireUp("task1:next", "task1");
  await wireUp("task1:next", "start1");
  await alertBox().filter({ hasText: "Nothing can wire into Start." }).waitFor();
  await alertBox().getByRole("button", { name: "Dismiss" }).click();
  expect(await page.locator("[data-edge]").count() === n0, "a wire into itself or into Start was drawn");
  // Delete node takes its wires with it
  await pick("notify1");
  await pal("notify").click(); await node("notify2").waitFor(); // wired from notify1
  await fit();
  await pick("notify2");
  await side().getByRole("button", { name: "Delete node" }).click();
  expect(await node("notify2").count() === 0 && (await page.locator('[data-edge="notify1>notify2"]').count()) === 0, "Delete node left something");
  // the Delete key
  await pick("notify1");
  await pal("wait").click(); await node("wait2").waitFor();
  await fit();
  await pick("wait2");
  await page.getByTestId("canvas").focus();
  await page.keyboard.press("Delete");
  expect(await node("wait2").count() === 0, "the Delete key did not remove the node");
  // wire the Wait after the post, so a run goes start → task → check → post → wait
  await wireUp("notify1:next", "wait1");
  await pick("wait1");
  await page.keyboard.press("Escape");
  await side().getByRole("heading", { name: NAME }).waitFor();
});

let mainId;
await step("save refuses each bad setup with its reason, then a good one saves as v1", async () => {
  await pick("task1");
  await side().getByRole("textbox", { name: "Task" }).fill("make me a sandwich");
  await refusedWith(/Oversight doesn't know “make me a sandwich”/);
  await side().getByRole("textbox", { name: "Task" }).fill("every day at 9am verify the audit trail");
  await refusedWith(/has a schedule in it. Put the schedule on Start/);
  await side().getByRole("textbox", { name: "Task" }).fill("Verify the audit trail");
  await pick("start1");
  await side().getByRole("textbox", { name: "When" }).fill("whenever I like");
  await refusedWith(/can't read “whenever I like” as a schedule/);
  await side().getByRole("textbox", { name: "When" }).fill("");
  await pick("case1");
  await side().getByRole("textbox", { name: "Message" }).fill("   ");
  await refusedWith(/write what the customer says/);
  await side().getByRole("textbox", { name: "Message" }).fill("Did my last payment go through?");
  await pick("notify1");
  await side().getByRole("textbox", { name: "Message" }).fill("");
  await refusedWith(/write the message/);
  await side().getByRole("textbox", { name: "Message" }).fill("Field test: {result} (by {by}, {flow})");
  await pick("if1");
  await side().getByRole("combobox", { name: "Check" }).selectOption("result");
  await refusedWith(/say what to compare with/);
  await side().getByRole("combobox", { name: "Check" }).selectOption("ok");
  await side().getByRole("combobox", { name: "Value" }).selectOption("true");
  await wireUp("wait1:next", "task1"); // task → check → post → wait → task: round in a loop
  await refusedWith(/go round in a loop/);
  await page.locator('[data-edge="wait1>task1"] .fl-hit').dispatchEvent("pointerdown");
  await side().getByRole("button", { name: "Delete wire" }).click();
  await page.getByRole("textbox", { name: "Flow name" }).fill("");
  await save(1);
  expect((await page.getByRole("textbox", { name: "Flow name" }).inputValue()) === "Untitled flow", "an empty name was not filled in");
  await page.getByRole("textbox", { name: "Flow name" }).fill(NAME);
  await page.keyboard.press("Control+s"); // saves even while you are typing in a field
  await page.locator(".fl-tools").getByText(/^v2 · /).waitFor();
  mainId = await flowSel().inputValue();
  const f = (await api("/api/flows")).flows.find((x) => x.id === mainId);
  expect(f.name === NAME && f.by === "Flo" && f.nodes.length === 7 && f.version === 2, `saved ${f.name} v${f.version} ${f.nodes.length} nodes`);
  const port = (a, b) => f.edges.find((e) => e.from === a && e.to === b)?.port;
  expect(port("if1", "notify1") === "yes" && port("if1", "approval1") === "no" && port("notify1", "wait1") === "next", JSON.stringify(f.edges));
  const cfg = Object.fromEntries(f.nodes.map((n) => [n.id, n.config]));
  expect(cfg.case1.channel === "whatsapp" && cfg.case1.message === "Did my last payment go through?" && cfg.task1.dept === "oversight" && cfg.wait1.seconds === 2
    && cfg.notify1.dept === "oversight" && cfg.if1.field === "ok" && cfg.if1.op === "is" && cfg.if1.value === "true", JSON.stringify(cfg));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/built.png` });
});

let firstRun;
await step("Run: the agents do each step on the canvas; the check goes yes; the unwired node is skipped; the post lands", async () => {
  firstRun = await runHere(mainId);
  await page.locator(".fl-runbar").waitFor();
  expect(await tool("Run").isDisabled(), "Run is not disabled while it runs");
  const r = await finished(firstRun.id);
  expect(r.state === "done" && r.progress === 1, `run ${r.state} ${r.progress}`);
  await until(async () => (await state("wait1")) === "done");
  expect((await state("task1")) === "done" && (await text("task1")).includes("Chain intact"), `task: ${await text("task1")}`);
  expect((await text("if1")).includes("succeeded is true → yes"), `check: ${await text("if1")}`);
  expect((await state("notify1")) === "done" && (await state("approval1")) === "skipped" && (await state("case1")) === "skipped", "wrong path");
  expect((await text("wait1")).includes("Waited 2 s"), `wait: ${await text("wait1")}`);
  const chat = (await api("/api/office/chats")).human ?? [];
  expect(chat.some((m) => m.text === `Field test: ${r.nodes.task1.out.result.split("\n")[0]} (by Flo, ${NAME})`), "the post is not in the Oversight lead's chat, filled in");
  const op = (await api("/api/office")).ops.find((o) => o.id === r.nodes.task1.out.op_id);
  expect(op && op.agent === "trail" && op.by === `flow · ${NAME}`, "the task was not done by the trail agent for the flow");
  await page.locator(".fl-runbar").waitFor({ state: "detached" });
});

let secondRun;
await step("Run again with the check turned round: it goes no, Ask a person waits, No on the node ends it", async () => {
  await pick("if1");
  await side().getByRole("combobox", { name: "Value" }).selectOption("false");
  // Run saves first when there are changes
  secondRun = await runHere(mainId);
  expect((await api("/api/flows")).flows.find((x) => x.id === mainId).version === 3, "Run did not save the change first");
  await waitingRun(secondRun.id);
  await until(async () => (await state("approval1")) === "waiting");
  await node("approval1").getByText(/The trail did not verify \(.+\)\. Look now\?/).first().waitFor();
  expect((await page.locator(".fl-runbar").innerText()).includes("waiting for a person"), "the run bar does not say it is waiting");
  await node("approval1").getByRole("button", { name: "No" }).click();
  const r = await finished(secondRun.id);
  expect(r.state === "done" && r.nodes.approval1.text === "Flo said no" && r.nodes.notify1.state === "skipped" && r.nodes.wait1.state === "skipped", JSON.stringify(Object.fromEntries(Object.entries(r.nodes).map(([k, v]) => [k, v.state]))));
});

await step("the run list: picking an older run draws it on the canvas", async () => {
  await deselect();
  const list = page.getByTestId("runs");
  await list.getByText(firstRun.id).click();
  await until(async () => (await state("notify1")) === "done" && (await state("approval1")) === "skipped");
  await list.getByText(secondRun.id).click();
  await until(async () => (await state("notify1")) === "skipped" && (await state("approval1")) === "done");
  expect((await list.locator("button").count()) === 2, "not two runs listed");
});

await step("the canvas: zoom in, zoom out, fit, the mouse wheel, dragging the background", async () => {
  const world = () => page.locator(".fl-world").evaluate((e) => e.style.transform);
  const k = async () => Number((await world()).match(/scale\(([\d.]+)\)/)[1]);
  await fit(); const k0 = await k();
  await page.getByTestId("canvas").getByRole("button", { name: "Zoom in" }).click();
  expect(Math.abs((await k()) - Math.min(2, k0 * 1.2)) < 0.01, "zoom in");
  await page.getByTestId("canvas").getByRole("button", { name: "Zoom out" }).click();
  await page.getByTestId("canvas").getByRole("button", { name: "Zoom out" }).click();
  expect(Math.abs((await k()) - Math.max(0.35, k0 / 1.2)) < 0.01, "zoom out");
  await fit(); expect(Math.abs((await k()) - k0) < 0.001, "fit did not come back");
  const cb = await page.getByTestId("canvas").boundingBox();
  await page.mouse.move(cb.x + 30, cb.y + cb.height - 30);
  await page.mouse.wheel(0, -200);
  await until(async () => (await k()) > k0);
  const before = await world();
  await page.mouse.move(cb.x + 20, cb.y + cb.height - 20);
  await page.mouse.down();
  await page.mouse.move(cb.x + 140, cb.y + cb.height - 90, { steps: 6 });
  await page.mouse.up();
  const t = (await world()).match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
  const t0 = before.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
  expect(Math.round(t[1] - t0[1]) === 120 && Math.round(t[2] - t0[2]) === -70, `pan moved ${t[1] - t0[1]}, ${t[2] - t0[2]}`);
  await fit();
});

// every field and way, on a real case: Charged twice for ₹349 → resolved, HEDGE, ok, amount 349
const CHECKS = [
  ["ok", "is", "true", true], ["ok", "is", "false", false], ["ok", "is not", "true", false], ["ok", "is not", "false", true],
  ["route", "is", "HEDGE", true], ["route", "is", "ACT", false], ["route", "is not", "ESCALATE", true], ["route", "is not", "HEDGE", false],
  ["status", "is", "resolved", true], ["status", "is", "parked", false], ["status", "is not", "refused", true], ["status", "is not", "resolved", false],
  ["result", "contains", "HEDGE", true], ["result", "contains", "broken", false], ["result", "is", "resolved", false], ["result", "is not", "resolved", true],
  ["amount", "is", "349", true], ["amount", "is", "₹349", true], ["amount", "is not", "349", false],
  ["amount", ">", "300", true], ["amount", ">", "349", false], ["amount", "<", "1,000", true], ["amount", "<", "100", false],
];
await step(`every Check field and way on a real case: ${CHECKS.length} checks, each goes the way it should, and its branch runs`, async () => {
  const nodes = [N("s", "start", 0, 200), N("m", "case", 280, 200, { customer_id: "C-1002", message: "I was charged twice for ₹349 at CafeBrew", channel: "chat" })];
  const edges = [W("s", "m")];
  CHECKS.forEach(([field, op, value], i) => {
    nodes.push(N(`k${i}`, "if", 560 + (i % 6) * 250, Math.floor(i / 6) * 120, { field, op, value }));
    edges.push(W("m", `k${i}`));
  });
  nodes.push(N("y", "notify", 2100, 0, { dept: "commit", text: "{case} is {route}: yes" }), N("n", "notify", 2100, 140, { dept: "commit", text: "{case} is {route}: no" }));
  edges.push(W("k4", "y", "yes"), W("k4", "n", "no"));
  const f = await makeFlow("Every check", nodes, edges);
  await openFlow(f.id);
  const r0 = await runHere(f.id);
  const r = await finished(r0.id, 90000);
  expect(r.state === "done", `run ${r.state}`);
  await until(async () => (await state("y")) === "done");
  const bad = [];
  for (const [i, [field, op, value, want]] of CHECKS.entries()) {
    const t = await text(`k${i}`);
    const shown = `${field === "ok" ? "succeeded" : field} ${op} ${value} → ${want ? "yes" : "no"}`;
    if (!t.includes(shown)) bad.push(`${field} ${op} ${value}: “${t}”, wanted “${shown}”`);
  }
  if ((await state("n")) !== "skipped") bad.push("the no branch ran too");
  const post = ((await api("/api/office/chats")).commit ?? []).find((m) => m.text === `${r.nodes.m.out.case_id} is HEDGE: yes`);
  if (!post) bad.push("the yes branch's post is not in the Commit lead's chat");
  expect(!bad.length, bad.join(" · "));
  // a teammate deletes the flow you have open: the Builder says so and moves to another flow
  await api(`/api/flows/${f.id}?by=Ravi`, undefined, "DELETE");
  await page.getByText("“Every check” was deleted by Ravi").first().waitFor();
  await until(async () => (await page.getByRole("textbox", { name: "Flow name" }).inputValue()) !== "Every check");
  expect((await flowSel().inputValue()) !== f.id, "the picker still shows the deleted flow");
});

await step("checks after a task that fails and after a person's answer follow what that step returned", async () => {
  const f = await makeFlow("After steps", [
    N("s", "start", 0, 100), N("t", "task", 260, 100, { dept: "commit", text: "check: ₹500 will be credited in 2 hours, guaranteed" }),
    N("c1", "if", 520, 0, { field: "ok", op: "is", value: "false" }), N("c2", "if", 520, 200, { field: "result", op: "contains", value: "guarantee" }),
    N("a", "approval", 780, 100, { question: "Say yes" }), N("c3", "if", 1040, 100, { field: "ok", op: "is", value: "true" }),
  ], [W("s", "t"), W("t", "c1"), W("t", "c2"), W("c1", "a", "yes"), W("a", "c3", "yes")]);
  await openFlow(f.id);
  const r0 = await runHere(f.id);
  await waitingRun(r0.id);
  const mid = await run(r0.id);
  expect(mid.nodes.t.out.ok === false, `the guard passed it: ${mid.nodes.t.out.result}`);
  expect(mid.nodes.c1.text.endsWith("→ yes"), `c1: ${mid.nodes.c1.text}`);
  expect(mid.nodes.c2.text.endsWith(/guarante/i.test(mid.nodes.t.out.result) ? "→ yes" : "→ no"), `c2: ${mid.nodes.c2.text} for “${mid.nodes.t.out.result}”`);
  await until(async () => (await state("a")) === "waiting");
  await node("a").getByRole("button", { name: "Yes" }).click();
  const r = await finished(r0.id);
  expect(r.nodes.c3.text.endsWith("succeeded is true → yes"), `after yes: ${r.nodes.c3.text}`);
  await api(`/api/flows/${f.id}?by=Flo`, undefined, "DELETE");
});

await step("a Customer message that needs a person waits; “Open Approvals ↗” goes there; approving it lets the flow finish", async () => {
  const f = await makeFlow("Fraud drill", [
    N("s", "start", 0, 100), N("m", "case", 260, 100, { customer_id: "C-1003", message: "There is a transaction of ₹18,500 at QuickPay Store that was not done by me" }),
    N("p", "notify", 520, 100, { dept: "resolution", text: "{case}: {status}, {route}" }),
  ], [W("s", "m"), W("m", "p")]);
  await openFlow(f.id);
  const r0 = await runHere(f.id);
  await until(async () => (await state("m")) === "waiting", 40000);
  const caseId = (await run(r0.id)).nodes.m.text.match(/NR-\d+/)[0];
  await node("m").getByRole("button", { name: "Open Approvals ↗" }).click();
  await until(async () => (await nav("Approvals").getAttribute("aria-current")) === "true");
  const card = page.locator("section", { has: page.getByText(caseId, { exact: true }) }).filter({ has: page.getByRole("button", { name: "Approve", exact: true }) }).first();
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  const r = await finished(r0.id);
  expect(r.state === "done" && r.nodes.m.out.status === "resolved", `${r.state} ${r.nodes.m.out.status}`);
  const post = ((await api("/api/office/chats")).upi ?? []).find((m) => m.text.startsWith(`${caseId}: resolved,`));
  expect(post, "no post in the Resolution lead's chat");
  await nav("Flows").click();
  await page.getByTestId("canvas").waitFor();
  await until(async () => (await state("p")) === "done");
  await api(`/api/flows/${f.id}?by=Flo`, undefined, "DELETE");
});

await step("a task that needs an OK waits on its node; Approvals shows it; approving runs it", async () => {
  const f = await makeFlow("Recalibrate drill", [N("s", "start", 0, 100), N("t", "task", 260, 100, { dept: "decision", text: "Recalibrate" })], [W("s", "t")]);
  await openFlow(f.id);
  const r0 = await runHere(f.id);
  await until(async () => (await state("t")) === "waiting", 40000);
  await node("t").getByRole("button", { name: "Open Approvals ↗" }).click();
  await until(async () => (await nav("Approvals").getAttribute("aria-current")) === "true");
  const opId = (await run(r0.id)).nodes.t.text.match(/^(\S+):/)[1];
  await page.getByText(opId).first().waitFor();
  await api(`/api/office/ops/${opId}/approve`, { by: "Flo" });
  const r = await finished(r0.id);
  expect(r.state === "done" && r.nodes.t.out.ok, `${r.state}: ${r.nodes.t.text}`);
  await nav("Flows").click();
  await page.getByTestId("canvas").waitFor();
  await api(`/api/flows/${f.id}?by=Flo`, undefined, "DELETE");
});

await step("Approvals: a flow's question has Yes, No with a note, and Open flow takes you to that flow in the Builder", async () => {
  const r = await api(`/api/flows/${gate.id}/run`, { by: "Flo" });
  await waitingRun(r.id);
  await nav("Approvals").click();
  const flowCard = (rid) => page.locator("section", { has: page.getByText(rid, { exact: true }) });
  const card = flowCard(r.id);
  await card.getByRole("textbox", { name: `Note for ${r.id}` }).fill("not today");
  await card.getByRole("button", { name: "No" }).click();
  const done = await finished(r.id);
  expect(done.nodes.a.text === "Flo said no: “not today”", done.nodes.a.text);
  const r2 = await api(`/api/flows/${gate.id}/run`, { by: "Flo" });
  await waitingRun(r2.id);
  await flowCard(r2.id).getByRole("button", { name: "Open flow" }).click();
  await page.getByRole("tab", { name: "Builder", selected: true }).waitFor();
  await until(async () => (await flowSel().inputValue()) === gate.id);
  await until(async () => (await state("a")) === "waiting");
  await node("a").getByRole("button", { name: "Yes" }).click();
  await finished(r2.id);
});

await step("Stop ends a running flow; the node says stopped; Run is back", async () => {
  const f = await makeFlow("Slow one", [N("s", "start", 0, 100), N("w", "wait", 260, 100, { seconds: 60 })], [W("s", "w")]);
  await openFlow(f.id);
  const r0 = await runHere(f.id);
  await until(async () => (await state("w")) === "running");
  await tool("Stop").click();
  const r = await finished(r0.id);
  expect(r.state === "stopped" && r.nodes.w.state === "failed" && r.nodes.w.text === "stopped", `${r.state} ${r.nodes.w.state} ${r.nodes.w.text}`);
  await page.locator(".fl-runbar").waitFor({ state: "detached" });
  expect(!(await tool("Run").isDisabled()) && (await tool("Stop").count()) === 0, "Run is not back");
  await api(`/api/flows/${f.id}?by=Flo`, undefined, "DELETE");
});

await step("Copy, the flow picker (with the unsaved-changes question both ways), New, and Delete that asks first", async () => {
  const mh = (await api("/api/flows")).flows.find((x) => x.name === "Model health");
  await openFlow(mh.id);
  await tool("Copy").click();
  expect((await page.getByRole("textbox", { name: "Flow name" }).inputValue()) === "Model health (copy)", "copy name");
  expect((await flowSel().inputValue()) === "", "the copy is not shown as unsaved");
  await save(1);
  const copyId = await flowSel().inputValue();
  const copy = (await api("/api/flows")).flows.find((x) => x.id === copyId);
  expect(copy && copyId !== mh.id && copy.nodes.length === mh.nodes.length && copy.edges.length === mh.edges.length, "the copy is not the same flow");
  // unsaved changes: the picker asks first
  await page.getByRole("textbox", { name: "Flow name" }).fill("Model health (copy) edited");
  page.once("dialog", (d) => d.dismiss());
  await flowSel().selectOption(mh.id);
  await page.waitForTimeout(300);
  expect((await page.getByRole("textbox", { name: "Flow name" }).inputValue()) === "Model health (copy) edited", "dismissing still switched");
  page.once("dialog", (d) => d.accept());
  await flowSel().selectOption(mh.id);
  await until(async () => (await page.getByRole("textbox", { name: "Flow name" }).inputValue()) === "Model health");
  // Delete asks first, then forgets after 3 s
  await openFlow(copyId);
  await tool("Delete").click();
  await tool("Sure? Delete").waitFor();
  await page.waitForTimeout(3300);
  await tool("Delete").waitFor();
  await tool("Delete").click();
  await tool("Sure? Delete").click();
  await until(async () => !(await api("/api/flows")).flows.some((x) => x.id === copyId));
  await page.getByText("Flow deleted").waitFor();
  expect((await flowSel().locator("option").allInnerTexts()).every((t) => t !== "Model health (copy)"), "still in the picker");
  // New, then Delete on the unsaved flow just drops it
  await tool("New").click();
  await node("start1").waitFor();
  await tool("Delete").click();
  await until(async () => (await flowSel().inputValue()) !== "");
});

await step("the three example flows run to completion by the Run button, each down the path it should", async () => {
  const all = (await api("/api/flows")).flows;
  const want = {
    "Morning audit check": { done: ["s", "t", "c", "ok"], skipped: ["ask"] },
    "Duplicate-charge drill": { done: ["s", "m", "c", "y"], skipped: ["a"] },
    "Model health": { done: ["s", "b", "d", "g", "p"], skipped: [] },
  };
  for (const [name, w] of Object.entries(want)) {
    const f = all.find((x) => x.name === name && x.example);
    expect(f, `${name} is not there`);
    await openFlow(f.id);
    const r0 = await runHere(f.id);
    const r = await finished(r0.id, 90000);
    expect(r.state === "done", `${name}: ${r.state} ${r.result}`);
    for (const id of w.done) expect(r.nodes[id].state === "done", `${name}: ${id} is ${r.nodes[id].state} (${r.nodes[id].text})`);
    for (const id of w.skipped) expect(r.nodes[id].state === "skipped", `${name}: ${id} is ${r.nodes[id].state}`);
    await until(async () => (await state(w.done.at(-1))) === "done");
  }
  expect((await api("/api/flows")).flows.find((x) => x.name === "Morning audit check").when_desc !== "by hand", "the morning check has no schedule");
});

await step("every {placeholder} in a post fills in from the run: result, case, route, status, by, flow", async () => {
  const f = await makeFlow("Placeholders", [
    N("s", "start", 0, 100), N("m", "case", 260, 100, { customer_id: "C-1001", message: "Did my last payment go through?" }),
    N("p", "notify", 520, 100, { dept: "intake", text: "R={result}|C={case}|RT={route}|S={status}|B={by}|F={flow}" }),
  ], [W("s", "m"), W("m", "p")]);
  await openFlow(f.id);
  const r = await finished((await runHere(f.id)).id);
  const o = r.nodes.m.out;
  const want = `R=${o.result.split("\n")[0]}|C=${o.case_id}|RT=${o.route}|S=${o.status}|B=Flo|F=Placeholders`;
  expect(((await api("/api/office/chats")).triage ?? []).some((m) => m.text === want), `no “${want}” in the Intake lead's chat`);
  await until(async () => (await text("p")).includes(`C=${o.case_id}|RT=${o.route}`));
  await api(`/api/flows/${f.id}?by=Flo`, undefined, "DELETE");
});

await step("a Start with “every minute” runs by itself, started by the schedule", async () => {
  await toBuilder();
  await tool("New").click();
  await page.getByRole("textbox", { name: "Flow name" }).fill("Every minute");
  await pick("start1");
  await side().getByRole("textbox", { name: "When" }).fill("every minute");
  await pal("notify").click();
  await side().getByRole("textbox", { name: "Message" }).fill("tick by {by}");
  await save(1);
  await page.locator(".fl-tools").getByText(/every minute/).waitFor();
  const id = await flowSel().inputValue();
  const f = (await api("/api/flows")).flows.find((x) => x.id === id);
  expect(f.when?.kind === "minutes" && f.next_at && f.next_at - Date.now() / 1000 <= 61, JSON.stringify(f.when));
  const r = await until(async () => (await runsOf(id)).find((x) => x.by === "schedule"), 80000, 1000);
  const done = await finished(r.id);
  expect(done.state === "done" && done.nodes.notify1.text === "Posted to Oversight: tick by schedule", done.nodes.notify1.text);
  await tool("Delete").click();
  await tool("Sure? Delete").click();
  await until(async () => !(await api("/api/flows")).flows.some((x) => x.id === id));
});

await step("clean up: this test's flows are deleted, the examples are untouched", async () => {
  for (const id of [mainId, gate?.id].filter(Boolean)) await api(`/api/flows/${id}?by=Flo`, undefined, "DELETE");
  const left = (await api("/api/flows")).flows;
  expect(left.filter((x) => x.example).length === flows0.flows.filter((x) => x.example).length, "an example went missing");
});

await step("no uncaught errors and no server errors", async () => { expect(!errors.length, errors.join(" | ")); });

await browser.close();
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
