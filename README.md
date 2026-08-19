# Whisper Pay

One-link private payment requests on Starknet, powered by STRK20 shielded transfers.

## Innovation

Whisper Pay routes each payment by reading the payer's shielded balance first —
funded payers pay note-to-note with nothing public, first-time payers get
deposit and transfer bundled atomically. When that deposit would equal the
payment and publish it, the router flags it and offers to over-fund so the
public leg no longer states what was paid.

That decision is made in [`planPayment`](src/lib/strk20/plan.ts) and shown to
the payer before they sign, as a privacy meter that quotes this transaction's
own numbers rather than a generic disclaimer
([`assessPrivacy`](src/lib/strk20/privacy.ts)). Both are covered by tests —
`npm test`.

Two honest limits, stated here because they're easy to overclaim:

- **Over-funding is offered, not forced.** It rounds the deposit up to the next
  10 STRK, deterministically — not randomly — and the payer chooses. When the
  amount is already a multiple of 10 the rounding changes nothing, and the app
  keeps the warning up rather than pretending otherwise.
- **It narrows, it doesn't erase.** A 20 STRK deposit followed by a transfer
  still bounds the payment at "at most 20". Shielding ahead of time, unlinked in
  time from any payment, is the only route that publishes nothing at all — and
  it's the route the app takes whenever the payer is already funded.

## What is this?

Whisper Pay is a one-link private payment request tool built on STRK20. A user generates a shareable payment link (similar to PayPal.me); when the payer clicks and pays through the link, the transfer is routed through STRK20's shielded flow so the amount and sender/receiver details stay private on-chain, while the recipient can still view their own incoming payments.

## Why

On a public chain, every payment link normally leaks the full picture: who paid, how much, and when. That's fine for a public tip jar, but not for freelancers, small businesses, or anyone who just doesn't want their payment history sitting in plain sight forever. Whisper Pay keeps the convenience of a shareable payment link while routing the actual transfer through STRK20's shielded pool, so the amount and the parties involved stay private on-chain.

## How it works

1. Sender creates a payment request and gets a shareable link
2. Payer opens the link, connects their Starknet wallet
3. Payment is shielded and sent through the STRK20 privacy pool
4. Recipient sees the incoming payment reflected in their private balance — no public trace of amount or counterparties

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind CSS v4 · starknet.js v10 ·
get-starknet (Wallet Standard) · STRK20 Privacy Wallet API · Starknet ID ·
Zustand · Upstash KV (optional)

**No custom Cairo contracts, nothing deployed.** Every pool operation — deposit,
transfer, withdraw — is composed as STRK20 actions and submitted through the
user's wallet via `strk20InvokeTransaction`. Starknet ID resolution calls the
mainnet naming contract read-only through the app's own RPC. The only optional
server dependency is a KV store for request status, and payment works without
it.

## Goal for the sprint

Ship a minimal but fully working mainnet flow:

`generate link → connect wallet → shield & send payment → recipient sees private balance update`

## Roadmap

Following [Private Sprint (STRK20)](https://strk20.starknet.io/hackathon), Aug 14–31.

* ✅ **M1:** payment request object + shareable link + shield-to-pay flow
* ✅ **M2:** paid-detection + private balance dashboard (viewing key)
* ✅ **M3:** unshield ("withdraw to spend") + pay-by-identifier lookup (Starknet ID)
* ✅ **M4:** recurring payment requests (subscriptions / repeat invoices)
* ✅ **M5:** stretch — public status page per link (paid / pending) without revealing amount or parties
* ✅ **M6:** stretch — [signed receipts](#signed-receipts) the recipient issues and anyone can check

## Signed receipts

A recipient can hand someone a receipt: "request X was paid", signed by the
account the request was addressed to. Generate one from the dashboard on a paid
request; anyone can check it at `/verify-receipt`, from their own browser,
against the account contract on mainnet. No Whisper Pay server is consulted, and
none could change the answer.

**It is a signed receipt, not a proof of payment.** What a verifier learns is
that whoever holds that account's key asserted a specific sentence about a
specific request id, at a specific time, and cannot later deny doing so. That is
the trust model of a signed paper receipt — non-repudiable, and worth exactly
what the signer's word is worth.

It is **not** a zero-knowledge proof and must never be described as one. Proving
"a transfer of at least X reached my address" without revealing X means proving
statements about the pool's note commitments, which needs a custom Cairo
circuit, a verifier contract and prover integration. Whisper Pay is wallet-only
and never touches note internals or the viewing key, so that claim isn't ours to
make.

Two limits are built into the format rather than only written here:

* **It cannot name the payer.** The pool hides the sender from everyone, the
  recipient included. A receipt says "request X was paid"; it can never say who
  paid it, and no field carries a payer.
* **The amount is deliberately excluded from the signed payload.** Not hidden
  from display — absent from what gets signed, so a receipt cannot be made to
  imply an amount, and `receipt.test.ts` fails if a field ever sneaks in.

And a limit no format can fix: **this is for cooperative use only.** Showing an
accountant or a client that a request was fulfilled is the use case. It is
useless in an adversarial dispute, because the recipient is the party being
disputed and simply won't sign a receipt that hurts their case. The verification
page says so to whoever is reading a receipt, not just here.

Mechanically: SNIP-12 revision 1 typed data signed through `wallet_signTypedData`,
verified with `verifyMessageInStarknet`, which calls `is_valid_signature` on the
signer's account contract — so any account implementation works, not only
plain Stark-curve keys.

## Status

M1–M6 are built and running against mainnet infrastructure. `strk20.json` holds
three verified mainnet pool transactions. Still to do: a demo video and a public
deployment — see [Getting to mainnet](#getting-to-mainnet).

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # routing and privacy-claim tests, no extra dependencies
```

No configuration needed — it defaults to a public mainnet RPC. Copy
`.env.example` to `.env.local` for your own RPC or a durable status store; every
value there is optional.

You need a Starknet wallet with STRK20 support, on **mainnet** —
[Ready](https://www.ready.co/) and [Xverse](https://www.xverse.app/) support it
today. Registering with the pool and shielding both happen **inside the wallet**:
it holds the viewing key, so no dapp can do either on your behalf.

### How the payment is routed

Before showing a Pay button, the app reads the payer's shielded balance and
picks a route ([`src/lib/strk20/plan.ts`](src/lib/strk20/plan.ts)):

| Payer's state | Actions submitted | What's public |
| --- | --- | --- |
| Funded in the pool | `[transfer]` | nothing |
| Not funded | `[deposit, transfer]` — one atomic tx | the deposit only |

The second route is what lets someone pay a link having never used the pool.
Both actions go to the wallet as a single `strk20InvokeTransaction`, so they
settle together or not at all.

When the deposit would exactly equal the payment — the zero-balance case — the
amount is effectively published and linked to the transfer by timing. The app
detects this and offers to round the deposit up; the surplus stays shielded.

Whichever route applies, the payer sees it before they sign. A privacy meter on
the payment page states what *this* transaction publishes, quoting its own
numbers — "the deposit is rounded up to 20 STRK, so the public leg says 20 STRK
shielded, not what you paid" — so the claim can be checked against the figures
directly above it. It also flags an amount precise enough to identify itself
(seven decimal places is memorable in a way 12.5 isn't), as advice rather than a
blocker. The wording comes from
[`assessPrivacy`](src/lib/strk20/privacy.ts), which adds no routing logic of its
own — every branch reads a decision `planPayment` already made.

[**docs/PRIVACY.md**](docs/PRIVACY.md) has the full accounting of what is and
isn't hidden, and why "submitted" and "received" are separate states.

### Recurring requests

A link can repeat — weekly, fortnightly, monthly, with an end after *n* payments
or none at all. One link covers the whole subscription: each period it presents
that period's installment, and the payer approves it in their wallet.

It can't be otherwise. Every private transfer is a proof generated inside the
payer's wallet, so a link that charged on its own would need their key sitting on
a server. Nothing here does. "Cancelling" is just not paying the next one — the
recipient's side of it is to stop sharing the link.

Each installment carries its own status, so the dashboard shows the period
that's currently due rather than the first one ever paid, and a payer reopening
the link is told if this period already looks settled. Months are calendar
months: the 31st bills on the 28th in February and back on the 31st in March,
without drifting ([`src/lib/request/schedule.ts`](src/lib/request/schedule.ts)).

Repetition has a privacy cost of its own — a shield-per-payment cadence is a
strong fingerprint even when every transfer stays hidden. `docs/PRIVACY.md`
covers it and what to do instead.

### The status link

Every request comes with a second link, `/s/<id>`, and the difference between
the two is the point. The payment link *is* the invoice: it carries the amount,
the recipient and the note, so sharing it to prove you were paid shares all of
that too. The status link carries a request id — 72 random bits that describe
nothing — and renders one fact: unpaid, submitted, or received.

That page can be as thin as it is because the record behind it is. The payer's
transaction hash is verified when reported and then **discarded rather than
stored**: for someone who shielded in order to pay, that hash leads straight to
a public deposit with their address on it, and status is readable by anyone
holding the id. So the server keeps a lifecycle state and two timestamps, and
that is the whole of it.

Recurring links carry their schedule in the URL, so the page shows "payment 3 of
12" and the recent periods — cadence and length, still no amount and no parties.

### Getting to mainnet

- [ ] [Ready](https://www.ready.co/) or [Xverse](https://www.xverse.app/), switched to mainnet
- [ ] Some mainnet STRK — a few is enough for all three transactions
- [ ] **Register with the pool from the wallet's privacy section.** One
      transaction, done once; nothing can be sent to you privately until you do
- [ ] **Shield some STRK in the wallet**, so the first payment runs the
      already-funded route. (Paying with an empty shielded balance also works —
      Whisper Pay shields and pays in one transaction — but then the deposit is
      public, so shield ahead of time if you care about that.)
- [ ] Use Whisper Pay end to end: create a link, pay it, withdraw — three pool transactions
- [ ] `node scripts/strk20-json.mjs <hashes>` records them, running the same
      on-chain check the judging panel does so an ineligible hash never gets written

## Team

- GitHub: [@bugsm](https://github.com/bugsm)
- Telegram: [@genobu](https://t.me/genobu)
