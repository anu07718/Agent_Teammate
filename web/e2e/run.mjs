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

const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const nav = () => page.getByRole("navigation", { name: "Views" }).first();
const go = (name) => nav().getByRole("button", { name, exact: true }).click();
const shot = (n) => SHOTS && page.screenshot({ path: `${SHOTS}/${n}.png` });

console.log(`Nirnaya e2e against ${URL}`);
await api("/api/sim/reset", { method: "POST" });
const before = (await api("/api/cases")).length;

await step("app loads and the event stream is live", async () => {
  await page.goto(URL, { waitUntil: "load" });
  await page.getByText("LIVE", { exact: true }).waitFor({ timeout: 10000 });
});

await step("a failed UPI debit past its TAT is reversed with compensation, alone", async () => {
  await page.getByRole("button", { name: "Failed UPI, 3 days late", exact: true }).click();
  const c = await waitFor(async () => {
    const cs = await api("/api/cases");
    return cs.length > before && cs[0].status !== "running" ? cs[0] : null;
  });
  const d = await api(`/api/cases/${c.id}`);
  const r = Object.fromEntries(d.decisions.map((x) => [x.action.type, x.route]));
  expect(r.reverse_failed_debit === "ACT" && r.tat_compensation === "ACT", `routes ${JSON.stringify(r)}`);
  expect(d.guard.ok, "reply failed the Promise Guard");
  await shot("e2e-01-office");
});

let parked;
await step("an unauthorised ₹18,500 is blocked now and the credit is sealed for a human", async () => {
  const known = new Set((await api("/api/cases")).map((c) => c.id));
  await page.getByRole("button", { name: "Unauthorised ₹18,500", exact: true }).click();
  parked = await waitFor(async () => (await api("/api/approvals")).find((a) => !known.has(a.case.id)));
  expect(parked.pending.seal && parked.pending.actions[0].type === "chargeback_credit", "nothing sealed");
  await go("Approvals");
  await page.getByText(parked.case.id).first().waitFor();
  await shot("e2e-02-approvals");
});

await step("an approval does not apply after the ledger moves (seal broken, case re-validated)", async () => {
  const card = page.locator("section", { hasText: parked.case.id }).first();
  await card.getByRole("button", { name: /Move the ground/ }).click();
  await page.waitForTimeout(400);
  await card.getByRole("button", { name: /^Approve/ }).click();
  const c = await waitFor(async () => {
    const d = await api(`/api/cases/${parked.case.id}`);
    return d.seal_broken ? d : null;
  });
  expect(c.seal_broken.why.includes("ledger moved"), c.seal_broken.why);
});

await step("the re-sealed approval then commits exactly once", async () => {
  const again = await waitFor(async () => (await api("/api/approvals")).find((a) => a.case.id === parked.case.id));
  expect(again.pending.seal !== parked.pending.seal, "seal did not change");
  await go("Cases");
  await go("Approvals");
  const card = page.locator("section", { hasText: parked.case.id }).first();
  await card.getByRole("button", { name: /^Approve/ }).click();
  await waitFor(async () => (await api(`/api/cases/${parked.case.id}`)).status === "resolved");
});

await step("a duplicate charge is hedged, then undone from the case view", async () => {
  await go("Office");
  await page.getByRole("button", { name: "Charged twice", exact: true }).click();
  const c = await waitFor(async () => {
    const cs = await api("/api/cases");
    const x = cs.find((k) => k.intent === "duplicate_charge" && k.status !== "running");
    return x ?? null;
  });
  expect(c.route === "HEDGE", `route ${c.route}`);
  await page.locator("aside").getByText(c.id).first().click();
  await page.getByRole("button", { name: /Undo/ }).click();
  await waitFor(async () => (await api(`/api/cases/${c.id}`)).decisions.some((d) => d.undone));
  await shot("e2e-03-case");
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
  await shot("e2e-04-supervisor");
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
  await go("Office");
  const known = new Set((await api("/api/cases")).map((c) => c.id));
  await page.getByRole("button", { name: "Unauthorised ₹18,500", exact: true }).click();
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

await step("the other views render (brain, ledger)", async () => {
  await go("Brain");
  await page.getByText("Context graph").waitFor();
  await go("Ledger");
  await page.getByText("Live systems (simulated)").waitFor();
  await page.waitForTimeout(2500);
  await shot("e2e-05-ledger");
});

await step("the phone layout shows the bottom tab bar", async () => {
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.goto(URL, { waitUntil: "load" });
  await phone.getByRole("navigation", { name: "Views" }).last().getByRole("button", { name: "Approvals" }).click();
  await phone.getByText("Approvals").first().waitFor();
  if (SHOTS) await phone.screenshot({ path: `${SHOTS}/e2e-06-phone.png` });
  await phone.close();
});

await step("no uncaught errors in the page", async () => expect(!errors.length, errors.join(" | ")));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
