// Shared workspaces, end to end, as people use them: Asha hosts on her server and gets a code; Ravi joins
// it from the plain web app (what Vercel and the APK serve, with no server of its own) and Meera from
// another Nirnaya server (as the Windows app has); both see Asha's agents live and work with them; a new
// code shuts them out; leaving goes back home. The relay is Google's Firebase database emulator with the
// project's rules (make relay-emulator), the same REST and streaming API as the free Spark plan.
// Usage: node e2e/workspace.mjs   (NIRNAYA_URL = Asha's server, default http://127.0.0.1:8000;
//        SECOND_URL = another server for Meera (optional); RELAY_URL = the database, default the emulator;
//        APP_DIST = the web files Ravi's app serves, default web/dist; SHOTS = a folder for screenshots)
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = process.env.NIRNAYA_URL ?? "http://127.0.0.1:8000";
const SECOND = process.env.SECOND_URL;
const RELAY = process.env.RELAY_URL ?? "http://127.0.0.1:9000/?ns=demo-nirnaya";
const SHOTS = process.env.SHOTS;
const DIST = process.env.APP_DIST ? join(process.env.APP_DIST, "/") : fileURLToPath(new URL("../dist/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };

// the web app on its own origin, with no API behind it: what Vercel (and the APK's local server) serve
const site = createServer(async (req, res) => {
  const file = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "") || "index.html";
  try {
    const body = await readFile(join(DIST, file));
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(200, { "Content-Type": "text/html" }).end(await readFile(join(DIST, "index.html")));
  }
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const SITE = `http://127.0.0.1:${site.address().port}/`;

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(true);
    console.log(`  ✓ ${name} (${Math.round((Date.now() - t0) / 1000)}s)`);
  } catch (e) {
    results.push(false);
    console.log(`  ✗ ${name}\n      ${e.message.split("\n")[0]}`);
    if (SHOTS) for (const [n, p] of Object.entries(pages)) await p.screenshot({ path: `${SHOTS}/fail-${results.length}-${n}.png` }).catch(() => {});
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const api = async (path, body) => (await fetch(HOST + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
const until = async (fn, ms = 30000, what = "it") => {
  const t0 = Date.now();
  for (;;) {
    const got = await fn().catch(() => null);
    if (got) return got;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 400));
  }
};

console.log(`Shared workspaces: Asha hosts on ${HOST}, Ravi's app at ${SITE}${SECOND ? `, Meera on ${SECOND}` : ""}, relay ${RELAY}`);
const browser = await chromium.launch({ channel: "chromium", args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const pages = {};
const errors = [];
async function person(name, url, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((n) => {
    localStorage.setItem("nirnaya.theme", "light");
    if (!localStorage.getItem("nirnaya.me")) localStorage.setItem("nirnaya.me", JSON.stringify({ client: `${n.toLowerCase()}${Math.random().toString(36).slice(2, 7)}`, name: n }));
  }, name);
  const p = await ctx.newPage();
  p.setDefaultTimeout(30000);
  p.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  p.on("dialog", (d) => void d.accept());
  await p.goto(url);
  pages[name] = p;
  return p;
}
const dialog = (p) => p.getByTestId("collab");
const openCollab = async (p) => { await p.getByTestId("collab-button").first().click(); await dialog(p).waitFor(); };
const closeCollab = async (p) => { await dialog(p).getByRole("button", { name: "Close" }).click(); await dialog(p).waitFor({ state: "detached" }); };

const asha = await person("Asha", HOST);
await asha.locator(".o-root").waitFor();
let code = "";

await step("the person+ button opens Work together; Create refuses a bad database address and says why", async () => {
  await openCollab(asha);
  await dialog(asha).getByRole("tab", { name: "Create a workspace" }).waitFor();
  expect(await dialog(asha).getByRole("tab", { name: "Join a workspace" }).count() === 1, "no Join tab");
  await dialog(asha).getByLabel("Relay database address").fill("not an address");
  await dialog(asha).getByRole("button", { name: /CREATE A WORKSPACE/ }).click();
  const err = await dialog(asha).getByTestId("collab-error").innerText();
  expect(/https:\/\//.test(err), `error: ${err}`);
});

await step("Asha creates a workspace: a 10-character code, copyable, sharing, nobody in yet", async () => {
  await dialog(asha).getByLabel("Workspace name").fill("Asha's workspace");
  await dialog(asha).getByLabel("Relay database address").fill(RELAY);
  await dialog(asha).getByRole("button", { name: /CREATE A WORKSPACE/ }).click();
  await dialog(asha).getByTestId("hosting").waitFor();
  code = (await dialog(asha).getByTestId("workspace-code").innerText()).trim();
  expect(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(code), `code ${code}`);
  await dialog(asha).getByRole("button", { name: "Copy the code" }).waitFor();
  await until(async () => /SHARING/i.test(await dialog(asha).locator(".o-live").innerText()), 15000, "SHARING");
  await dialog(asha).getByText("Nobody yet").waitFor();
  const w = await api("/api/workspace");
  expect(w.hosting?.display === code && w.relay_url === RELAY.replace(/\/$/, ""), JSON.stringify(w));
  if (SHOTS) await asha.screenshot({ path: `${SHOTS}/host.png` });
  await closeCollab(asha);
  await asha.getByTestId("sharing-dot").first().waitFor();
});

const ravi = await person("Ravi", SITE);
await step("Ravi's app has no server: Create says it needs one; a wrong code and an unknown code are refused", async () => {
  await ravi.getByTestId("join-with-code").click();
  await dialog(ravi).waitFor();
  await dialog(ravi).getByRole("tab", { name: "Create a workspace" }).click();
  await dialog(ravi).getByTestId("no-server").waitFor();
  await dialog(ravi).getByRole("tab", { name: "Join a workspace" }).click();
  await dialog(ravi).getByLabel("Relay database address").fill(RELAY);
  await dialog(ravi).getByLabel("Workspace code").fill("12345");
  await dialog(ravi).getByRole("button", { name: "JOIN", exact: true }).click();
  expect(/10 letters/.test(await dialog(ravi).getByTestId("collab-error").innerText()), "short code accepted");
  await dialog(ravi).getByLabel("Workspace code").fill("ABCDE-23456");
  await dialog(ravi).getByRole("button", { name: "JOIN", exact: true }).click();
  await until(async () => /No workspace has that code/.test(await dialog(ravi).getByTestId("collab-error").innerText()), 15000, "the unknown-code error");
});

await step("Ravi joins with the code (typed lowercase, with the dash) and sees Asha's office live", async () => {
  await dialog(ravi).getByLabel("Workspace code").fill(code.toLowerCase());
  await Promise.all([ravi.waitForEvent("load", { timeout: 40000 }), dialog(ravi).getByRole("button", { name: "JOIN", exact: true }).click()]);
  await ravi.getByTestId("joined-pill").first().waitFor();
  expect(/IN ASHA'S WORKSPACE/i.test(await ravi.getByTestId("joined-pill").first().innerText()), "pill text");
  await until(async () => /[1-9]\s*AGENTS/i.test(await ravi.locator('.o-card[data-pod="intake"]').innerText()), 40000, "Asha's agents in Ravi's office");
  expect(await ravi.getByTestId("server-connect").count() === 0, "still asking for a server");
  if (SHOTS) await ravi.screenshot({ path: `${SHOTS}/ravi-office.png` });
});

await step("Asha sees Ravi in her team and in Work together, with where he is and which app", async () => {
  await asha.locator('[data-testid="people"] [data-person="Ravi"]').first().waitFor({ timeout: 40000 });
  await openCollab(asha);
  const m = dialog(asha).locator('[data-member="Ravi"]');
  await m.waitFor({ timeout: 20000 });
  expect(/website/.test(await m.innerText()), await m.innerText());
  await closeCollab(asha);
});

await step("a customer message Ravi types runs on Asha's agents, and Ravi's Task Status shows it live", async () => {
  const before = (await api("/api/state")).cases.length;
  await ravi.getByPlaceholder(/customer message/i).fill("I was charged twice ₹349 at CafeBrew yesterday");
  await ravi.getByRole("button", { name: "ADD", exact: true }).click();
  const id = await until(async () => { const s = await api("/api/state"); return s.cases.length > before && s.cases[0].id; }, 40000, "the case on Asha's server");
  await until(async () => (await api(`/api/cases/${id}`)).status === "resolved", 40000, "the case to finish");
  // the card, live in Ravi's Task Status, says who added it
  await until(async () => /RAVI/i.test(await ravi.locator(".o-row", { hasText: /Duplicate charge/ }).first().innerText()), 40000, "the card in Ravi's Task Status");
});

await step("an approval waits on Asha's side; Ravi approves it from his app and it is Asha's ledger that moves", async () => {
  const c = await api("/api/cases", { customer_id: "C-1003", message: "There is a transaction of ₹18,500 at QuickPay Store that was not done by me", channel: "chat", by: "Asha" });
  await until(async () => (await api(`/api/cases/${c.id}`)).pending, 40000, "the sealed approval");
  await ravi.getByTestId("joined-pill").first().waitFor();
  await ravi.getByRole("button", { name: "Workspace" }).first().click();
  await ravi.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: /^Approvals/ }).click();
  const card = ravi.locator("section", { has: ravi.getByText(c.id, { exact: true }) }).filter({ has: ravi.getByRole("button", { name: /Approve/ }) }).first();
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  const after = await until(async () => { const x = await api(`/api/cases/${c.id}`); return !x.pending && x.status === "resolved" && x; }, 40000, "the approval on Asha's server");
  const trail = await api("/api/trail?limit=200");
  expect(trail.some((t) => t.case_id === c.id && /approv/.test(t.kind) && JSON.stringify(t).includes("Ravi")), "the trail does not say Ravi approved");
  expect(after.decisions.some((d) => d.committed), "nothing committed");
});

await step("the packet and the .xlsx open through Asha's server", async () => {
  const id = (await api("/api/state")).cases[0].id;
  await ravi.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: /^Cases/ }).click();
  await ravi.getByText(id, { exact: true }).first().click();
  const [dl] = await Promise.all([ravi.waitForEvent("download"), ravi.getByRole("button", { name: /Export \.xlsx/ }).click()]);
  expect(dl.suggestedFilename() === `${id}.xlsx`, dl.suggestedFilename());
  const bytes = await (await import("node:fs/promises")).readFile(await dl.path());
  expect(bytes.subarray(0, 2).toString() === "PK", "not an xlsx (zip) file");
  const [pop] = await Promise.all([ravi.context().waitForEvent("page"), ravi.getByRole("button", { name: /Packet/ }).click()]);
  await pop.waitForLoadState();
  await until(async () => (await pop.locator("body").innerText()).includes(id), 20000, "the packet");
  await pop.close();
});

await step("only Asha changes keys: Ravi's Save in Settings is refused, saying only the host can", async () => {
  await ravi.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: "Settings", exact: true }).click();
  const groq = ravi.locator('[data-provider="groq"]');
  await groq.getByLabel("Groq key").fill("gsk_not_mine");
  await groq.getByRole("button", { name: "Save" }).click();
  await ravi.getByText(/Only the workspace's host can do this/).first().waitFor();
  expect(!(await api("/api/llm")).providers.find((p) => p.id === "groq").key_set, "a member saved a key on the host");
});

let meera;
if (SECOND) {
  await step("Meera joins from her own Nirnaya server (as the Windows app does); both members show for Asha", async () => {
    meera = await person("Meera", SECOND);
    await meera.locator(".o-root").waitFor();
    await openCollab(meera);
    await dialog(meera).getByRole("tab", { name: "Join a workspace" }).click();
    await dialog(meera).getByLabel("Workspace code").fill(code);
    const db = dialog(meera).getByLabel("Relay database address");
    if (await db.count()) await db.fill(RELAY);
    await Promise.all([meera.waitForEvent("load", { timeout: 40000 }), dialog(meera).getByRole("button", { name: "JOIN", exact: true }).click()]);
    await meera.getByTestId("joined-pill").first().waitFor();
    await openCollab(asha);
    await dialog(asha).locator('[data-member="Meera"]').waitFor({ timeout: 40000 });
    await dialog(asha).locator('[data-member="Ravi"]').waitFor();
    await closeCollab(asha);
    // Meera's own server still has its own work: her dialog shows it is not sharing, and Leave goes back to it
    await openCollab(meera);
    await dialog(meera).getByTestId("joined").waitFor();
    await dialog(meera).getByRole("button", { name: /LEAVE/ }).click();
    await meera.waitForLoadState("load");
    await meera.locator(".o-root").waitFor();
    await until(async () => (await meera.getByTestId("joined-pill").count()) === 0, 20000, "Meera back on her own server");
  });
}

await step("a new code shuts out the old one: Ravi is told the workspace closed, and the old code no longer works", async () => {
  await openCollab(asha);
  await dialog(asha).getByRole("button", { name: /NEW CODE/ }).click();
  const fresh = await until(async () => { const t = (await dialog(asha).getByTestId("workspace-code").innerText()).trim(); return t !== code && t; }, 20000, "a new code");
  expect(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(fresh), fresh);
  await until(async () => /CLOSED/i.test(await ravi.getByTestId("joined-pill").first().innerText()), 45000, "Ravi's pill to say closed");
  await closeCollab(asha);
  code = fresh;
});

await step("Ravi leaves and is back on his own app, which asks for a server again", async () => {
  await ravi.getByTestId("joined-pill").first().click();
  await dialog(ravi).getByTestId("joined").waitFor();
  await Promise.all([ravi.waitForEvent("load", { timeout: 30000 }), dialog(ravi).getByRole("button", { name: /LEAVE/ }).click()]);
  await ravi.getByTestId("server-connect").waitFor({ timeout: 30000 });
  expect(await ravi.evaluate(() => localStorage.getItem("nirnaya.joined")) === null, "still remembered as joined");
});

await step("Asha stops sharing: the code is gone from the database and joining with it is refused", async () => {
  await openCollab(asha);
  await dialog(asha).getByRole("button", { name: "STOP SHARING" }).click();
  await dialog(asha).getByRole("button", { name: /CREATE A WORKSPACE/ }).waitFor();
  expect((await api("/api/workspace")).hosting === null, "still hosting");
  await closeCollab(asha);
  await ravi.getByTestId("join-with-code").click();
  await dialog(ravi).getByLabel("Workspace code").fill(code);
  const db = dialog(ravi).getByLabel("Relay database address");
  if (await db.count()) await db.fill(RELAY);
  await dialog(ravi).getByRole("button", { name: "JOIN", exact: true }).click();
  await until(async () => /No workspace has that code/.test(await dialog(ravi).getByTestId("collab-error").innerText()), 15000, "the refusal");
});

await step("no page errors", async () => { expect(!errors.length, errors.slice(0, 3).join(" | ")); });

await browser.close();
site.close();
const ok = results.filter(Boolean).length;
console.log(`${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
