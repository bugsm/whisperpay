# Whisper Pay

One-link private payment requests on Starknet, powered by STRK20 shielded transfers.

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

- **Frontend & Backend:** Next.js
- **Chain interaction:** Starknet.js
- **Privacy layer:** STRK20 wallet API / SDK for the shielding flow
- **Identity:** Starknet ID, so a request can be addressed to `alice.stark`

## Goal for the sprint

Ship a minimal but fully working mainnet flow:

`generate link → connect wallet → shield & send payment → recipient sees private balance update`

## Roadmap

Following [Private Sprint (STRK20)](https://strk20.starknet.io/hackathon), Aug 14–31.

* ✅ **M1:** payment request object + shareable link + shield-to-pay flow
* ✅ **M2:** paid-detection + private balance dashboard (viewing key)
* ✅ **M3:** unshield ("withdraw to spend") + pay-by-identifier lookup (Starknet ID)
* **M4:** recurring payment requests (subscriptions / repeat invoices)
* **M5:** stretch — public status page per link (paid / pending) without revealing amount or parties

## Status

M1–M3 are built and running against mainnet infrastructure. Still to do: the
three real pool transactions for `strk20.json`, a demo video, and a public
deployment — see [Getting to mainnet](#getting-to-mainnet).

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
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

[**docs/PRIVACY.md**](docs/PRIVACY.md) has the full accounting of what is and
isn't hidden, and why "submitted" and "received" are separate states.

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
