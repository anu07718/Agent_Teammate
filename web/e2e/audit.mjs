// A supervisor's walk through the whole app: every view, every button, in dark and light, desktop and phone.
// For each click it records page errors, console errors, failed requests, whether anything visible changed,
// and, per view, clipped text, sideways overflow and the fonts in use.
// Usage: node e2e/audit.mjs   (NIRNAYA_URL, SHOTS=dir for screenshots; writes audit.json next to the shots)
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const URL = process.env.NIRNAYA_URL ?? "http://127.0.0.1:8000";
const SHOTS = process.env.SHOTS ?? "e2e/shots/audit";
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ channel: "chromium", args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const report = { views: [], clicks: [], problems: [] };
const problem = (where, what) => { report.problems.push({ where, what }); console.log(`  ! ${where}: ${what}`); };

async function inspect(page, where) {
  return page.evaluate(() => {
    const out = { clipped: [], overflowX: document.documentElement.scrollWidth > innerWidth + 1, fonts: {}, tiny: [] };
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.opacity === "0") continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const fam = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
      out.fonts[fam] = (out.fonts[fam] || 0) + 1;
      if (parseFloat(cs.fontSize) < 9) out.tiny.push(`${el.tagName.toLowerCase()} ${cs.fontSize} "${el.textContent.trim().slice(0, 30)}"`);
      const clips = ["hidden", "clip"].includes(cs.overflowX) || ["hidden", "clip"].includes(cs.overflow);
      if (clips && cs.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 2 && cs.whiteSpace !== "normal")
        out.clipped.push(`${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join(".")} "${el.textContent.trim().slice(0, 40)}"`);
    }
    out.fontsReady = document.fonts.status;
    out.loaded = [...document.fonts].filter((f) => f.status === "loaded").map((f) => `${f.family} ${f.weight}`).slice(0, 12);
    return out;
  });
}

async function session(name, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errs.push(`console: ${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 400 && r.url().startsWith(URL)) errs.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(URL, "")}`); });
  page.on("requestfailed", (r) => { if (!r.url().includes("/api/events")) errs.push(`failed: ${r.url().replace(URL, "")} ${r.failure()?.errorText}`); });
  return { ctx, page, errs, name };
}
const take = (s) => s.errs.splice(0);

// Buttons that change the world in ways later clicks should not see, or leave the app
const SKIP = /restart|reset the world|reset world|simulate a crash|export|download|preview|^delete$|sure\? delete/i;

async function clickAll(s, where, back) {
  const { page } = s;
  const labels = await page.evaluate(() => [...document.querySelectorAll("button, [role=button], a[href]")].filter((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !b.disabled && getComputedStyle(b).visibility !== "hidden";
  }).map((b, i) => ({ i, text: (b.getAttribute("aria-label") || b.textContent || b.title || "").trim().replace(/\s+/g, " ").slice(0, 40) })));
  const seen = new Set();
  const shapes = new Map(); // "NR-1003", "NR-1004"… are one kind of button: click two of each
  for (const { text } of labels) {
    if (!text || seen.has(text) || SKIP.test(text)) continue;
    seen.add(text);
    const shape = text.replace(/\d+/g, "#");
    if ((shapes.get(shape) ?? 0) >= 2) continue;
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    const before = await page.evaluate(() => document.body.innerText.length + ":" + location.href + ":" + document.querySelectorAll("*").length);
    let clicked = false;
    try {
      const el = page.locator("button, [role=button], a[href]").filter({ hasText: text }).first();
      const byLabel = page.locator(`[aria-label="${text.replace(/"/g, '\\"')}"]`).first();
      const target = (await byLabel.count()) ? byLabel : el;
      if (!(await target.count()) || !(await target.isVisible())) continue;
      await target.click({ timeout: 6000 }); // the office's WebGL frames are slow under software rendering
      clicked = true;
    } catch (e) {
      report.clicks.push({ where, text, ok: false, error: e.message.split("\n")[0] });
      continue;
    }
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => document.body.innerText.length + ":" + location.href + ":" + document.querySelectorAll("*").length);
    const errors = take(s).filter((x) => !/HTTP 409/.test(x));
    report.clicks.push({ where, text, ok: !errors.length, changed: before !== after, errors });
    if (errors.length) problem(`${where} → "${text}"`, errors.join(" | "));
    else if (clicked && before === after) report.clicks.at(-1).noop = true;
    writeFileSync(`${SHOTS}/audit.json`, JSON.stringify(report, null, 2));
    await page.keyboard.press("Escape").catch(() => {});
    await back();
  }
}

console.log(`Audit against ${URL}`);

// ── desktop, dark ─────────────────────────────────────────────────────────
const d = await session("desktop", { viewport: { width: 1600, height: 940 } });
await d.page.goto(URL);
await d.page.waitForLoadState("load");
await d.page.locator(".o-root").waitFor();
await d.page.waitForTimeout(2500);
await d.page.screenshot({ path: `${SHOTS}/office.png` });
report.views.push({ view: "office", ...(await inspect(d.page, "office")) });
for (const e of take(d)) problem("office load", e);

const toOffice = async () => {
  if (!(await d.page.locator(".o-root").count())) {
    const nav = d.page.getByRole("navigation", { name: "Views" }).first();
    if (await nav.count()) await nav.getByRole("button", { name: "Office", exact: true }).click().catch(() => {});
  }
  await d.page.keyboard.press("Escape").catch(() => {});
};
// the office's own buttons are walked by run.mjs and team.mjs too; OFFICE=0 skips them here (slow under software GL)
if (process.env.OFFICE !== "0") await clickAll(d, "office", toOffice);

// every department, by key and by card
for (const k of ["1", "2", "3", "4", "5", "6", "b", "g", "p", "c", "d", "d"]) {
  await toOffice();
  await d.page.locator(".o-root").click({ position: { x: 5, y: 400 } }).catch(() => {});
  await d.page.keyboard.press(k);
  await d.page.waitForTimeout(700);
  await d.page.screenshot({ path: `${SHOTS}/office-key-${k}.png` });
  for (const e of take(d)) problem(`office key ${k}`, e);
  if (k === "3" && process.env.OFFICE !== "0") await clickAll(d, "office focus verification", async () => {});
  await d.page.keyboard.press("Escape");
}

// the workspace views
await d.page.keyboard.press("w");
await d.page.waitForTimeout(800);
const views = await d.page.getByRole("navigation", { name: "Views" }).first().getByRole("button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")));
for (const v of views) {
  if (v === "Office") continue;
  const go = async () => {
    await d.page.keyboard.press("Escape").catch(() => {});
    const nav = d.page.getByRole("navigation", { name: "Views" }).first();
    if (!(await nav.count())) { await d.page.keyboard.press("w"); await d.page.waitForTimeout(600); }
    await d.page.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: v, exact: true }).click();
    await d.page.waitForTimeout(500);
  };
  await go();
  await d.page.waitForTimeout(1200);
  await d.page.screenshot({ path: `${SHOTS}/view-${v}.png` });
  report.views.push({ view: v, ...(await inspect(d.page, v)) });
  for (const e of take(d)) problem(`${v} load`, e);
  await clickAll(d, v, go);
}

// light theme once over every view
await d.page.getByRole("button", { name: "Toggle theme" }).click();
for (const v of views) {
  if (v === "Office") continue;
  await d.page.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: v, exact: true }).click();
  await d.page.waitForTimeout(900);
  await d.page.screenshot({ path: `${SHOTS}/light-${v}.png` });
}
await d.page.getByRole("button", { name: "Toggle theme" }).click();
for (const e of take(d)) problem("light theme", e);

// ── phone ─────────────────────────────────────────────────────────────────
const p = await session("phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await p.page.goto(URL);
await p.page.locator(".o-root").waitFor();
await p.page.waitForTimeout(2500);
await p.page.screenshot({ path: `${SHOTS}/phone-office.png`, fullPage: true });
report.views.push({ view: "phone office", ...(await inspect(p.page, "phone office")) });
const pviews = ["Cases", "Approvals", "Channels", "Flows", "Supervisor", "Settings"];
await p.page.getByRole("button", { name: /workspace/i }).first().click().catch(() => {});
await p.page.waitForTimeout(800);
for (const v of pviews) {
  const tab = p.page.getByRole("navigation", { name: "Views" }).last().getByRole("button", { name: v });
  if (!(await tab.count())) { problem("phone", `no tab ${v}`); continue; }
  await tab.click();
  await p.page.waitForTimeout(1000);
  await p.page.screenshot({ path: `${SHOTS}/phone-${v}.png`, fullPage: true });
  report.views.push({ view: `phone ${v}`, ...(await inspect(p.page, `phone ${v}`)) });
}
for (const e of take(p)) problem("phone", e);

for (const v of report.views) {
  if (v.overflowX) problem(v.view, "page scrolls sideways");
  if (v.clipped.length) problem(v.view, `clipped text: ${v.clipped.slice(0, 6).join("; ")}`);
  if (v.tiny.length) problem(v.view, `text under 9px: ${v.tiny.slice(0, 4).join("; ")}`);
}
writeFileSync(`${SHOTS}/audit.json`, JSON.stringify(report, null, 2));
const noops = report.clicks.filter((c) => c.noop).map((c) => `${c.where} → ${c.text}`);
console.log(`\n${report.clicks.length} clicks, ${report.problems.length} problem(s), ${noops.length} click(s) that changed nothing visible`);
if (noops.length) console.log("  no visible change: " + noops.join(" · "));
console.log("fonts:", JSON.stringify(report.views.map((v) => [v.view, Object.keys(v.fonts).join("/")])));
await browser.close();
