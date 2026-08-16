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

## Goal for the sprint

Ship a minimal but fully working mainnet flow:

`generate link → connect wallet → shield & send payment → recipient sees private balance update`

## Roadmap

Following [Private Sprint (STRK20)](https://strk20.starknet.io/hackathon), Aug 14–31.

* **M1:** payment request object + shareable link + shield-to-pay flow
* **M2:** paid-detection + private balance dashboard (viewing key)
* **M3:** unshield ("withdraw to spend") + pay-by-identifier lookup
* **M4:** recurring payment requests (subscriptions / repeat invoices)
* **M5:** stretch — public status page per link (paid / pending) without revealing amount or parties

## Status

🚧 Early build — working on M1.

## Team

- GitHub: [@bugsm](https://github.com/bugsm)
- Telegram: [@genobu](https://t.me/genobu)
