# UPI payments: what is real, what is simulated, and why

A short brief for anyone who asks "are these UPI transactions real?" Read it before a demo.

## In one line

Nirnaya never moves real money, on purpose. It reads **real payment objects from a real gateway**
(Razorpay's test mode: same API, same webhooks, same refunds as live mode, no money), takes **your own
payments from a CSV**, and keeps a **demo bank** for the scripted scenes. Every payment is labelled with
where it came from, in the Ledger and on every case.

## The three kinds of payment

| Source | Label | What it is | What a refund does |
|---|---|---|---|
| Razorpay test mode | **Razorpay test** | Payments made on Razorpay's checkout with a test UPI ID (`success@razorpay`, `failure@razorpay`). Nirnaya pulls them with Razorpay's API and gets their changes by signed webhook. | A real `POST /v1/payments/{id}/refund` on Razorpay, after a person approves. It shows in your Razorpay dashboard. |
| Your own data | **Imported** | Customers and UPI payments you feed from a CSV, checked row by row (below). | A refund in Nirnaya's ledger, with an undo. |
| The demo bank | **Demo bank** | The seeded customers and payments for the scripted scenes. You can switch them off. | A refund in Nirnaya's ledger, with an undo. |

Razorpay test mode is free and needs no KYC and no card: sign up, stay in test mode, copy the test keys.

## Why no real UPI money

Only NPCI members (banks) and the apps NPCI approves (third-party app providers, which work through a
partner bank) may start or reverse a UPI payment. A hackathon project cannot, and should not pretend to.
What a judge can check is that the integration has the real shape: real API calls, real signatures, real
idempotency, and the same decisions a bank's operations team makes.

Nirnaya refuses live keys (`rzp_live_…`). Only `rzp_test_…` keys are accepted, so a demo can never touch
real money by accident.

## How a payment is handled

1. **It arrives.** Either "Sync now" pulls the latest payments, or Razorpay posts a webhook.
   A webhook is accepted only if `X-Razorpay-Signature` matches HMAC-SHA256 of the raw body with your
   webhook secret. A repeated event id is ignored (the last 500 are kept).
2. **It lands in the ledger.** The payment becomes a transaction: the amount, the merchant, the RRN as
   the UTR, the UPI ID, and the status. A failed payment is marked "not debited". The customer is found
   by the customer id in the notes, then by phone, then by email; if there is none, a new customer is
   made and labelled as coming from Razorpay. Two captured payments of the same amount at the same
   merchant within 15 minutes are flagged as a possible double charge.
3. **A customer complains.** The case is matched to the payment like any other. Before the evidence
   step, Nirnaya **reads the payment live from Razorpay**, so the agents decide on what Razorpay says now,
   not on a copy.
4. **The decision.** Any action that would move money on a gateway payment is **always sent to a person**,
   whatever the agents' confidence, because a gateway refund cannot be undone.
5. **The approval.** Before the refund, the payment is read from Razorpay again. If it changed since the
   decision (refunded from the dashboard, say), the Seal does not match and the old approval is not
   applied. The case is planned again on the new facts.
6. **The refund.** The Tool Gateway is the only code that can refund. It checks:
   - the payment was captured;
   - the refund is more than ₹0 and no more than what is still refundable (captured minus already refunded);
   - this exact refund has not already been made. The idempotency key goes to Razorpay in `receipt` and
     `notes.nirnaya_idem`, and Razorpay's list of refunds for the payment is checked first. A retry after a
     crash finds the first refund instead of paying twice.
7. **The record.** The receipt names the tool (`pg.refund`), the Razorpay refund id and the gateway, and
   has no undo. It goes on the case's trail with the rest of the hash-chained log.

A failed UPI payment that took no money gets a different answer: "no money left your account", not a
promise of a reversal.

## Feeding your own data

Ledger → Feed your own data. Pick "Customers" or "Transactions", download the template, fill it in,
then **Preview**. Nothing changes until you press **Import**, and only the rows that pass are kept.

Every row is checked:

- only the template's columns, at most 2,000 rows and 1 MB a file;
- a UTR is 12 digits; a UPI ID looks like `name@bank`; a phone is a 10-digit Indian mobile (6 to 9 first);
- an amount is above ₹0 and within ₹1,00,000, UPI's usual limit (`NIRNAYA_IMPORT_MAX_AMOUNT` changes it);
- a date is not in the future and not more than two years old; statuses are from a fixed list;
- a failed payment says whether money was taken; only a payment that went through can have a refund;
- no duplicates: a UTR, transaction id, customer id or phone already in the ledger, or twice in the file;
- no spreadsheet formulas (a cell starting with `=`, `+`, `-` or `@`), and no instructions hidden in text,
  using the same checks the Sentry runs on customer messages.

Each imported row carries its file and batch. Remove an import in one click; switch the demo bank off to
work only on your own data. Imports, removals and the demo switch are written to the trail.

## Try it with real payments (10 minutes)

1. Make a free Razorpay account and stay in **Test mode**. On the API keys page of Razorpay's dashboard,
   generate a test key.
2. In Nirnaya: Ledger → Real UPI payments → paste the Key Id and Key Secret → **Save** → **Test**.
3. **Make a test payment**: pick a customer, an amount and a merchant, then **Create a payment link**.
   Pay it on Razorpay's page with UPI ID `success@razorpay`. Pay a second link with the same amount
   and merchant to make a double charge.
4. **Sync now**. The payments appear in the Ledger as "Razorpay test".
5. Open a case as that customer: "I was charged twice for ₹349 at CafeBrew". It is parked for a person.
   Approve it, then see the refund in Razorpay's dashboard under Refunds.
6. Optional, for live updates: put Nirnaya on a public address (Channels → Public address, a free
   Cloudflare quick tunnel works), then add the webhook URL shown in the card under Razorpay → Webhooks
   with `payment.captured`, `payment.failed`, `refund.processed` and `refund.failed`, and the same secret.

Keys can also come from the environment: `NIRNAYA_RAZORPAY_KEY_ID`, `NIRNAYA_RAZORPAY_KEY_SECRET`,
`NIRNAYA_RAZORPAY_WEBHOOK_SECRET`. The secrets are never sent back to the browser.

## From here to production

The gateway code is one adapter (`backend/nirnaya/pg.py`): read a payment, list its refunds, refund,
verify a webhook. A bank or payment app would add its own adapter with the same four jobs, behind the
same Tool Gateway, Seal and approvals:

- **A bank (PSP / issuer):** the UPI switch's status check for a transaction (`ReqChkTxn`), the bank's
  own reversal and refund calls, and NPCI's dispute system for UPI (UDIR) for complaints raised in the app.
- **A payment app (third-party app provider):** the partner bank's APIs for the same.
- **Another gateway:** Paytm, Cashfree and Setu all have free sandboxes with test UPI IDs and signed
  callbacks; each is a new adapter, not a new design.

The rules the agents already follow are the regulator's:

- RBI's turnaround-time circular (20 September 2019): a UPI payment debited but not credited to the
  beneficiary is reversed by **T+1**; after that the bank pays the customer **₹100 a day**. For a
  merchant payment where the merchant got no confirmation, the limit is T+5. Nirnaya's failed-UPI
  policy uses the T+1 limit and the ₹100 a day (`backend/nirnaya/policy.py`).
- RBI's payment data rule (April 2018): payment system data is stored only in India. Nirnaya keeps
  everything in its own database on your machine or server. The optional shared-workspace relay
  (Firebase) has no Indian region, so a bank would run that relay on its own servers in India.

## Questions a judge may ask

**"These UPI transactions aren't real."**
The demo bank isn't, and it says so. The Razorpay ones are real gateway payments in test mode: real API,
real webhooks with real signatures, real refunds you can see in Razorpay's dashboard. Only the money is
pretend, which is the only legal way to show it. You can also feed your own payments from a CSV.

**"Why not connect to UPI itself?"**
Only banks and NPCI-approved apps may. Nirnaya is built to sit inside one of them: the gateway is one
adapter, and the bank's own systems would be another.

**"What stops the agent refunding twice?"**
Three things. One idempotency key per action, sent to Razorpay with the refund. Razorpay's refunds for
the payment are checked before every refund. And the Gateway refuses anything above what is still
refundable.

**"What if the payment changes while the case waits for approval?"**
The payment is read from Razorpay again just before the refund. If it changed, the Seal breaks and the
old approval is not used. This is tested.

**"Could a message trick the agent into a refund?"**
The Sentry blocks injected instructions before any agent reads them. Even past that, an agent can only
propose: the Tool Gateway applies policy caps, and every gateway refund needs a person.

**"Can the agents pay someone just because they were told to?"**
They can prepare it; they cannot do it alone. "Pay ₹500 to Anushka" walks through Sentry, the Tokeniser,
Triage, Accounts & KYC, Risk & Fraud (payee, amount, today's total, how often this person was contacted),
the Router and the Seal Keeper, then waits for a named person. The seal covers the payee, the amount, the
float's version and the policy: if another payment moves the float first, the old approval pays nothing.
Payouts here are simulated and the message says so; a bank would put its own payout rail behind the same
Gateway call.

**"Can someone use it as a free chatbot?"**
No. Every way in (customer messages on every channel, questions to an agent, department tasks) passes a
finance-only gate first: code, general knowledge and random questions get a short refusal, and the case is
marked refused. Every prompt tells the model the same, and an answer that holds code or the model's own
off-topic signal is replaced before anyone sees it.

**"What about failed UPI debits, the most common complaint?"**
The agents check whether money was taken. If not, the customer is told plainly. If it was, the policy
follows RBI's T+1 reversal rule and the ₹100-a-day compensation.

**"What if the CSV is wrong or malicious?"**
Preview shows every refused row and why. Formulas, hidden instructions, impossible amounts, future dates
and duplicates are refused. Imports can be removed, and all of it is on the trail.

**"Where are customer details kept?"**
In Nirnaya's own database. Account numbers are tokenised before any agent or language model sees them,
and payment secrets never leave the server.

**"Is any of this paid?"**
No. Razorpay's test mode, the CSV import and everything else here is free with no card. See
[free.md](../free.md).
