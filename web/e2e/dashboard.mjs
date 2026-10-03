// The dashboard in a real browser: Intake reads back a sentence's tokens as you type; the case it opens is
// counted with the tokens the model spent on it; the Dashboard shows accepted / waiting / rejected, tokens and
// cost per day, and clicking a case lists every agent that worked on it. The model is a stand-in started here
// that answers like Ollama (OpenAI-compatible, with its own token counts in `usage`).
// Usage: node e2e/dashboard.mjs   (NIRNAYA_URL, default http://127.0.0.1:8000; SHOTS=dir)
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
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/dashboard-fail-${results.length}.png` }).catch(() => {});
  }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
const api = async (p, init) => (await fetch(URL + p, { headers: { "Content-Type": "application/json" }, ...init })).json();
async function until(fn, ms = 30000, every = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, every)); }
  throw new Error("timed out waiting");
}

// a stand-in for Ollama: lists one model, answers each job plainly, and counts 100 tokens in and 20 out per call
let calls = 0;
const model = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const send = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "GET") return send({ object: "list", data: [{ id: "qwen3.6:8b" }] });
    const j = JSON.parse(body || "{}");
    const sys = j.messages?.[0]?.content ?? "", user = j.messages?.[1]?.content ?? "";
    let content = "Nothing on my desk right now.";
    if (/classify/.test(sys)) content = "{}";                                 // leave the reading to the rules
    else if (/topic filter/.test(sys)) content = '{"in_scope": true}';
    else if (/A correct but plain version:/.test(user)) content = user.split("A correct but plain version:\n")[1];
    calls += 1;
    send({ id: `c${calls}`, object: "chat.completion", model: j.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
const MODEL = `http://127.0.0.1:${model.address().port}/v1`;

console.log(`Dashboard and tokens, in a browser, against ${URL}`);
const browser = await chromium.launch({ channel: "chromium", args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 940 } });
page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
const ME = `Ira ${Date.now() % 1000}`;
const panel = () => page.getByTestId("task-panel");
const box = () => panel().getByRole("textbox", { name: "Task" });
const TEXT = "I was charged twice ₹349 at CafeBrew yesterday";
let before, caseId;

await step("set up: the model is the Ollama stand-in, and the office opens", async () => {
  const off = Object.fromEntries(["groq", "gemini", "openrouter", "mistral", "custom"].map((p) => [p, { enabled: false }]));
  await api("/api/llm", { method: "PUT", body: JSON.stringify({ enabled: true, order: ["ollama", "groq", "gemini", "openrouter", "mistral", "custom"],
    providers: { ...off, ollama: { enabled: true, base_url: MODEL, model: "qwen3.6:8b" } } }) });
  await api("/api/usage", { method: "PUT", body: JSON.stringify({ model: "qwen3.6", runtime: "Ollama", price_in: 15, price_out: 60 }) });
  before = await api("/api/dashboard");
  await page.goto(`${URL}/?as=${encodeURIComponent(ME)}`);
  await page.locator(".o-root").waitFor();
  await panel().getByText("LIVE · NIRNAYA").waitFor({ timeout: 20000 });
});

await step("Intake reads back the tokens in the sentence as you type it", async () => {
  await panel().getByRole("button", { name: "Department" }).click();
  await page.locator(".o-menu button", { hasText: "INTAKE" }).first().click();
  await box().fill(TEXT);
  const chip = page.getByTestId("intake-tokens");
  await chip.waitFor();
  const want = (await api(`/api/office/interpret?dept=intake&text=${encodeURIComponent(TEXT)}`)).tokens;
  await until(async () => (await chip.innerText()).replace(/\D/g, "") === String(want), 5000);
  await box().fill(TEXT + " at 9pm, please check");
  await until(async () => Number((await chip.innerText()).replace(/\D/g, "")) > want, 5000);
  await box().fill(TEXT);
  await until(async () => (await chip.innerText()).replace(/\D/g, "") === String(want), 5000);
});

await step("the case it opens says the tokens it took, and its card shows the model's tokens when done", async () => {
  const known = new Set((await api("/api/cases")).map((c) => c.id));
  await panel().getByRole("button", { name: "ADD", exact: true }).click();
  await page.locator(".o-hint").filter({ hasText: /token/ }).waitFor();
  const c = await until(async () => (await api("/api/cases")).find((x) => !known.has(x.id)));
  caseId = c.id;
  const done = await until(async () => { const x = await api(`/api/cases/${caseId}`); return x.status !== "running" && x; });
  expect(done.tokens > 0 && done.tokens % 120 === 0, `tokens ${done.tokens}`);
  await panel().locator(`.o-row[data-id="${caseId}"] .tok`).filter({ hasText: `${done.tokens} tokens` }).waitFor({ timeout: 15000 });
});

await step("the Dashboard counts accepted, waiting and rejected cases, and the tokens and cost", async () => {
  // one that waits for a person and one the agents refuse
  const held = (await api("/api/cases", { method: "POST", body: JSON.stringify({ customer_id: "C-1003", message: "There is a transaction of ₹18,500 at QuickPay Store that was not done by me" }) })).id;
  const refused = (await api("/api/cases", { method: "POST", body: JSON.stringify({ customer_id: "C-1002", message: "my otp is 482913 someone called asking for it" }) })).id;
  await until(async () => { const a = await api(`/api/cases/${held}`), b = await api(`/api/cases/${refused}`); return a.status === "parked" && b.status === "refused"; });
  await page.goto(`${URL}/?as=${encodeURIComponent(ME)}`);
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: "Dashboard", exact: true }).click();
  const dash = page.getByTestId("dashboard");
  await dash.waitFor();
  const d = await api("/api/dashboard");
  expect(d.cases.accepted === before.cases.accepted + 1 && d.cases.waiting === before.cases.waiting + 1 && d.cases.rejected === before.cases.rejected + 1,
    `before ${JSON.stringify(before.cases)} after ${JSON.stringify(d.cases)}`);
  const kpis = page.getByTestId("dash-kpis");
  await kpis.getByText("Waiting for a person").waitFor();
  expect((await kpis.innerText()).includes(String(d.cases.total)), "the cases tile");
  expect(d.usage.total >= 120 && d.usage.model.name === "qwen3.6", JSON.stringify(d.usage.model));
  expect(d.usage.cost === Math.round(((d.usage.in * 15 + d.usage.out * 60) / 1e6) * 1e4) / 1e4, `cost ${d.usage.cost}`);
  await page.getByTestId("chart-cases").locator("svg").waitFor();
  await page.getByTestId("chart-tokens").locator("svg").waitFor();
  await page.getByTestId("dash-model").getByText("qwen3.6").waitFor();
  expect(!(await dash.innerText()).toLowerCase().includes("groq"), "the dashboard names Groq");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dashboard.png`, fullPage: true });
});

await step("clicking a case lists every agent that worked on it, with its tokens", async () => {
  await page.getByTestId("dash-items").locator(`tr[data-id="${caseId}"]`).click();
  const det = page.getByTestId("dash-detail");
  await det.waitFor();
  const item = await api(`/api/dashboard/item/${caseId}`);
  await until(async () => (await page.getByTestId("dash-agent-count").innerText()) === String(item.agents.length), 5000);
  for (const a of ["Tokeniser", "Sentry", "Triage", "Router", "Responder"]) await page.getByTestId("dash-agents").getByText(a, { exact: true }).waitFor();
  expect(item.tokens.total > 0 && item.tokens.jobs.length >= 1, JSON.stringify(item.tokens));
  await det.getByText(item.tokens.jobs[0].label).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dashboard-detail.png` });
});

await step("the model's label and prices are settings, and the cost follows them", async () => {
  const edit = page.getByTestId("dash-model").locator("..").locator("..").getByRole("button", { name: "Edit" });
  await edit.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await edit.click();
  await page.getByLabel("Price in").fill("0");
  await page.getByLabel("Price out").fill("0");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Model and prices saved").waitFor();
  expect((await api("/api/dashboard")).usage.cost === 0, "cost did not follow the prices");
  await page.getByTestId("dash-detail").locator("..").getByText("₹0", { exact: true }).waitFor();   // the open case follows too
  await api("/api/usage", { method: "PUT", body: JSON.stringify({ price_in: 15, price_out: 60 }) });
});

await step("dark theme renders the charts, and no uncaught or server errors", async () => {
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.getByTestId("chart-cases").locator("svg").waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dashboard-dark.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  expect(!errors.length, errors.join(" | "));
});

// leave the server as it was found: no model
await api("/api/llm", { method: "PUT", body: JSON.stringify({ providers: { ollama: { enabled: true, base_url: "", model: "" } } }) }).catch(() => {});
await browser.close();
model.close();
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
