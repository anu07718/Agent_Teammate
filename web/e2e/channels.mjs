// Channels in a real browser. The Channels view: the public address, every Email, WhatsApp, Calls and
// Webhooks field and choice, contacts and unknown senders. Real email through a real SMTP and IMAP server
// (GreenMail). WhatsApp and phone calls through stand-ins for Meta's Graph API and Twilio that answer the
// way they do. Webhooks to and from "n8n". Forwarding and calling from a case, approving by email, a flow
// built in the Builder that starts on a WhatsApp message and uses every channel step. The call page
// talking by voice (speech recognition and speech are mocked: the browser's own recognition needs a
// microphone and Google's servers), with someone new, muted, by typing, with no recognition at all and
// with the microphone blocked. And, given a second server started with an access key, the lock screen.
// Usage: node e2e/channels.mjs
//   NIRNAYA_URL   the server (default http://127.0.0.1:8000; a fresh one: `python -m nirnaya --reset`)
//   GreenMail on 127.0.0.1:3025 (SMTP) and 3143 (IMAP): `make mail-server`
//   KEYED_URL     optional: a second server started with NIRNAYA_ACCESS_KEY=e2e-key
//   SHOTS=dir     screenshots of failures
import { chromium } from "playwright";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import http from "node:http";

const URL = process.env.NIRNAYA_URL ?? "http://127.0.0.1:8000";
const KEYED_URL = process.env.KEYED_URL;
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
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/ch-fail-${results.length}.png` }).catch(() => {});
  }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
// one retry on a network error: Node may reuse a keep-alive connection the server has just closed while
// the test was reading a mailbox (an error before any answer, never a server error)
const fetchOnce = (url, init) => fetch(url, init).catch((e) => { if (e instanceof TypeError) return fetch(url, init); throw e; });
const api = async (p, body, method) => {
  const r = await fetchOnce(URL + p, body === undefined ? { method: method ?? "GET" } : { method: method ?? "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
async function until(fn, ms = 30000, every = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, every)); }
  throw new Error("timed out waiting");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAILED_UPI = "My UPI payment of ₹2,450 to FreshMart failed 3 days ago but the money was debited from my account";
const DUPLICATE = "I was charged twice for ₹349 at CafeBrew yesterday";
const UNAUTHORISED = "There is a transaction of ₹18,500 at QuickPay Store that was not done by me, please help";
const tag = String(Date.now()).slice(-6);
const ME = `Asha ${tag.slice(-3)}`;
const PUBLIC = "https://nirnaya-e2e.trycloudflare.com";
const MEERA_WA = "919123456780"; // Meera Iyer's registered mobile, with the country code
const AARAV_WA = "919876543210";

// ── real email: GreenMail, through Python's own SMTP and IMAP clients ───────
const PY = String.raw`
import json, smtplib, imaplib, sys, email, email.policy
from email.message import EmailMessage
cmd, arg = sys.argv[1], json.loads(sys.argv[2])
if cmd == "send":
    m = EmailMessage()
    m["From"], m["To"], m["Subject"], m["Message-ID"] = arg["from"], arg["to"], arg["subject"], arg["id"]
    for k, v in (arg.get("headers") or {}).items():
        m[k] = v
    m.set_content(arg["text"])
    with smtplib.SMTP("127.0.0.1", 3025) as s:
        s.send_message(m)
    print("{}")
else:
    c = imaplib.IMAP4("127.0.0.1", 3143)
    try:
        c.login(arg["login"], arg.get("password") or arg["login"])
    except imaplib.IMAP4.error:
        print("[]")  # GreenMail makes a mailbox when the first message for it arrives
        sys.exit(0)
    c.select("INBOX")
    _, data = c.uid("SEARCH", None, "ALL")
    out = []
    for uid in (data[0] or b"").split()[-80:]:
        _, parts = c.uid("FETCH", uid, "(BODY.PEEK[])")
        msg = email.message_from_bytes(next(p[1] for p in parts if isinstance(p, tuple)), policy=email.policy.default)
        body = msg.get_body(("plain",))
        out.append({"subject": str(msg["Subject"]), "from": str(msg["From"]), "id": str(msg["Message-ID"]),
                    "in_reply_to": str(msg["In-Reply-To"] or ""), "auto": str(msg["Auto-Submitted"] or ""),
                    "text": body.get_content() if body else ""})
    c.logout()
    print(json.dumps(out))
`;
const py = (cmd, arg) => JSON.parse(execFileSync("python3", ["-c", PY, cmd, JSON.stringify(arg)], { encoding: "utf8" }));
const sendMail = (from, to, subject, text, id, headers) => py("send", { from, to, subject, text, id, headers });
const mailbox = (login, password) => py("read", { login, password });

// ── stand-ins for Meta's Graph API, Twilio and an n8n webhook ───────────────
const calls = [];
const fake = http.createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const ct = req.headers["content-type"] || "";
    const body = ct.includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ path: req.url, headers: req.headers, body });
    let out = { ok: true };
    if (req.url.endsWith("/messages")) out = { messages: [{ id: `wamid.e2e${calls.length}` }] };
    else if (req.url.endsWith("/Calls.json")) out = { sid: `CAe2e${calls.length}` };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;
const to = (part) => calls.filter((c) => c.path.includes(part));
const waTexts = () => to("/messages").filter((c) => c.body.type === "text").map((c) => ({ to: c.body.to, text: c.body.text.body, headers: c.headers, path: c.path }));
async function waIn(from, text, id, name) {
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { display_phone_number: "15550001111", phone_number_id: "PNID-e2e" },
    contacts: [{ profile: { name }, wa_id: from }],
    messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "shh-e2e").update(body).digest("hex");
  return (await fetchOnce(`${URL}/api/channels/whatsapp/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body })).status;
}

// ── the speech the call page hears and says, mocked ─────────────────────────
// SpeechRecognition hears what the test pushes onto window.__script; speechSynthesis records what is said.
const SPEECH = `(() => {
  window.__said = []; window.__script = []; window.__srLang = []; window.__listening = false;
  const mode = window.__speechMode || "${"voice"}";
  class FakeSR {
    constructor() { this.lang = ""; this.interimResults = false; this.continuous = false; this.maxAlternatives = 1; }
    start() {
      window.__srLang.push(this.lang); window.__listening = true; this._on = true;
      if (sessionStorage.getItem("e2e.mic") === "blocked") { setTimeout(() => { window.__listening = false; this.onerror && this.onerror({ error: "not-allowed" }); this.onend && this.onend(); }, 30); return; }
      this._t = setInterval(() => {
        if (!window.__script.length) return;
        clearInterval(this._t);
        const text = window.__script.shift();
        this.onresult && this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text.slice(0, 12), confidence: 0.9 }], { isFinal: false })] });
        setTimeout(() => {
          this.onresult && this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal: true })] });
          window.__listening = false; this._on = false;
          setTimeout(() => this.onend && this.onend(), 20);
        }, 80);
      }, 100);
    }
    abort() { if (!this._on) return; this._on = false; clearInterval(this._t); window.__listening = false; setTimeout(() => this.onend && this.onend(), 0); } // like Chrome: nothing once it has ended
    stop() { this.abort(); }
  }
  window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
  const synth = { speaking: false, speak(u) { window.__said.push({ text: u.text, lang: u.lang }); setTimeout(() => u.onend && u.onend({}), 60); },
    cancel() {}, pause() {}, resume() {}, getVoices() { return []; }, addEventListener() {}, removeEventListener() {} };
  try { Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true }); } catch (e) { window.speechSynthesis.speak = synth.speak; window.speechSynthesis.cancel = synth.cancel; }
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; this.lang = ""; this.voice = null; } };
})();`;
const NO_SPEECH = `(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; })();`;

console.log(`Channels, end to end, against ${URL} (providers stood in for at ${FAKE}; mail on GreenMail)`);
const browser = await chromium.launch({ channel: "chromium", args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 }, permissions: ["clipboard-read", "clipboard-write"] });
page = await ctx.newPage();
const errors = [];
const watch = (p) => {
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("response", (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
};
watch(page);
const ws = page;   // the workspace tab (the call-page steps open their own)
const nav = (label) => page.getByRole("navigation", { name: "Views" }).first().getByRole("button", { name: label, exact: true });
const tab = (name) => page.getByRole("tab", { name, exact: true });
const f = (label) => page.getByLabel(label, { exact: true });
const toast = (re) => page.locator("[aria-live] button", { hasText: re }).first();
const card = (ch) => page.locator(`[data-channel="${ch}"]`);
const saveForm = () => page.getByRole("button", { name: "Save", exact: true }).last();
const outCount = async (ch) => Number((await card(ch).innerText()).match(/(\d+) out/)?.[1] ?? 0); // this server process's count
const snapshot = () => api("/api/channels");

// ── the Channels view ───────────────────────────────────────────────────────
await step("Channels is in the nav (4th: key 4 opens it); all four channels start switched off", async () => {
  await page.goto(`${URL}/?as=${encodeURIComponent(ME)}`);
  await page.getByText("LIVE · NIRNAYA").waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Workspace" }).click();
  await nav("Cases").waitFor();
  await page.keyboard.press("4");
  await page.getByRole("heading", { name: "Channels", exact: true }).waitFor();
  expect((await nav("Channels").getAttribute("aria-current")) === "true", "Channels is not the current view");
  expect((await nav("Channels").getAttribute("title")) === "Channels (4)", "the nav does not say key 4");
  for (const ch of ["email", "whatsapp", "voice", "hook"]) expect(/\boff\b/i.test(await card(ch).innerText()), `${ch} is not off`);
  if (!(await snapshot()).conversations.length) await page.getByText("No conversations yet").waitFor();
});

await step("Public address: one that is not https is refused; an https one is saved and every webhook uses it", async () => {
  const pub = page.getByRole("textbox", { name: "Public URL" });
  await pub.fill("ftp://nope.example");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await toast("The public URL starts with https://").waitFor();
  await pub.fill(PUBLIC + "/");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await toast("Public address saved").waitFor();
  const s = await snapshot();
  expect(s.config.public_url === PUBLIC, `saved ${s.config.public_url}`);
  expect(Object.entries(s.webhooks).every(([, v]) => v.startsWith(PUBLIC + "/")), JSON.stringify(s.webhooks));
});

await step("Email: Gmail, Yahoo and Zoho fill in their servers; a webhook forwarder swaps IMAP for a token; Brevo and Resend swap SMTP for an API key", async () => {
  await tab("Email").click();
  await page.getByRole("button", { name: "Gmail", exact: true }).click();
  expect(await f("IMAP server").inputValue() === "imap.gmail.com" && await f("SMTP port").inputValue() === "587" && await f("SMTP security").inputValue() === "starttls", "Gmail");
  await page.getByText("unsaved").waitFor();
  await page.getByRole("button", { name: "Yahoo", exact: true }).click();
  expect(await f("SMTP server").inputValue() === "smtp.mail.yahoo.com" && await f("SMTP port").inputValue() === "465" && await f("SMTP security").inputValue() === "ssl", "Yahoo");
  await page.getByRole("button", { name: "Zoho (India)", exact: true }).click();
  expect(await f("IMAP server").inputValue() === "imap.zoho.in" && await f("SMTP server").inputValue() === "smtp.zoho.in", "Zoho");
  await f("Receive mail").selectOption("webhook");
  await f("Inbound token").waitFor();
  expect(await f("IMAP server").count() === 0 && await f("Folder").count() === 0 && await f("Check every (seconds)").count() === 0, "IMAP fields still shown");
  await page.getByText("POST each email here").waitFor();
  expect((await page.getByText(`${PUBLIC}/api/channels/email/inbound?token=…`).count()) === 1, "the forwarder's address is not shown");
  await f("Send mail").selectOption("brevo");
  await f("API key").waitFor();
  expect(await f("SMTP server").count() === 0 && await f("Mailbox login").count() === 0 && await f("Mailbox password").count() === 0, "SMTP fields still shown");
  await f("Send mail").selectOption("resend");
  await f("API key").waitFor();
  await f("Receive mail").selectOption("imap");
  await f("Send mail").selectOption("smtp");
  await f("IMAP server").waitFor();
  expect(await f("API key").count() === 0 && await f("Inbound token").count() === 0, "API key or token still shown");
  for (const v of ["ssl", "none", "starttls"]) { await f("SMTP security").selectOption(v); expect(await f("SMTP security").inputValue() === v, v); }
  for (const v of ["anyone", "contacts"]) await f("Answer").selectOption(v);
});

await step("Email: set up on a real mail server and saved; the password is kept on the server and never shown again", async () => {
  await f("Support address").fill("support@nirnaya.test");
  await f("Name on emails").fill("Nirnaya Support");
  await f("Mailbox login").fill("support");
  await f("Mailbox password").fill("secret");
  await f("IMAP server").fill("127.0.0.1");
  await f("IMAP port").fill("3143");
  await f("Folder").fill("INBOX");
  await f("Check every (seconds)").fill("5");
  await f("SMTP server").fill("127.0.0.1");
  await f("SMTP port").fill("3025");
  await f("SMTP security").selectOption("none");
  await f("Answer").selectOption("contacts");
  await f("Forward escalations to").fill("boss@bank.test");
  await saveForm().click();
  await toast("Email saved").waitFor();
  await until(async () => (await page.getByText("unsaved").count()) === 0);
  expect(await f("Mailbox password").inputValue() === "", "the password is still in the field");
  expect((await f("Mailbox password").getAttribute("placeholder")).includes("saved"), "the field does not say a password is saved");
  const s = await snapshot();
  expect(s.config.email.password_set && s.config.email.password === "" && !JSON.stringify(s).includes('"secret"'), "the password came back from the server");
  expect(s.config.email.imap_port === 3143 && s.config.email.poll_seconds === 5 && s.config.email.smtp_security === "none", JSON.stringify(s.config.email));
});

await step("Email on: the card says on; Check inbox now connects (the first check only remembers where the mailbox is)", async () => {
  await f("Email on").check();
  await toast("Email saved").waitFor();
  await until(async () => /\b(on|working)\b/i.test(await card("email").innerText()));
  await page.getByRole("button", { name: "Check inbox now" }).click();
  await toast(/Connected: new mail from now on will be answered|new email\(s\) read/).waitFor();
  await until(async () => /working/i.test(await card("email").innerText()), 15000);
});

await step("Contacts: the demo customers' numbers are known already; a bad address is refused; two people linked, one removed; unknown senders saved", async () => {
  await page.getByRole("tab", { name: /Contacts/ }).click();
  if (!(await snapshot()).contacts.length) await page.getByTestId("contacts").getByText(/Aarav 9876543210, Meera 9123456780/).waitFor();
  await f("Email or phone").fill("hello");
  await page.getByRole("button", { name: "Link", exact: true }).click();
  await toast("give an email address, a mobile number with at least 10 digits, or a handle that starts with @").waitFor();
  for (const [addr, cid] of [[`aarav${tag}@customer.test`, "C-1001"], [`rohan${tag}@customer.test`, "C-1003"], ["+91 90000 12345", "C-1004"]]) {
    await f("Email or phone").fill(addr);
    await f("Customer").selectOption(cid);
    await page.getByRole("button", { name: "Link", exact: true }).click();
    await page.getByTestId("contacts").getByText(addr.startsWith("+") ? "9000012345" : addr, { exact: true }).waitFor();
  }
  await page.getByRole("button", { name: "Remove 9000012345" }).click();
  await until(async () => (await page.getByTestId("contacts").getByText("9000012345").count()) === 0);
  expect((await snapshot()).contacts.filter((c) => c.address.includes(tag)).length === 2 && !(await snapshot()).contacts.some((c) => c.address === "9000012345"), "not the two contacts");
  await f("Unknown senders").selectOption("C-1002");
  await toast("Saved").waitFor();
  expect((await snapshot()).config.unknown === "C-1002", "unknown senders not saved");
  await f("Unknown senders").selectOption("ask");
  await until(async () => (await snapshot()).config.unknown === "ask");
});

let emailCase;
await step("A real email from Aarav: the agent opens a case and answers in the same thread; the inbox shows both", async () => {
  const aarav = `aarav${tag}@customer.test`;
  sendMail(`Aarav Sharma <${aarav}>`, "support@nirnaya.test", `Payment failed ${tag}`, FAILED_UPI, `<q${tag}@customer.test>`);
  await tab("Email").click();
  await page.getByRole("button", { name: "Check inbox now" }).click();
  await toast(/new email\(s\) read/).waitFor();
  const reply = await until(() => mailbox(aarav).find((m) => m.subject === `Re: Payment failed ${tag}`), 60000, 1000);
  expect(reply.in_reply_to === `<q${tag}@customer.test>`, `In-Reply-To ${reply.in_reply_to}`);
  expect(reply.text.includes("2,450") && /Case NR-\d+ · reply to this email to continue/.test(reply.text) && reply.auto === "auto-replied", reply.text);
  emailCase = reply.text.match(/Case (NR-\d+)/)[1];
  expect((await api(`/api/cases/${emailCase}`)).channel === "email", "the case is not on email");
  await page.getByRole("tab", { name: /Inbox/ }).click();
  await page.locator(`[data-conv="email:${aarav}"]`).click();
  const thread = page.getByTestId("thread");
  await thread.getByText(FAILED_UPI).waitFor();
  await thread.getByText(/2,450/).nth(1).waitFor();
  await page.getByRole("button", { name: emailCase, exact: true }).waitFor();
});

await step("You answer Aarav yourself from the inbox: it arrives in his mailbox, in the thread, and shows who wrote it", async () => {
  const aarav = `aarav${tag}@customer.test`;
  const text = `I've also asked the bank to hurry up (${tag}).`;
  await f("Reply").fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByTestId("thread").getByText(text).waitFor();
  await page.getByTestId("thread").getByText(new RegExp(ME, "i")).first().waitFor();
  const m = await until(() => mailbox(aarav).find((x) => x.text.includes(text)), 30000, 1000);
  expect(m.subject === `Re: Payment failed ${tag}` && m.in_reply_to === `<q${tag}@customer.test>`, `${m.subject} / ${m.in_reply_to}`);
});

await step("WhatsApp: Meta's fields; WAHA swaps them and the address to paste; saved, switched on, the handshake answers", async () => {
  await tab("WhatsApp").click();
  expect(await f("Provider").inputValue() === "meta", "not Meta by default");
  await f("Phone number ID").fill("PNID-e2e");
  await f("Access token").fill("tok-e2e");
  await f("App secret").fill("shh-e2e");
  await f("Verify token").fill("vt-e2e");
  await f("Graph API version").fill("v23.0");
  await f("Answer").selectOption("contacts");
  await page.getByText("Callback URL (WhatsApp → Configuration → Webhook)").waitFor();
  expect(await page.getByText("vt-e2e", { exact: true }).count() === 1, "the verify token to paste does not follow the field");
  await f("Provider").selectOption("waha");
  for (const l of ["WAHA address", "WAHA session", "WAHA API key", "Webhook HMAC key"]) await f(l).waitFor();
  expect(await f("Phone number ID").count() === 0 && await f("Access token").count() === 0, "Meta fields still shown");
  await page.getByText("WHATSAPP_HOOK_URL for WAHA").waitFor();
  await page.getByText(`${PUBLIC}/api/channels/waha/webhook`).waitFor();
  await f("Provider").selectOption("meta");
  await saveForm().click();
  await toast("WhatsApp saved").waitFor();
  await api("/api/channels", { whatsapp: { graph_url: FAKE } }, "PUT"); // not in the form: where Meta's API is
  await f("WhatsApp on").check();
  await toast("WhatsApp saved").waitFor();
  const s = await snapshot();
  expect(s.config.whatsapp.enabled && s.config.whatsapp.token_set && s.config.whatsapp.app_secret_set && s.config.whatsapp.verify_token === "vt-e2e", "not saved");
  await page.getByRole("button", { name: "Copy Callback URL (WhatsApp → Configuration → Webhook)" }).click();
  await toast("Copied").waitFor();
  expect(await page.evaluate(() => navigator.clipboard.readText()) === `${PUBLIC}/api/channels/whatsapp/webhook`, "copied the wrong address");
  const ok = await fetchOnce(`${URL}/api/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=vt-e2e&hub.challenge=4242`);
  expect(ok.status === 200 && (await ok.text()) === "4242", "Meta's handshake failed");
  expect((await fetchOnce(`${URL}/api/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status === 403, "a wrong verify token passed");
});

await step("WhatsApp: Try it sends through the Graph API with the token; a number that is not one is refused", async () => {
  await f("Test recipient").fill("12345");
  await page.getByRole("button", { name: "Send a test" }).click();
  await toast("12345 is not a WhatsApp number").waitFor();
  const sentBefore = await outCount("whatsapp");
  await f("Test recipient").fill(AARAV_WA);
  await page.getByRole("button", { name: "Send a test" }).click();
  await toast(`Sent to ${AARAV_WA}`).waitFor();
  const m = waTexts().at(-1);
  expect(m.to === AARAV_WA && m.text === "Hello from Nirnaya: this is a test message." && m.path === "/v23.0/PNID-e2e/messages", JSON.stringify(m));
  expect(m.headers.authorization === "Bearer tok-e2e", "not sent with the access token");
  await until(async () => (await outCount("whatsapp")) === sentBefore + 1);
});

await step("Calls: Twilio's fields, every language, voice and choice; the address to paste; the call page; Try it places a call", async () => {
  await tab("Calls").click();
  await f("Account SID").fill("ACe2e");
  await f("Auth token").fill("authtok-e2e");
  await f("Twilio phone number").fill("+15550001111");
  for (const v of ["hi-IN", "en-IN", "both"]) { await f("Languages").selectOption(v); expect(await f("Languages").inputValue() === v, v); }
  for (const v of ["Polly.Aditi", "Polly.Kajal-Neural", "Polly.Joanna", "alice", "Polly.Raveena"]) await f("English voice").selectOption(v);
  for (const v of ["Polly.Kajal-Neural", "Polly.Aditi"]) await f("Hindi voice").selectOption(v);
  for (const v of ["false", "true"]) { await f("Record calls").selectOption(v); expect(await f("Record calls").inputValue() === v, v); }
  await f("Answer calls from").selectOption("contacts");
  await f("Answer calls from").selectOption("anyone");
  await saveForm().click();
  await toast("Phone saved").waitFor();
  await api("/api/channels", { voice: { api_url: FAKE } }, "PUT"); // not in the form: where Twilio's API is
  await page.getByText(`${PUBLIC}/api/channels/voice/twilio/incoming`).waitFor();
  expect((await page.getByRole("link").filter({ hasText: "Open the call page" }).getAttribute("href")) === "/call", "no link to the call page");
  await f("Phone on").check();
  await toast("Phone saved").waitFor();
  await f("Test recipient").fill("+919876543210");
  await page.getByRole("button", { name: "Call this number" }).click();
  await toast("Calling +919876543210…").waitFor();
  const c = to("/Calls.json").at(-1);
  expect(c.path === "/2010-04-01/Accounts/ACe2e/Calls.json" && c.body.To === "+919876543210" && c.body.From === "+15550001111", JSON.stringify(c.body));
  expect(c.body.Url.startsWith(`${PUBLIC}/api/channels/voice/twilio/outbound?c=voice`) && c.headers.authorization === "Basic " + Buffer.from("ACe2e:authtok-e2e").toString("base64"), c.body.Url);
  expect(c.body.Record === "true" && c.body.RecordingStatusCallback.startsWith(`${PUBLIC}/api/channels/voice/twilio/recording?c=voice`), "the call is not recorded");
});

await step("Webhooks: token and URL saved; a test event reaches n8n; a message from n8n gets the agent's answer back in the reply", async () => {
  await tab("Webhooks").click();
  await f("Token").fill("hook-e2e");
  await f("Send replies and case events to").fill(`${FAKE}/n8n/events`);
  await saveForm().click();
  await toast("Webhook saved").waitFor();
  await f("Webhook on").check();
  await toast("Webhook saved").waitFor();
  await page.getByText(/curl -X POST .*\/api\/channels\/hook/).waitFor();
  await page.getByRole("button", { name: "Send a test event" }).click();
  await toast("Test event delivered").waitFor();
  const t = to("/n8n/events").at(-1);
  expect(t.body.type === "test" && t.headers["x-nirnaya-token"] === "hook-e2e", JSON.stringify(t));
  const bad = await fetchOnce(`${URL}/api/channels/hook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Nirnaya-Token": "nope" }, body: JSON.stringify({ from: "x", text: "hi" }) });
  expect(bad.status === 403, "a wrong token was let in");
  const r = await (await fetchOnce(`${URL}/api/channels/hook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Nirnaya-Token": "hook-e2e" },
    body: JSON.stringify({ channel: "telegram", from: `@priya${tag}`, name: "Priya", text: "I'm C-1004. Where is my refund for the GadgetHub order?" }) })).json();
  expect(r.action === "case" && r.reply?.startsWith("Thank you, Priya. I've found your account.") && r.reply.length > 60, JSON.stringify(r));
  await until(() => to("/n8n/events").find((c) => c.body.type === "case.finished" && c.body.case_id === r.case_id && c.body.channel === "telegram"));
  await page.getByRole("tab", { name: /Inbox/ }).click();
  await page.locator(`[data-conv="hook:telegram:@priya${tag}"]`).waitFor();
});

// ── a flow that starts on a WhatsApp message, with every channel step ───────
const FLOW = `WhatsApp follow-up ${tag}`;
let flowId;
const side = () => page.locator('aside[aria-label="Settings"]');
const node = (id) => page.locator(`[data-node="${id}"]`);
const pal = (t) => page.locator(`[data-palette="${t}"]`);
const tool = (name) => page.locator(".fl-tools").getByRole("button", { name, exact: true });
await step("Flows: the Builder draws a flow that starts on a WhatsApp message and sends a WhatsApp, a webhook, an email and a call", async () => {
  await nav("Flows").click();
  await page.getByRole("tab", { name: "Builder" }).click();
  await page.getByTestId("canvas").waitFor();
  for (const t of ["email", "whatsapp", "call", "webhook"]) expect((await pal(t).innerText()).includes("Channels"), `${t} not in the palette`);
  await tool("New").click();
  await page.getByRole("textbox", { name: "Flow name" }).fill(FLOW);
  await node("start1").waitFor();
  await side().getByLabel("Starts").selectOption("message");
  expect(await side().getByLabel("When").count() === 0, "a schedule is still offered");
  for (const v of ["any", "email", "voice", "web", "hook", "whatsapp"]) await side().getByLabel("Messages from").selectOption(v);
  await side().getByLabel("Only if the message mentions").fill("charged twice");
  await until(async () => (await node("start1").innerText()).includes("on a message from WhatsApp with “charged twice”"));
  await pal("whatsapp").click(); await node("whatsapp1").waitFor();
  expect(await side().getByLabel("To").inputValue() === "{from}", "WhatsApp does not answer whoever wrote");
  await side().getByLabel("Message").fill("Follow-up from the flow for {name}: {result}");
  await pal("webhook").click(); await node("webhook1").waitFor();
  await side().getByLabel("URL").fill(`${FAKE}/n8n/flow`);
  await side().getByLabel("Text").fill("{name} wrote on {channel}: {text}");
  await until(async () => (await node("webhook1").innerText()).includes(`POST 127.0.0.1:${fake.address().port}`));
  await pal("email").click(); await node("email1").waitFor();
  await side().getByLabel("To").fill("not-an-address");
  await tool("Save").click();
  await page.locator(".fl-banner").filter({ hasText: "“not-an-address” is not an email address" }).waitFor();
  await page.locator(".fl-banner").getByRole("button", { name: "Dismiss" }).click();
  await side().getByLabel("To").fill("boss@bank.test");
  await side().getByLabel("Subject").fill(`WhatsApp case {case} · ${tag}`);
  await side().getByLabel("Message").fill("{name} ({from}) wrote: {text}\nResult: {result}");
  await pal("call").click(); await node("call1").waitFor();
  expect((await side().getByText("The agent says", { exact: true }).count()) === 1, "the call step does not say what the agent says");
  await side().getByLabel("Message").fill("Hello {name}, this is Nirnaya calling about case {case}.");
  for (const e of ["start1>whatsapp1", "whatsapp1>webhook1", "webhook1>email1", "email1>call1"]) expect(await page.locator(`[data-edge="${e}"]`).count() === 1, `no wire ${e}`);
  await tool("Save").click();
  await page.locator(".fl-tools").getByText(/^v1 · /).waitFor();
  const fl = (await api("/api/flows")).flows.find((x) => x.name === FLOW);
  flowId = fl.id;
  expect(fl.on === "message" && fl.when_desc === "on a WhatsApp message with “charged twice”" && fl.nodes.length === 5, `${fl.on} · ${fl.when_desc}`);
});

let waCase;
await step("A WhatsApp message from Meera's registered number: a case, the agent's answer through Meta, live in the inbox", async () => {
  const casesBefore = await api(`/api/channels/conversations/whatsapp:${MEERA_WA}`).then((c) => c.case_ids.length, () => 0);
  expect(await waIn(MEERA_WA, DUPLICATE, `wamid.in.${tag}`, "Meera") === 200, "the webhook refused the message");
  expect(await waIn(MEERA_WA, DUPLICATE, `wamid.in.${tag}`, "Meera") === 200, "a resend was refused");
  const answer = await until(() => waTexts().find((t) => t.to === MEERA_WA && /349/.test(t.text) && !t.text.startsWith("Follow-up")), 60000);
  expect(answer.headers.authorization === "Bearer tok-e2e", "not sent with the token");
  expect(to("/messages").some((c) => c.body.status === "read" && c.body.message_id === `wamid.in.${tag}`), "no blue ticks");
  const conv = await api(`/api/channels/conversations/whatsapp:${MEERA_WA}`);
  waCase = conv.case_ids.at(-1);
  expect(conv.case_ids.length === casesBefore + 1 && conv.customer_id === "C-1002", "the resend opened a second case, or Meera was not recognised");
  await nav("Channels").click();
  await page.getByRole("tab", { name: /Inbox/ }).click();
  await page.locator(`[data-conv="whatsapp:${MEERA_WA}"]`).click();
  await page.getByTestId("thread").getByText(DUPLICATE).last().waitFor(); // (on a used server, earlier runs' messages are above)
  await page.getByTestId("thread").getByText(/349/).last().waitFor();
});

await step("The flow ran by itself on that message: a follow-up WhatsApp, the n8n webhook, an email to the boss and a call to Meera", async () => {
  const follow = await until(() => waTexts().find((t) => t.to === MEERA_WA && t.text.startsWith("Follow-up from the flow for Meera:")), 60000);
  expect(follow.text.includes(waCase), follow.text);
  const hook = await until(() => to("/n8n/flow")[0]);
  expect(hook.body.text === `Meera wrote on whatsapp: ${DUPLICATE}` && hook.body.from === MEERA_WA && hook.body.case_id === waCase, JSON.stringify(hook.body));
  const m = await until(() => mailbox("boss", "secret").find((x) => x.subject === `WhatsApp case ${waCase} · ${tag}`), 30000, 1000);
  expect(m.text.includes(`Meera (${MEERA_WA}) wrote: ${DUPLICATE}`), m.text);
  const c = await until(() => to("/Calls.json").find((x) => x.body.To === "+" + MEERA_WA));
  expect(c.body.Url.includes("/api/channels/voice/twilio/outbound"), "the call has no script address");
  const run = await until(async () => (await api("/api/flows")).runs.find((r) => r.flow_id === flowId && r.state === "done"), 30000);
  expect(Object.values(run.nodes).every((n) => n.state === "done"), JSON.stringify(run.nodes));
  // a message without the words does not start it
  expect(await waIn(AARAV_WA, FAILED_UPI, `wamid.in2.${tag}`, "Aarav") === 200, "refused");
  await until(() => waTexts().find((t) => t.to === AARAV_WA && /2,450/.test(t.text)), 60000);
  await sleep(2500);
  expect((await api("/api/flows")).runs.filter((r) => r.flow_id === flowId).length === 1, "a message without “charged twice” started the flow");
});

await step("From the case: Forward by email (with a note) and Call the customer, and the case shows its WhatsApp messages", async () => {
  await page.getByRole("button", { name: waCase, exact: true }).click();
  await page.getByText(`On WhatsApp`).first().waitFor();
  await page.getByText(MEERA_WA).first().waitFor();
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await f("Forward to").fill("boss@bank.test");
  await f("Note").fill(`Please look at this one (${tag})`);
  await page.getByRole("button", { name: "Forward", exact: true }).last().click();
  await toast(`Forwarded ${waCase} to boss@bank.test`).waitFor();
  // "Fwd: case …", or "… needs approval" when the agents asked for a person (on a used server the demo bank
  // has refunded this charge before, so they do)
  const fw = await until(() => mailbox("boss", "secret").find((x) => x.subject.includes(waCase) && x.text.includes(`(${tag})`)), 30000, 1000);
  expect(fw.text.includes(`Note from ${ME}: Please look at this one (${tag})`) && fw.text.includes(DUPLICATE), fw.text);
  expect((await api(`/api/cases/${waCase}`)).trail.some((t) => t.kind === "case.forwarded"), "no trail entry");
  await page.getByRole("button", { name: "Call", exact: true }).click();
  expect(await f("Phone number").inputValue() === MEERA_WA, "the call does not default to the customer's number");
  await f("What to say").fill("Hello Meera, a quick follow-up on your refund.");
  const n = to("/Calls.json").length;
  await page.getByRole("button", { name: "Call now" }).click();
  await toast(`Calling ${MEERA_WA}…`).waitFor();
  expect(to("/Calls.json").length === n + 1 && to("/Calls.json").at(-1).body.To === "+" + MEERA_WA, "no call placed");
});

await step("An escalation by email goes to the boss by itself (the inbox is checked every 5 s); APPROVE by email resolves it", async () => {
  const rohan = `rohan${tag}@customer.test`;
  sendMail(`Rohan Verma <${rohan}>`, "support@nirnaya.test", `Fraud ${tag}`, UNAUTHORISED, `<f${tag}@customer.test>`);
  const fwd = await until(() => mailbox("boss", "secret").find((m) => m.subject.includes("needs approval") && m.text.includes(rohan)), 90000, 1500);
  const id = fwd.subject.match(/NR-\d+/)[0];
  expect(fwd.text.includes("Reply APPROVE or REJECT") && fwd.text.includes("18,500"), fwd.text);
  expect((await api(`/api/cases/${id}`)).pending, "the case is not waiting for approval");
  sendMail("Boss <boss@bank.test>", "support@nirnaya.test", `Re: ${fwd.subject}`, "APPROVE\n\nOn Thu, someone wrote:\n> Needs your approval", `<a${tag}@bank.test>`, { "In-Reply-To": fwd.id });
  await until(async () => (await api(`/api/cases/${id}`)).status === "resolved", 90000, 1500);
  const confirm = await until(() => mailbox("boss", "secret").find((m) => m.in_reply_to === `<a${tag}@bank.test>`), 30000, 1000);
  expect(confirm.text.startsWith(`Approved: ${id}`), confirm.text);
  // the customer hears the outcome in the same thread (on a fresh server: the ₹18,500 credit; on one where the
  // demo bank already credited that payment for earlier runs, what the agents could still do)
  const thread = await until(() => { const t = mailbox(rohan).filter((m) => m.subject === `Re: Fraud ${tag}`); return t.length >= 2 && t; }, 30000, 1000);
  expect(thread.every((m) => m.in_reply_to === `<f${tag}@customer.test>`), "the outcome is not in the customer's thread");
  expect((await api(`/api/cases/${id}`)).trail.some((t) => t.kind === "approval.granted" && t.actor.includes("(email)")), "the trail does not say it was approved by email");
});

// ── the call page ───────────────────────────────────────────────────────────
let call;
async function callPage(init, opts = {}) {
  const c = await browser.newContext({ viewport: { width: 420, height: 860 }, ...opts });
  await c.addInitScript(init);
  const p = await c.newPage();
  watch(p);
  await p.goto(`${URL}/call`);
  await p.getByTestId("call-setup").waitFor();
  return p;
}
const said = (p) => p.evaluate(() => window.__said);
const hear = (p, text) => p.evaluate((t) => window.__script.push(t), text);
const line = (p, who, text) => p.locator(`[data-who="${who}"]`, { hasText: text }).first();

await step("Call page: Aarav talks; it answers out loud, opens a case on the voice channel, and hangs up on “No, that's all”", async () => {
  call = await callPage(SPEECH);
  page = call;
  expect(await call.title() === "Talk to Nirnaya", "title");
  await until(async () => (await call.getByLabel("Who is calling").locator("option").count()) === 5); // four customers and someone new
  expect(await call.getByLabel("Who is calling").inputValue() === "C-1001", "not Aarav first");
  expect(await call.getByLabel("Language").locator("option").count() === 4, "not four languages");
  await hear(call, FAILED_UPI);
  await call.getByRole("button", { name: "Start the call" }).click();
  await line(call, "nirnaya", "Hello Aarav, this is Nirnaya").waitFor();
  await line(call, "you", "FreshMart").waitFor({ timeout: 20000 });
  const ans = line(call, "nirnaya", "2,450");
  await ans.waitFor({ timeout: 60000 });
  const id = (await ans.innerText()).match(/case (NR-\d+)/)?.[1];
  expect(id, "the answer does not name its case");
  await until(async () => (await said(call)).some((s) => s.text.includes("2,450") && s.lang === "en-IN"));
  expect((await said(call))[0].text.startsWith("Hello Aarav"), "the greeting was not said");
  expect((await call.evaluate(() => window.__srLang)).every((l) => l === "en-IN"), "it did not listen in English (India)");
  const c = await api(`/api/cases/${id}`);
  expect(c.channel === "voice" && c.customer_id === "C-1001" && c.opened_by.startsWith("Web call"), `${c.channel} ${c.customer_id} ${c.opened_by}`);
  await call.getByTestId("call-status").getByText("Listening…").waitFor({ timeout: 20000 });
  await hear(call, "No, that's all.");
  await call.getByText("The call has ended.").waitFor({ timeout: 30000 });
  await line(call, "nirnaya", "Goodbye").waitFor();
  await call.getByText("The last call has ended. Start another any time.").waitFor();
  const conv = (await api("/api/channels/conversations")).find((x) => x.channel === "web" && x.case_ids.includes(id));
  expect(conv && conv.ended, "the server does not know the call ended");
});

await step("Call page: someone new in Hindi says who they are by spelling their ID; mute stops listening, typing still works", async () => {
  await call.getByLabel("Who is calling").selectOption("");
  await call.getByLabel("Language").selectOption("hi-IN");
  await call.evaluate(() => { window.__srLang = []; window.__said = []; });
  await hear(call, DUPLICATE);
  await call.getByRole("button", { name: "Start the call" }).click();
  await line(call, "nirnaya", "नमस्ते, मैं निर्णय हूँ").waitFor();                     // a Hindi call is answered in Hindi
  await line(call, "nirnaya", "रजिस्टर्ड मोबाइल नंबर").waitFor({ timeout: 20000 });
  await hear(call, "my customer ID is C 1 0 0 2");
  const a = line(call, "nirnaya", "धन्यवाद Meera जी, आपका अकाउंट मिल गया है।");
  await a.waitFor({ timeout: 60000 });
  expect((await a.innerText()).includes("349"), "the answer is not about the first thing she said");
  expect((await call.evaluate(() => window.__srLang)).every((l) => l === "hi-IN") && (await said(call)).every((s) => s.lang === "hi-IN"), "not Hindi");
  await call.getByTestId("call-status").getByText("Listening…").waitFor({ timeout: 20000 });
  await call.getByRole("button", { name: "Mute" }).click();
  await call.getByTestId("call-status").getByText("Type your message").waitFor();
  expect(!(await call.evaluate(() => window.__listening)), "still listening while muted");
  await call.getByLabel("Type a message").fill("thank you");
  await call.getByRole("button", { name: "Send", exact: true }).click();
  await line(call, "nirnaya", "आपका स्वागत है").waitFor({ timeout: 20000 });
  await call.getByTestId("call-status").getByText("Type your message").waitFor();
  await call.getByRole("button", { name: "Unmute" }).click();
  await call.getByTestId("call-status").getByText("Listening…").waitFor();
  await call.getByRole("button", { name: "End call" }).click();
  await call.getByText("You ended the call.").waitFor();
  await call.getByTestId("call-setup").waitFor();
  await call.context().close();
});

await step("Call page in a browser that cannot listen: it is a chat (Priya types, the case is a chat case)", async () => {
  call = await callPage(NO_SPEECH);
  page = call;
  await call.getByText("This browser can't listen").waitFor();
  await call.getByLabel("Who is calling").selectOption("C-1004");
  await call.getByRole("button", { name: "Start the chat" }).click();
  await line(call, "nirnaya", "Hello Priya").waitFor();
  await call.getByTestId("call-status").getByText("Type your message").waitFor();
  expect(await call.getByRole("button", { name: "Mute" }).count() === 0, "a mute button without a microphone");
  await call.getByLabel("Type a message").fill("Where is my refund for the GadgetHub order?");
  await call.getByLabel("Type a message").press("Enter");
  const a = call.locator('[data-who="nirnaya"]').filter({ hasText: /case NR-\d+/ }).first();
  await a.waitFor({ timeout: 60000 });
  const id = (await a.innerText()).match(/case (NR-\d+)/)[1];
  expect((await api(`/api/cases/${id}`)).channel === "chat", "a typed call page case is not a chat case");
  await call.getByRole("button", { name: "End call" }).click();
  await call.context().close();
});

await step("Call page with the microphone blocked: it says so and carries on as a chat", async () => {
  call = await callPage(`sessionStorage.setItem("e2e.mic", "blocked");` + SPEECH);
  page = call;
  await call.getByRole("button", { name: "Start the call" }).click();
  await call.getByRole("alert").filter({ hasText: "The microphone is blocked, so this is a chat now" }).waitFor({ timeout: 20000 });
  await call.getByTestId("call-status").getByText("Type your message").waitFor();
  expect(await call.getByRole("button", { name: "Mute" }).count() === 0, "a mute button with the microphone blocked");
  await call.getByLabel("Type a message").fill("bye");
  await call.getByRole("button", { name: "Send", exact: true }).click();
  await call.getByText("The call has ended.").waitFor({ timeout: 20000 });
  await call.context().close();
});

await step("Call page recording: with a microphone it records the call (● REC), sends it when the call ends, and the report plays it", async () => {
  const b2 = await chromium.launch({ channel: "chromium", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  try {
    const c = await b2.newContext({ viewport: { width: 420, height: 860 }, permissions: ["microphone"] });
    await c.addInitScript(NO_SPEECH);
    const p = await c.newPage();
    watch(p);
    await p.goto(`${URL}/call`);
    await p.getByTestId("call-setup").waitFor();
    await p.getByLabel("Who is calling").selectOption("C-1002");
    expect(await p.getByLabel("Record this call").isChecked(), "recording is not on by default");
    await p.getByRole("button", { name: "Start the chat" }).click();
    await p.getByTestId("call-recording").waitFor({ timeout: 15000 });
    await p.getByLabel("Type a message").fill(DUPLICATE);
    await p.getByRole("button", { name: "Send", exact: true }).click();
    await line(p, "nirnaya", "349").waitFor({ timeout: 30000 });
    await p.waitForTimeout(1500);                                  // a little audio on the tape
    await p.getByRole("button", { name: "End call" }).click();
    await p.getByText("You ended the call.").waitFor();
    const rep = await until(async () => (await api("/api/channels/call-reports")).find((r) => r.channel === "call page" && r.recording === "kept" && r.customer?.id === "C-1002"), 15000);
    const audio = await fetch(`${URL}/api/channels/call-reports/${encodeURIComponent(rep.id)}/audio`);
    expect(audio.status === 200 && /audio\//.test(audio.headers.get("content-type")) && (await audio.arrayBuffer()).byteLength > 500, `audio ${audio.status}`);
  } finally { await b2.close(); }
});

await step("Call reports: the Hindi call is there with what was said both ways, its case, and a report to download", async () => {
  page = ws;
  await page.bringToFront();
  await nav("Channels").click();
  await tab("Call reports").click();
  const reps = await api("/api/channels/call-reports");
  const hindi = reps.find((r) => r.channel === "call page" && r.langs.includes("hi") && r.cases.length);
  expect(hindi, JSON.stringify(reps.slice(0, 3)));
  await page.getByTestId("call-reports").locator(`[data-call="${hindi.id}"]`).click();
  await page.getByTestId("call-summary").filter({ hasText: "Spoke" }).waitFor();
  await page.getByTestId("call-transcript").getByText("आपका स्वागत है").first().waitFor();
  await page.getByTestId("call-report").getByText(hindi.cases[0], { exact: true }).waitFor();
  const href = await page.getByRole("link").filter({ hasText: "Download report" }).getAttribute("href");
  const html = await (await fetch(new globalThis.URL(href, URL))).text();
  expect(html.includes("Call report") && html.includes(hindi.cases[0]) && html.includes("आपका स्वागत है"), "the downloaded report is not the call's");
});

// ── a server with an access key ─────────────────────────────────────────────
if (KEYED_URL) {
  await step("A server with an access key: the lock screen refuses a wrong key, opens with the right one and remembers it; the call page needs none", async () => {
    const c = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    page = await c.newPage();
    watch(page);
    await page.goto(KEYED_URL);
    await page.getByRole("dialog", { name: "Access key" }).getByText("This Nirnaya server is locked").waitFor({ timeout: 20000 });
    expect((await fetch(`${KEYED_URL}/api/state`)).status === 401, "the API is not locked");
    await page.getByRole("dialog").getByLabel("Access key").fill("wrong");
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.getByText("That key is not right.").waitFor();
    await page.getByRole("dialog").getByLabel("Access key").fill("e2e-key");
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.getByText("LIVE · NIRNAYA").waitFor({ timeout: 20000 });
    await page.reload();
    await page.getByText("LIVE · NIRNAYA").waitFor({ timeout: 20000 });
    expect(await page.getByRole("dialog", { name: "Access key" }).count() === 0, "the key was not remembered");
    const p2 = await c.newPage();
    await p2.goto(`${KEYED_URL}/call`);
    await until(async () => (await p2.getByLabel("Who is calling").locator("option").count()) === 5);
    expect((await p2.getByLabel("Who is calling").inputValue()) === "C-1001", "the call page did not load its customers");
    await c.close();
  });
}

// ── leave the server as it was ──────────────────────────────────────────────
await api("/api/channels", { public_url: "", unknown: "ask", email: { enabled: false }, whatsapp: { enabled: false }, voice: { enabled: false }, hook: { enabled: false } }, "PUT").catch(() => {});
for (const c of (await snapshot().catch(() => ({ contacts: [] }))).contacts) await api(`/api/channels/contacts?address=${encodeURIComponent(c.address)}`, undefined, "DELETE").catch(() => {});
if (flowId) await api(`/api/flows/${flowId}?by=e2e`, undefined, "DELETE").catch(() => {});

await browser.close();
fake.close();
if (errors.length) { console.log(`  ✗ page errors:\n      ${[...new Set(errors)].slice(0, 8).join("\n      ")}`); results.push(false); }
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
