# Free tiers only

Everything Nirnaya uses runs on a free tier or on your own computer. None of it needs a card, so nothing can
bill you. The server, the agents, the rules, the calibrated router and the database (SQLite) all run on
your own machine. The services below are optional extras, and each one says what its free plan allows.

| What | Service | Free plan | Card | When the free plan is used up |
|---|---|---|---|---|
| Language model (optional) | [Groq](#groq), [Gemini](#google-gemini), [OpenRouter](#openrouter-free-models-only), [Mistral](#mistral-experiment-plan), [Ollama](#ollama-on-your-own-computer) | see each below | no | that provider rests and the next one answers; with none, the rules work alone |
| Shared workspaces (the person+ button) | [Firebase Realtime Database](#shared-workspaces-the-person-button), Spark plan | 100 people connected at once, 1 GB stored, 10 GB a month downloaded | no | sharing pauses until next month; everyone's own Nirnaya keeps working |
| The website for your team | [Vercel](#the-website-on-vercel) Hobby, or Firebase Hosting / Cloudflare Pages | Vercel Hobby: personal, non-commercial projects | no | Vercel waits 30 days before serving again |
| Real UPI payments (optional) | [Razorpay test mode](docs/upi.md) | free, no KYC: real API, webhooks and refunds, no real money | no | does not run out; live keys are refused |
| Your own customers and payments | CSV import in the Ledger | free, on your machine | no | |
| Email | Gmail (IMAP + SMTP with an app password), Brevo, Resend | [channels.md](channels.md) | no | |
| WhatsApp | Meta's WhatsApp Cloud API, free test number | [channels.md](channels.md) | no | |
| Phone calls | the call page, `/call`: customers talk to the agent from Chrome, Edge or Safari | free, no account | no | |
| Phone calls on a real number | Twilio | **a trial credit only**: there is no forever-free phone line | no for the trial | the trial ends; use the call page |
| Webhooks from the internet | Cloudflare quick tunnel (`cloudflared tunnel --url …`) | free, no account | no | |
| Error monitoring (optional) | Sentry, Developer plan | free for one person | no | errors stop being collected |

Rules of thumb: never add a card, never "upgrade", never buy credits. Where a provider asks for a card to
get *more* free usage, Nirnaya does not need it.

## A free language model

The agents work without one. A model refines what a customer means, drafts the reply and lets an agent
answer your questions in its own words. It only ever sees tokenised text; every reply still passes the
Promise Guard, and the rules and the calibrated router decide what happens. So a free model can only make
the wording better. It cannot move money on its own.

Set it up in **Settings → Language model · free tiers only**:
1. Get a free key from one or more providers below.
2. Paste the key, press **Test** (it lists the free models and asks for one word), then **Save**.
3. Use the arrows to order the providers. They are tried top to bottom. When one runs out of its free
   quota (it answers "429"), it rests for as long as it asks and the next one answers. When none answers,
   the rules carry on alone.

The top bars say **REASONS WITH GROQ** (or whichever provider answered), or **RULES ONLY**.

On a server without the app open, use the environment instead: `GROQ_API_KEY`, `GEMINI_API_KEY`,
`OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `OLLAMA_HOST`, or `NIRNAYA_LLM_URL` (+ `NIRNAYA_LLM_KEY`,
`NIRNAYA_LLM_MODEL`) for any other OpenAI-compatible server. `NIRNAYA_<PROVIDER>_MODEL` picks a model,
`NIRNAYA_LLM_ORDER=groq,gemini` sets the order, and `NIRNAYA_LLM=off` switches the model off.

### Groq
Fast and the most generous. Sign up at [console.groq.com](https://console.groq.com/keys) with Google or
GitHub; no card. The free plan allows about 30 requests a minute and 1,000 a day per model (the limits are
per organisation, so a second key does not add more). Nirnaya picks `openai/gpt-oss-20b` when it is offered,
with low reasoning effort, so answers come quickly. Leave the plan on Free.
Source: [Groq rate limits](https://console.groq.com/docs/rate-limits).

### Google Gemini
Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). The free tier covers the
Flash and Flash-Lite models; your exact limits are on AI Studio's rate-limit page. **Keep billing off on
that Google Cloud project**: with billing on, the same key is charged. Nirnaya prefers a Flash-Lite model.
Source: [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing).

### OpenRouter (free models only)
Make a key at [openrouter.ai/keys](https://openrouter.ai/keys). Nirnaya only ever uses models whose name ends
in `:free` and whose listed price is 0; it refuses to save any other model. Without bought credits the free
models allow 20 requests a minute and 50 a day. Some free models do not take JSON mode; Nirnaya asks those
again plainly. Source: [OpenRouter limits](https://openrouter.ai/docs/api-reference/limits).

### Mistral (Experiment plan)
[console.mistral.ai](https://console.mistral.ai/api-keys): choose the free Experiment plan (a phone check, no
card). It is slow on purpose (about 2 requests a minute), so put it low in the order. Mistral may use
requests on this plan for training: fine for the demo customers, not for real ones.

### Ollama on your own computer
Free, private, and works offline. Install it from [ollama.com/download](https://ollama.com/download), then
pull a model, for example `ollama pull qwen3:4b` (about 2.5 GB). Nirnaya finds it at
`http://127.0.0.1:11434` by itself and uses it only while it runs. LM Studio, llamafile and vLLM work too:
use **Another OpenAI-compatible server** with their address (for example `http://127.0.0.1:1234/v1`).

How good is a small local model? We ran Llama 3.2 1B (a 1.1 GB llamafile) on this project's test machine,
CPU only. It answered in 1 to 4 seconds and named the right intent for 2 of 3 test messages. It also misread
one amount (₹2,440 for ₹2,450) and made up a merchant. That is why the model only advises: the rules and
the router decide. Use a model of 4B or more, or Groq, for better wording.

## Shared workspaces (the person+ button)

The **person+** button in both top bars opens **Work together**:
- **Create a workspace** gives a code such as `K7QM2-XRP4T`.
- **Join a workspace** takes a code someone gave you.

People in your workspace see your agents live (the office, cases, approvals, flows, the log). They can
also work with them: answer customers, approve or reject, give tasks and run flows. Only you can change
API keys, channel settings and the workspace itself.

It works from the website, the phone app and the Windows app. Creating a workspace needs your agents
running somewhere: the Windows app, or `make run` on a computer. Joining works from anywhere, including the
phone app and the website on Vercel, with no server of your own.

### How it works
Your server hosts the workspace. It keeps one outbound connection to a free Firebase Realtime Database,
so it works from a laptop behind a home router; nobody has to reach your computer. A member's app writes
each request under `/w/<code>/req`. Your server answers it from its own API, exactly as if the member were
on your server, and writes the answer back. Your agents' live events flow out the same way, batched four
times a second. Answers over 1 KB are compressed. The layout is in
[backend/nirnaya/relay.py](backend/nirnaya/relay.py).

The code is the password: 10 letters and digits (about 49 bits), so it cannot be guessed. Share it only
with your team. **New code** shuts out everyone who had the old one, and **Stop sharing** deletes the
workspace from the database. When your server stops, members see that you are offline. After a restart it
hosts the same workspace again, with the same code.

### Set up the free database (about 5 minutes, once for the whole team)
1. Go to [console.firebase.google.com](https://console.firebase.google.com), **Add project** (any name;
   Analytics off). The project starts on the free Spark plan; there is nothing to add.
2. **Build → Realtime Database → Create database**. Pick a location and **Start in locked mode**.
3. **Rules**: replace them with the contents of [firebase/database.rules.json](firebase/database.rules.json)
   and **Publish**. They let nobody list workspaces. They only let someone read or write a workspace whose
   code they know, and only in its expected shape. Nirnaya refuses a database left open in "test mode",
   because there anyone could read every workspace.
4. Copy the database address at the top of the **Data** tab, for example
   `https://your-project-default-rtdb.firebaseio.com`.
5. Give it to Nirnaya, in one of these ways:
   - Build it in, so nobody has to type it: put `VITE_NIRNAYA_RELAY=<address>` in `web/.env.production`
     (see [web/.env.example](web/.env.example)), then `make build`, `make exe` and `make apk`. On Vercel,
     add the same variable in the project settings. It is not a secret: it ends up in the built app either
     way, and the rules and the codes protect the data.
   - Or paste it once in **Work together**. Each app remembers it.
   - Or set `NIRNAYA_RELAY_URL` on a server.

### How far the free plan goes
- **People at once:** 100 can be connected at the same time.
- **Each person's data:** a member watching your office all day downloads 10 to 25 MB through the relay,
  depending on how busy it is. That is the live events, plus a refresh of the office and the state every
  minute (every 15 s on your own server). Measured: with 20 cases the state is about 10 KB compressed,
  and it grows with the case list up to the last 100 cases.
- **A month:** the 10 GB covers a team of roughly 15 to 40 people working every working day.
- **Storage:** nothing is kept but the latest 16 event batches and each person's presence. Answers are
  deleted as soon as they are read.

To try it without Firebase, `make relay-emulator` runs Google's own emulator of the same database on your
computer (it needs Java). Use the address `http://127.0.0.1:9000/?ns=demo-nirnaya`.

## The website on Vercel

The web app is static, so any free static host can serve it. The agents run on the host's server, and the
site reaches them through the relay.

1. On [vercel.com](https://vercel.com), choose **Add New → Project** and import this repository.
2. Set **Root Directory** to `web`; [web/vercel.json](web/vercel.json) has the rest: the Vite build, `dist`,
   and the page for `/call`.
3. Under **Environment Variables**, add `VITE_NIRNAYA_RELAY` (your database address) and deploy.
4. Teammates open the site, press **Join with a code**, and are in your workspace.

Vercel's free Hobby plan is for personal, non-commercial projects
([Vercel fair use](https://vercel.com/docs/limits/fair-use-policy)). If Nirnaya will serve a business,
host the same `web/dist` folder for free on Firebase Hosting, in the project you already have:
`npx firebase-tools deploy --only hosting`, with `public` set to `web/dist`. Cloudflare Pages is another
free option.

## What is not free, and is not used

- Anthropic's Claude API: removed. Nirnaya no longer reads `ANTHROPIC_API_KEY`.
- Paid model plans, paid credits and paid Firebase (Blaze).
- Twilio beyond its trial credit.
- Razorpay live mode: it moves real money and needs KYC. Nirnaya accepts only `rzp_test_` keys.
