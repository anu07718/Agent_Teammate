// The Android app's flow, in Chromium at phone size: the built web app served from its own origin
// (as the APK serves it from http://localhost), marked as a native shell, with no server set. It must
// ask for the server, connect, and then work against it.
// Usage: node e2e/phone-client.mjs   (NIRNAYA_URL = a running server, default http://127.0.0.1:8000;
//        APP_DIST = the web files to serve, default web/dist; KEYED_URL = a second server started with
//        NIRNAYA_ACCESS_KEY=e2e-key, to try the lock screen from the app's own origin)
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = process.env.NIRNAYA_URL ?? "http://127.0.0.1:8000";
const KEYED = process.env.KEYED_URL;
const SHOTS = process.env.SHOTS;
// APP_DIST=folder serves another build, such as the assets/public folder unpacked from the APK itself
const DIST = process.env.APP_DIST ? join(process.env.APP_DIST, "/") : fileURLToPath(new URL("../dist/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };

// a stand-in for the APK's local web server: files from web/dist, index.html for anything else
const shell = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
  const file = path || "index.html";
  try {
    const body = await readFile(join(DIST, file));
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(200, { "Content-Type": "text/html" }).end(await readFile(join(DIST, "index.html")));
  }
});
await new Promise((r) => shell.listen(0, "127.0.0.1", r));
const APP = `http://127.0.0.1:${shell.address().port}/`;

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push(false);
    console.log(`  ✗ ${name}\n      ${e.message.split("\n")[0]}`);
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

console.log(`Phone client: app at ${APP}, server at ${SERVER}`);
const browser = await chromium.launch({ channel: "chromium", args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await ctx.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" }; });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await step("first launch asks for the server", async () => {
  await page.goto(APP);
  const box = page.getByTestId("server-connect");
  await box.waitFor({ timeout: 20000 });
  await page.getByRole("textbox", { name: "Server address" }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone-connect.png` });
});

await step("entering the address connects and the office goes live", async () => {
  await page.getByRole("textbox", { name: "Server address" }).fill(SERVER.replace(/^http:\/\//, ""));
  await page.getByRole("button", { name: "CONNECT" }).click();
  await page.waitForLoadState("load");
  await page.getByTestId("server-connect").waitFor({ state: "detached", timeout: 20000 });
  const saved = await page.evaluate(() => localStorage.getItem("nirnaya.server"));
  expect(saved === SERVER, `saved server ${saved}`);
  await page.locator(".o-root").waitFor();
});

await step("a customer message typed on the phone becomes a case on the server", async () => {
  const before = (await (await fetch(`${SERVER}/api/state`)).json()).cases.length;
  await page.getByPlaceholder(/customer message/i).fill("My UPI payment of ₹1,250 failed but the money left my account");
  await page.getByRole("button", { name: "ADD", exact: true }).click();
  const t0 = Date.now();
  let after = before;
  while (Date.now() - t0 < 20000 && after <= before) {
    await new Promise((r) => setTimeout(r, 400));
    after = (await (await fetch(`${SERVER}/api/state`)).json()).cases.length;
  }
  expect(after > before, "no new case on the server");
  await page.waitForTimeout(4000);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone-office.png` });
});

await step("the address survives a restart of the app", async () => {
  await page.reload();
  await page.locator(".o-root").waitFor();
  await page.waitForTimeout(2500);
  expect(!(await page.getByTestId("server-connect").count()), "asked for the server again");
});

const bar = () => page.getByRole("navigation", { name: "Views" }).last();
await step("Cases on the phone: the list fills the screen, a case opens over it, ◂ Cases goes back", async () => {
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await bar().getByRole("button", { name: "Cases" }).click();
  const filter = page.getByRole("textbox", { name: "Filter cases" });
  await filter.waitFor();
  expect((await filter.boundingBox()).width > 300, "the list does not fill the phone");
  await page.locator("aside button").filter({ hasText: /NR-\d+/ }).first().click();
  await page.getByRole("button", { name: "Back to the cases" }).waitFor();
  await page.getByRole("tab", { name: "Timeline" }).waitFor();
  await page.getByRole("button", { name: "Back to the cases" }).click();
  await filter.waitFor();
});

await step("Channels on the phone: the tab opens, a setting saved on the phone is saved on the server", async () => {
  await bar().getByRole("button", { name: "Channels" }).click();
  await page.getByRole("heading", { name: "Channels", exact: true }).waitFor();
  expect(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), "Channels scrolls sideways");
  await page.getByRole("tab", { name: "Email", exact: true }).click();
  const name = `Support ${Date.now() % 10000}`;
  await page.getByLabel("Name on emails", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).last().click();
  await page.locator("[aria-live] button", { hasText: "Email saved" }).first().waitFor();
  const cfg = (await (await fetch(`${SERVER}/api/channels`)).json()).config.email;
  expect(cfg.name === name, `the server has ${cfg.name}`);
  await page.getByRole("tab", { name: /Inbox/ }).click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone-channels.png` });
  await bar().getByRole("button", { name: "Office" }).click();
  await page.locator(".o-root").waitFor();
});

if (KEYED) {
  await step("a server with an access key: the app asks for it, refuses a wrong one, and works with the right one", async () => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await c.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" }; });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(`keyed: ${e.message}`));
    await p.goto(APP);
    await p.getByRole("textbox", { name: "Server address" }).fill(KEYED.replace(/^http:\/\//, ""));
    await p.getByRole("button", { name: "CONNECT" }).click();
    const dialog = p.getByRole("dialog", { name: "Access key" });
    await dialog.waitFor({ timeout: 20000 });
    await dialog.getByLabel("Access key").fill("wrong");
    await p.getByRole("button", { name: "Unlock" }).click();
    await p.getByText("That key is not right.").waitFor();
    await dialog.getByLabel("Access key").fill("e2e-key");
    await p.getByRole("button", { name: "Unlock" }).click();
    await p.locator(".o-root").waitFor({ timeout: 20000 });
    await p.getByText("LIVE · NIRNAYA").waitFor({ timeout: 20000 }); // the live stream carries the key too
    await c.close();
  });
}

await step("no uncaught errors", async () => {
  expect(!errors.length, errors.join(" | "));
});

await browser.close();
shell.close();
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
