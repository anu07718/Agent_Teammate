# Channels: real email, WhatsApp and phone calls, on free tiers

Nirnaya's agents answer real customers. An email, a WhatsApp message, a phone call, a talk on the call
page or a message from n8n becomes a case. The case goes through the same ten steps as any other, and
the reply goes back the way it came: in the same email thread, on WhatsApp, or spoken on the call.
When a case needs a person, it can be forwarded by email, and the supervisor approves it by replying
**APPROVE**.

Everything here is in the app under **Channels** (the speech-bubble icon, key **4**, or **M** in the
office). Each field says where to find its value. Secrets are never shown again after you save them.

You can set up one channel or all of them. Email by IMAP and the call page work without a public address,
so start there.

## What is free (checked 1 October 2026)

| For | Use | Free part | Limits |
|---|---|---|---|
| Email | Your Gmail (or any mailbox) over IMAP + SMTP | Free | Gmail sends to about 500 recipients a day; it needs an app password |
| Email by API | Brevo | Free plan, no end date | 300 emails a day |
| Email by API | Resend | Free plan | 3,000 a month, 100 a day |
| WhatsApp | Meta WhatsApp Cloud API with Meta's test number | The app, the test number and the API are free; replies inside the 24-hour window are free | The test number sends to up to 5 numbers you add. From 1 October 2026 respond.io reports that only the first 1,000 of those replies a month per number are free; check Meta's pricing page |
| WhatsApp | WAHA Core, self-hosted in Docker | Free (Apache-2.0) | Not an official API: it drives WhatsApp Web, so WhatsApp can ban the number. Use a spare number |
| Phone calls | Twilio trial | 75 call minutes | **A trial, not a free tier**: it ends when the credit is used. Calls only numbers you verify (up to 5), only in the country you signed up in. The call page (`/call`, below) is the free way, for good |
| Talking in the browser | The call page, `/call` | Free, no phone line | Chrome, Edge or Safari for voice; elsewhere it is a chat |
| A public address | Cloudflare quick tunnel (`cloudflared`) | Free, no account | The address changes each time you start it |
| Automation | n8n, self-hosted | Free | Runs on your computer or server |

SendGrid's free plan ended in July 2025, so it is not offered. Render's free plan blocks SMTP (since
26 September 2025) and Hugging Face Spaces block SMTP and IMAP: on those, send with Brevo or Resend and
receive email by webhook.

## Before you start

1. Start Nirnaya: `make run`, then open http://127.0.0.1:8000.
2. **A public address** (only for WhatsApp and Twilio, which call your server). On your computer:
   ```bash
   cloudflared tunnel --url http://localhost:8000
   ```
   ([download cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
   It prints an address like `https://quiet-river-1234.trycloudflare.com`. Paste it into
   **Channels → Public address** and press **Save**. Every webhook address on the page now uses it.
   The address changes when you restart cloudflared. For one that stays the same, use a named tunnel on
   a free Cloudflare account with your own domain.
3. **Lock the server** before anything points at it from the internet: start it with
   `NIRNAYA_ACCESS_KEY=<a long random text> make run`. The app asks for the key once in each browser.
   Provider webhooks and the call page stay open, because each checks its own signature or token.
4. **Contacts.** By default email and WhatsApp answer only contacts, so a personal inbox never answers
   newsletters or strangers. The demo bank has four customers. Under **Channels → Contacts**, link your
   own email address and phone number to one of them (say Aarav, C-1001) to try the agents on his
   payments. The demo customers' registered numbers are known already. On a channel set to answer anyone,
   a stranger is asked for their customer ID or registered mobile; once they give it, they are added to
   Contacts automatically.

## 1. Email with Gmail (about 5 minutes)

1. In your Google account, turn on **2-Step Verification**, then open **Security → App passwords**,
   create one called "Nirnaya" and copy the 16 letters.
2. In Nirnaya: **Channels → Email**, press **Gmail** next to "Fill in for" (it fills the servers and ports).
3. Fill in **Support address** and **Mailbox login** (your Gmail address) and **Mailbox password** (the app
   password, not your normal password). Optionally fill **Forward escalations to** with the address of the
   person who approves cases.
4. Press **Save**, then tick **Answer Email**. Press **Check inbox now**. The first check only remembers
   where your mailbox is, so old mail gets no replies.
5. From another address that you linked under Contacts, send:
   *My UPI payment of ₹2,450 to FreshMart failed 3 days ago but the money was debited from my account*.
   Within about 20 seconds (the inbox is checked every 20 s; set **Check every (seconds)** lower if you
   like) the answer arrives **in the same thread**, with the case number at the bottom. The conversation
   is in **Channels → Inbox**, and the case is in **Cases**.
6. Write back in the thread, for example "thanks!". The agent answers without opening a new case. Ask
   "any update?" while a case waits, and it tells you where the case is.

**Escalations by email.** Send *There is a transaction of ₹18,500 at QuickPay Store that was not done
by me, please help*. The agents block the UPI ID straight away and park the credit for a person. The
**Forward escalations to** address gets the sealed summary. A reply that starts with **APPROVE** completes
the case, and the customer is told. A reply that starts with **REJECT** and a reason closes it. Nirnaya
confirms either one by email. Any case can also be forwarded by hand: open it in **Cases** and press
**Forward**.

Other mailboxes: **Yahoo** and **Zoho (India)** fill themselves in too. Any IMAP/SMTP mailbox works with
its server names.

### Email through Brevo or Resend instead

Use this where SMTP is blocked (Render's and Hugging Face's free plans).
- **Brevo:** create a free account, verify your sender address (Senders & IP), create a key under
  **SMTP & API → API keys**. In Nirnaya set **Send mail** to *Brevo API* and paste it into **API key**.
- **Resend:** create a free account, verify a domain, create an API key. Set **Send mail** to
  *Resend API*. The support address must be on the verified domain.

**Receiving without IMAP.** Set **Receive mail** to *A forwarder POSTs each email here*, type a long
random **Inbound token** and save. The box on the right shows the address to POST to. Anything that can
POST JSON works: `{"from": "...", "subject": "...", "text": "..."}`, or the whole message as `{"raw": "..."}`.
With your domain on Cloudflare (free), Email Routing can send every email to a Worker like this:
```js
export default {
  async email(message) {
    const raw = await new Response(message.raw).text();
    await fetch("https://YOUR-NIRNAYA/api/channels/email/inbound?token=YOUR_TOKEN", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw }),
    });
  },
};
```

## 2. WhatsApp with Meta's free test number (about 15 minutes)

1. Go to [developers.facebook.com](https://developers.facebook.com/) → **My Apps → Create app**, and pick
   the WhatsApp use case. Meta makes a test WhatsApp Business account with a test phone number.
2. **WhatsApp → API Setup:** copy the **Phone number ID**. Press **Generate access token** (it lasts 24
   hours). Under **To**, add your own mobile number and enter the code WhatsApp sends you. You can add up
   to 5.
3. **App settings → Basic:** show and copy the **App secret**.
4. In Nirnaya: **Channels → WhatsApp**. Keep **Provider** on *Meta*, paste the phone number ID, the access
   token and the app secret, and type any word as **Verify token**. Press **Save**, then tick
   **Answer WhatsApp**.
5. Back in Meta: **WhatsApp → Configuration → Webhook → Edit**. Paste the **Callback URL** shown in
   Nirnaya (`https://…/api/channels/whatsapp/webhook`; there is a copy button) and the same verify token,
   then **Verify and save**. Under **Webhook fields**, subscribe to **messages**.
6. Write first: in Nirnaya's **Try it** box, put your number (country code, no +, like `919876543210`)
   and the message `template:hello_world`, then **Send a test**. You get Meta's "Hello World". Meta allows
   free-form messages only within 24 hours of the customer's last message; before that, only an
   approved template can be sent.
7. Reply from your phone, for example *I was charged twice for ₹349 at CafeBrew yesterday*. The agent
   answers on WhatsApp in a few seconds. Your message gets blue ticks once it is read, and the
   conversation shows in **Channels → Inbox** with each reply's status (sent, delivered, read).

**A token that does not expire:** Meta Business settings → **Users → System users** → add one with the
Admin role, give it the app, and generate a token with `whatsapp_business_messaging` and
`whatsapp_business_management`. Paste it over the 24-hour one.
**Your own number:** add it under API Setup when you are ready (it cannot also be on the WhatsApp app).
Meta's limits on new numbers rise as you verify the business.

Errors you may see, in plain words: *not on the test number's allowed list* (add the number under API
Setup → To), *only within 24 hours* (send `template:hello_world` first).

### WhatsApp through WAHA (your own number, self-hosted)

WAHA links a WhatsApp number to a small server by QR code, the way WhatsApp Web does. It is free, but it
is not an official API: WhatsApp may ban a number that looks like a bot. Use a spare number.
```bash
docker run -it --rm -p 3000:3000 --add-host=host.docker.internal:host-gateway \
  -e WHATSAPP_HOOK_URL=http://host.docker.internal:8000/api/channels/waha/webhook \
  -e WHATSAPP_HOOK_EVENTS=message \
  -e WHATSAPP_HOOK_HMAC_KEY=<a long random text> \
  devlikeapro/waha
```
Open http://localhost:3000/dashboard, start the `default` session and scan the QR code with the phone
(WhatsApp → Linked devices). In Nirnaya set **Provider** to *WAHA*, **WAHA address** to
`http://localhost:3000`, **WAHA session** to `default`, the same **Webhook HMAC key**, and the
**WAHA API key** if you started WAHA with `WAHA_API_KEY`. Save and tick **Answer WhatsApp**. Without an
HMAC key, Nirnaya accepts WAHA's calls only from your own machine or local network.

## 3. Phone calls with Twilio, step by step (about 15 minutes)

The agent answers your Twilio number, talks in **English or Hindi**, opens cases, and calls customers back.
Every call can be **recorded** and gets a **report** (what was said both ways, the cases, the recording).

**A. Twilio (free trial)**
1. Sign up at [twilio.com/try-twilio](https://www.twilio.com/try-twilio) and verify your email and mobile.
   The trial includes 75 call minutes; trial calls last at most 10 minutes.
2. **Get a number:** Console → Phone Numbers → Manage → **Buy a number** (paid from the trial credit; a US
   number is fine). Note it in the +1… form.
3. **Verify the phones you will use:** Console → Phone Numbers → Manage → **Verified Caller IDs** → Add.
   A trial account only calls verified numbers (up to 5, in the country you signed up in).
4. **Copy the keys:** Console home → Account info: **Account SID** (AC…) and **Auth Token** (click to show).

**B. A public address for Nirnaya** (Twilio calls your server)
5. On your computer: `cloudflared tunnel --url http://localhost:8000` prints an `https://….trycloudflare.com`
   address (free, no account). In Nirnaya: **Channels → Public address**, paste it, **Save**.

**C. Nirnaya**
6. **Channels → Calls**: paste the **Account SID**, **Auth token** and **Twilio phone number**.
   - **Languages:** *English and Hindi* (the caller hears "for Hindi, press 2", or simply speaks Hindi),
     *English only*, or *Hindi first*.
   - **English voice:** Raveena or Kajal (Indian English). **Hindi voice:** Aditi (speaks Hindi and Hinglish)
     or Kajal.
   - **Record calls:** on by default. The caller is told the call is recorded.
   - **Save**, then tick **Answer phone calls**.
7. Under the form, Nirnaya shows two addresses. In Twilio, open your number (Phone Numbers → Manage → Active
   numbers → the number) and under **Voice Configuration**:
   - **A call comes in:** Webhook, the first address (`…/api/channels/voice/twilio/incoming`), **HTTP POST**.
   - **Call status changes:** the second address (`…/api/channels/voice/twilio/status`), **HTTP POST**.
   - **Save configuration**.

**D. Test it**
8. **The agent calls you** (the cheapest way from India): **Channels → Calls → Try it**, type your verified
   number, press **Call this number**. Answer, listen to the opening, then say what went wrong, e.g. *"My
   UPI payment of 2,450 rupees to FreshMart failed but the money was debited"*. Or in Hindi: *"मेरा 2450
   रुपये का पेमेंट फेल हो गया लेकिन पैसा कट गया"*. Press **2** first to switch to Hindi, or just speak it.
   Say *"no, that's all"* (or *"नहीं धन्यवाद"*) to finish.
9. **You call the agent:** ring the Twilio number from a verified phone. A contact is greeted by name;
   anyone else is asked for their registered mobile number or customer ID.
10. **The report:** **Channels → Call reports**. Each call shows a summary, the transcript (the caller's own
    words, with the English the agents read), its cases and how they ended, the recording (a player) and
    **Download report** (a page to keep or print). A recording arrives a few seconds after the call ends.

**What to know**
- **Recording on a trial:** Twilio records calls *you place* (step 8), but a trial cannot record *incoming*
  calls; the report says "Not recorded" with Twilio's reason. Upgrading the account lifts this (about
  $0.0025 a minute to record, plus storage). Recordings are downloaded into `data/recordings/` next to the
  database and are kept there; delete them in the Twilio Console if you do not want Twilio's copy.
- **Hindi:** Twilio's Hindi recogniser writes Devanagari. With a free model on (Settings), it is translated
  into English for the agents and their answer back into Hindi, with every number checked; without one, a
  banking glossary turns it into Hinglish the agents read, and the Hinglish answer is spoken by the
  bilingual voice. Trial calls begin with a short notice from Twilio.
- Any case can call its customer from **Cases → Call**, and a flow can too (the **Phone call** step).
- In India, tell callers a call is recorded (Nirnaya does, in their language) and keep recordings only as
  long as you need them.

## 4. The call page: talk to the agent in a browser (free)

Open `https://<your-server>/call` (or `http://127.0.0.1:8000/call` on your computer), pick who is calling
and the language (**हिन्दी / Hinglish** makes the agent listen and answer in Hindi), press **Start the call**
and allow the microphone. Talk as on a phone; the agent
answers out loud and opens cases like a call would. **Mute** lets you type instead, and **End** hangs up.
It works on a phone or a computer, in Chrome, Edge or Safari. Chrome's speech recognition uses Google's
speech service, so it needs the internet. In Firefox, or with the microphone blocked, the page is a chat.
Send the link to customers: they need no account and no phone line. Each call-page call gets a report
under **Channels → Call reports** too (the transcript and its cases; the browser does not record audio).

## 5. n8n, Telegram, Instagram and anything else (webhooks)

Run n8n for free on your computer: `npx n8n`, or
`docker run -it --rm -p 5678:5678 -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n`.

In Nirnaya: **Channels → Webhooks**. Type a long random **Token**, press **Save**, and tick **Accept
webhooks**. Optionally set **Send replies and case events to** (an n8n Webhook node's URL): it gets every
reply and a `case.finished` event when a case from a webhook ends.

**A message in, the agent's answer back** (for example Telegram): in n8n, a *Telegram Trigger* node, then
an *HTTP Request* node that POSTs to `https://<your-nirnaya>/api/channels/hook` with the header
`X-Nirnaya-Token: <token>` and this JSON body:
```json
{ "channel": "telegram", "from": "tg:{{ $json.message.chat.id }}", "name": "{{ $json.message.from.first_name }}",
  "text": "{{ $json.message.text }}" }
```
(The `tg:` in front keeps a numeric chat id from looking like a phone number, so someone who says who
they are is remembered by it.)
The answer comes back in the same request as `{"action", "reply", "case_id", "status", "route"}`. Then
add a *Telegram → Send Message* node with the text `{{ $json.reply }}`. With `"wait": false` the request
returns at once, and the reply is POSTed to your reply URL instead. Instagram DMs, Slack, forms and any
other channel n8n can read work the same way. Instagram needs its own Meta app and a Business or Creator
account. The same applies to Telegram's bot token.

**From Nirnaya to n8n:** a flow's **Call a webhook** step POSTs the run (case, route, result, who wrote
and what they said) to any URL.

### The agents' outreach through n8n (pay, ask, message, call)

When you tell the agents "pay ₹500 to anushka@example.com" or "ask Rahul 98765 43210 for ₹1,200 on
WhatsApp", Nirnaya decides everything (who, how much, whether a person must approve) and sends the message
itself if that channel is set up here. Otherwise it POSTs the finished message to n8n, which delivers it
with Gmail, WhatsApp Business or Twilio and answers whether it worked. **Channels → Webhooks → Agents'
outreach goes through n8n**: *for channels not set up here* (default), *always*, or *never*.

The workflow: **Webhook** (`POST /webhook/nirnaya-outreach`, responds with a node) → **Settings (edit
me)** (the shared token, your WhatsApp phone number ID, your Twilio number, the sender name) → **Read the
task** → **Token matches?** (no: `401 {"ok": false, "error": "bad token"}`) → **Dry run?** (yes: it answers
which channels are ready and sends nothing) → **Which channel?** → *Send the email* (Gmail) / *Send the
WhatsApp* / *Place the call* (Twilio) / *Send the SMS* (Twilio) → **Sent** or **Not sent** → **Tell
Nirnaya** `{"ok", "channel", "id", "error"}`. A channel whose settings are empty answers "not set up"; a
send node that is switched off can never be reported as sent (Sent needs the provider's message id).

What Nirnaya sends (`X-Nirnaya-Token` header = Channels → Webhooks → Token):
```json
{ "event": "outreach.send", "dry_run": false, "op_id": "OP-1042", "channel": "email",
  "to": { "name": "Anushka", "email": "anushka@example.com", "phone": "+919876543210" },
  "subject": "Payment request: ₹1,200 from Karthik", "text": "Hi Anushka, Karthik has asked you for ₹1,200 …",
  "lang": "en", "money": { "kind": "request", "amount": 1200, "currency": "INR", "link": "https://rzp.io/…", "test_mode": true },
  "from": { "name": "Karthik", "by": "Karthik" } }
```

To set it up in your n8n: open the workflow, put the same token in **Settings (edit me)** and in Nirnaya
(Channels → Webhooks → Token), connect **Gmail** in *Send the email* (Sign in with Google) and switch that
node on, then **Publish**. WhatsApp and Twilio are optional: connect their credentials, fill in the phone
number ID or the Twilio number in Settings, switch the node on and publish again. Put the workflow's
production URL in Nirnaya → Channels → Webhooks → **Agents' outreach URL (n8n)** (its own field, so replies and
case events from webhook channels never reach it), and press **Test n8n** in Settings → Outreach: it sends a
dry run. The workflow's webhook only runs for `"event": "outreach.send"`; anything else is answered without
using an execution.

WhatsApp's rule still applies through n8n: a business can only send free text to someone who messaged it
in the last 24 hours; anyone else needs an approved template.

## 6. Flows that answer on the channels

In **Flows → Builder**, set the **Start** to *when a message arrives*, pick the channel and, if you like,
words the message must mention. The flow runs after the agents have handled the message. Four steps use
the channels:
- **Send email**
- **Send WhatsApp**
- **Phone call** (the agent says your text, then talks with them)
- **Call a webhook**

`{from}` is whoever wrote in, so *To: {from}* answers them. `{name}`, `{text}`, `{case}`, `{result}`,
`{route}` and `{status}` fill in from the run. A step whose channel is switched off fails on its node and
says why.

Example: Start *when a message arrives* from WhatsApp mentioning "charged twice", then **Send WhatsApp**
to `{from}` with "Follow-up from the flow for {name}: {result}", then **Send email** to the supervisor.

## 7. Putting Nirnaya on the internet for free

- **Your computer and a Cloudflare tunnel.** This is the simplest: everything works, including Gmail by
  IMAP/SMTP. It is online while the computer is on.
- **Hugging Face Spaces** (free CPU: 2 vCPU, 16 GB). Make a Docker Space from this repository; the
  `Dockerfile` builds everything. Add `sdk: docker` and `app_port: 8000` to the Space's README front
  matter. In the Space's settings, add the channel settings as variables and secrets (below), set
  `NIRNAYA_ACCESS_KEY`, and set `NIRNAYA_DB=/tmp/nirnaya.db`: a free Space has no persistent disk, so its
  cases are lost when it restarts. Spaces block SMTP and IMAP, so send with Brevo or Resend and receive
  email by webhook. A free Space sleeps when nobody uses it. (Not tried on a real Space from here.)
- **Render**'s free plan blocks SMTP and sleeps when idle; the same email rule applies.

Docker anywhere: `docker build -t nirnaya . && docker run -p 8000:8000 -v nirnaya:/data -e NIRNAYA_ACCESS_KEY=... nirnaya`.

### Settings from the environment

Any field can be set with `NIRNAYA_<CHANNEL>_<FIELD>`, which is handy on a host. The app then shows that
field as set by the server and locks it. Examples:

```bash
NIRNAYA_PUBLIC_URL=https://nirnaya.example.com
NIRNAYA_EMAIL_ENABLED=true  NIRNAYA_EMAIL_ADDRESS=support@example.com  NIRNAYA_EMAIL_USERNAME=support@example.com
NIRNAYA_EMAIL_PASSWORD=<app password>  NIRNAYA_EMAIL_SEND=brevo  NIRNAYA_EMAIL_API_KEY=<brevo key>
NIRNAYA_EMAIL_FORWARD_TO=supervisor@example.com
NIRNAYA_WHATSAPP_ENABLED=true  NIRNAYA_WHATSAPP_PHONE_NUMBER_ID=...  NIRNAYA_WHATSAPP_TOKEN=...  NIRNAYA_WHATSAPP_APP_SECRET=...
NIRNAYA_VOICE_ENABLED=true  NIRNAYA_VOICE_ACCOUNT_SID=AC...  NIRNAYA_VOICE_AUTH_TOKEN=...  NIRNAYA_VOICE_FROM_NUMBER=+1...
NIRNAYA_HOOK_ENABLED=true  NIRNAYA_HOOK_TOKEN=...
NIRNAYA_UNKNOWN=ask          # or a demo customer id, to treat strangers as that customer
NIRNAYA_ACCESS_KEY=...       # locks the app and the API
```

## How it keeps you safe

- **Signatures.** Each provider's webhook is checked the provider's own way:
  - Meta: `X-Hub-Signature-256` with the app secret.
  - Twilio: `X-Twilio-Signature` over the public address with the auth token.
  - WAHA: its HMAC key, or local network only.
  - The email forwarder and n8n: their token.

  A request that fails the check gets a 403 and is not read.
- **No money without the Seal.** A message from any channel is an ordinary case: refunds, reversals and
  credits still go through the calibrated routing and the Seal, and an escalation still waits for a person.
- **Contacts only** by default on email and WhatsApp; robots, mailing lists, bounces and auto-replies are
  never answered, and Nirnaya's own replies carry `Auto-Submitted` so other robots leave them alone.
- **Secrets stay on the server.** After saving, the app only shows that a secret is set.

## Troubleshooting

| You see | Do this |
|---|---|
| Email: "Username and Password not accepted" | Use an app password (2-Step Verification must be on), not your Google password |
| Email: nothing is answered | The sender must be a contact (Channels → Contacts), or set **Answer** to *Anyone who writes* |
| Email: old mail was not answered | On purpose: the first check only remembers where the mailbox is |
| WhatsApp: Meta's webhook will not verify | The verify token must match, the public address must be https and reachable, and WhatsApp must be switched on in Nirnaya |
| WhatsApp: "not on the test number's allowed list" | Add the number under WhatsApp → API Setup → To |
| WhatsApp: "only within 24 hours" | Send `template:hello_world` first, or ask the customer to write first |
| WhatsApp: messages arrive but get no answer | The sender is not a contact; link them, or set **Answer** to *Anyone who writes* |
| Twilio: "application error" on a call | The public address is wrong or not running; the "A call comes in" URL must be the one Nirnaya shows |
| Twilio: 403 in Nirnaya's log | The public address in Nirnaya must be exactly the one Twilio calls (https, no trailing path) |
| Twilio: cannot call a number | On a trial, verify the number first (Verified Caller IDs) |
| The call page does not listen | Use Chrome, Edge or Safari, allow the microphone, and stay online |
| The status card says *error* | The message under it is the provider's own explanation |

## How this was tested

- `cd backend && python -m pytest -q tests/test_channels.py` (19 tests). Stand-ins for Meta, WAHA,
  Twilio and n8n record each request and answer the way the providers do; every webhook is signed the
  way the provider signs it. Twilio's signature is checked against Twilio's own library's result.
- Email also runs against a real SMTP and IMAP server (GreenMail): `make mail-server` in one terminal,
  `make test-mail` in another. That run covers the threaded replies, robots and strangers ignored, the
  forward to the supervisor, APPROVE by email, the confirmation and the customer being told.
- `make e2e-channels` (22 browser checks) drives every field and button of Channels in Chromium against
  a running server and GreenMail. It covers:
  - a flow built in the Builder that starts on a WhatsApp message;
  - forwarding and calling from a case;
  - an escalation approved by email in real time;
  - the call page by voice, with speech mocked, in Hindi, muted, typed, without speech recognition, and
    with the microphone blocked;
  - the access-key lock screen.
- Not tested here: real Gmail, Meta and Twilio accounts. Those need your own credentials and a public
  address, and this build machine reaches the internet only through a web proxy.

## Sources

- Meta: [WhatsApp pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
  · respond.io: [WhatsApp pricing changes in 2026](https://respond.io/blog/whatsapp-pricing-change-2026)
- Twilio: [free trial limits](https://www.twilio.com/docs/usage/trials) (incoming calls on a trial cannot be recorded) · [webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security) · [recording a call in progress](https://www.twilio.com/docs/voice/api/recording-resource) · [`<Gather>` languages](https://www.twilio.com/docs/voice/twiml/gather) · [India voice pricing](https://www.twilio.com/en-us/voice/pricing/in) · [Polly bilingual voices (Aditi, Kajal)](https://docs.aws.amazon.com/polly/latest/dg/bilingual-voices.html)
- WAHA: [waha.devlike.pro](https://waha.devlike.pro/) · [events and webhooks](https://waha.devlike.pro/docs/how-to/events/)
- Email: [Gmail SMTP limits](https://www.serversmtp.com/limits-of-gmail-smtp-server/) · [Resend free tier](https://automationatlas.io/answers/resend-free-tier-explained-2026/)
  · [SendGrid alternatives and its free plan ending](https://dreamlit.ai/blog/best-sendgrid-alternatives)
  · [free inbound email APIs](https://sequenzy.com/blog/best-free-inbound-email-apis)
- Hosting: [Render blocks SMTP on free services](https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports)
  · [Cloudflare quick tunnels](https://flaviocopes.com/cloudflare-quick-tunnels/)
- Voice alternatives (not built in): [LiveKit pricing](https://livekit.com/pricing) (a free US number with
  50 inbound minutes), [Pipecat](https://docs.pipecat.ai/), [Bolna](https://pypi.org/project/bolna/)
  (Indian languages)
- n8n with WhatsApp: [a self-hosted WhatsApp bot with n8n](https://www.freecodecamp.org/news/how-to-build-a-self-hosted-whatsapp-bot-with-n8n-and-waha)
