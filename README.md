# Whisper Pay

One-link private payment requests on Starknet, powered by STRK20 shielded transfers.

Create a payment link the way you'd share a PayPal.me. The payer opens it,
connects a Starknet wallet, and pays — routed through the STRK20 privacy pool, so
the amount and the parties don't end up in public view. The recipient sees the
money in their shielded balance and nobody else sees anything.

**Starknet mainnet only.** There is no testnet mode; the pool this app talks to is
the live one.

---

## Why

On a public chain, a payment link leaks the whole picture: who paid, how much,
and when. That's fine for a tip jar and wrong for a freelancer's invoice, a
supplier payment, or a salary. Whisper Pay keeps the convenience of a shareable
link and moves the settlement into STRK20's shielded pool.

## How it works

1. **Create** — pick an amount, get a link. The request is encoded *in the link
   itself*: no account, no database row, nothing to lose or leak.
2. **Pay** — the payer connects a wallet and approves once. If they hold nothing
   in the pool, Whisper Pay shields and pays in a **single atomic transaction**.
3. **Receive** — the payment lands in the recipient's shielded balance. They can
   hold it privately or withdraw to a public address.

## What the STRK20 integration actually does

This is not a wrapper around a transfer button. The pool is the mechanism.

**Routing.** Before showing a Pay button, the app reads the payer's shielded
balance and picks a route (`src/lib/strk20/plan.ts`):

| Payer's state | Actions submitted | What's public |
| --- | --- | --- |
| Funded in the pool | `[transfer]` | nothing |
| Not funded | `[deposit, transfer]` — one atomic tx | the deposit only |

The second route is what makes a one-link payment work for someone who has never
used the pool. Both actions are handed to the wallet as one
`strk20InvokeTransaction`, so they settle together or not at all — there's no
state where the payer has shielded funds but the payment didn't happen.

**Partial coverage.** If a payer holds *some* shielded balance, only the shortfall
is deposited; the rest of the payment comes from existing notes.

**A privacy control, not just a warning.** When the deposit would exactly equal
the payment — the zero-balance case — the amount is effectively published and
linked to the transfer by timing. The app detects this (`revealsAmount`) and
offers to round the deposit up so the public number isn't the payment. The
surplus stays shielded and pays for the next one privately.

**Reads through the user's own key.** Balances come from `strk20Balances` via the
wallet. Whisper Pay never holds a viewing key, never runs a prover, never
custodies funds.

**Honest verification.** When a payment is reported, the server checks the hash
on-chain — it exists, it succeeded, the pool emitted an event
(`src/lib/strk20/verify.ts`). That's the most a hash can prove, because the
transfer hides its amount and parties. So the request becomes *submitted*, and
only the recipient — reading their own balance — marks it *received*.

Read [`docs/PRIVACY.md`](docs/PRIVACY.md) for the full accounting of what is and
isn't hidden.

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

No configuration is required. The app defaults to a public mainnet RPC and keeps
request status in memory.

To use your own RPC or a durable status store, copy `.env.example` to
`.env.local` and fill in what you need — every value there is optional.

You will need a **Starknet wallet with STRK20 support**, switched to mainnet.
[Ready](https://www.ready.co/) supports it today.

## Architecture

```
src/
  lib/
    amount.ts              bigint fixed-point helpers (no floats, anywhere)
    url.ts                 absolute links behind proxies
    strk20/
      constants.ts         mainnet pool, STRK token, chain id
      plan.ts              payment routing — the core of the app
      errors.ts            wallet error codes → messages a payer can act on
      verify.ts            is this hash a real, successful pool transaction?
      provider.ts          shared mainnet RPC
    request/
      types.ts             the data model + lifecycle
      codec.ts             link payload: encode, and strictly validate on decode
      history.ts           links you created — localStorage, never the server
    store/                 optional KV for status; memory fallback
  app/
    page.tsx               create a request
    pay/[id]/              the payer flow
    dashboard/             shielded balance, withdraw, your links
    api/requests/          POST — mint a link
    api/status/[id]/       GET/POST — status, with on-chain verification
  components/
    wallet/                get-starknet discovery + mainnet-only wallet store
```

**Why links are self-contained.** `/pay/<payload>` decodes without touching a
database, so payment works even with no store configured and a link can't be
broken by losing server state. The payload is unsigned on purpose: anyone can
mint a link, and tampering with one just produces a different request — the payer
sees the recipient and amount before approving anything. Because it's fully
attacker-controlled, `decodeRequest` validates every field and rejects anything
it doesn't understand.

### API

```bash
# Mint a link
curl -X POST http://localhost:3000/api/requests \
  -H 'Content-Type: application/json' \
  -d '{"recipient":"0x...","amount":"12.5","memo":"Invoice #42","expiresIn":604800}'

# Read status
curl http://localhost:3000/api/status/<id>
```

## Deploying

Standard Next.js — Vercel needs no configuration. Set `NEXT_PUBLIC_APP_URL` if
you're behind a custom domain, and add `KV_REST_API_URL` / `KV_REST_API_TOKEN`
for durable status.

> GitHub Pages won't work: the API routes need a server. Point the repository's
> **Website** field at your deployment so the sprint hub finds the demo.

## Sprint submission

`strk20.json` is maintained by a script that runs the same on-chain check the
judging panel does, so a hash that wouldn't count never gets written:

```bash
node scripts/strk20-json.mjs 0xabc... 0xdef...   # verify and add
node scripts/strk20-json.mjs --check             # re-verify what's listed
node scripts/strk20-json.mjs --video https://youtu.be/...
```

It prints what's still missing to be scored.

### Getting to mainnet

The sprint needs three real pool transactions. Before spending anything:

- [ ] A wallet with STRK20 support ([Ready](https://www.ready.co/)), on **mainnet**
- [ ] Some mainnet STRK — a few is enough for all three transactions
- [ ] **Register your viewing key** once, at
      [strk20.starknet.io/app](https://strk20.starknet.io/app). Nothing can be
      sent to you privately until you do, and the app will tell you so
- [ ] Shield a small amount, then use Whisper Pay end to end: create a link, pay
      it, withdraw. That's three pool transactions
- [ ] `node scripts/strk20-json.mjs <hashes>` to record them

> Private transactions are submitted by **rotating shared relayers**, so on
> Voyager the sender won't be your address. That's the system working. Eligibility
> is checked against the `user_addr` in the pool's own event, not the transaction
> sender.

## Reference

- [STRK20 by example](https://strk20-by-example.org/what-is-strk20) — the pool, the Wallet API, anonymizers
- [Privacy SDK](https://github.com/starkware-libs/starknet-privacy) — pool contracts, TypeScript SDK, proving service
- [STRK20 starter kit](https://github.com/Akashneelesh/strk20-starter-kit) — the wallet-connection approach here is adapted from it
- [Day 0 guide](https://github.com/starkience/strk20-hackathon/blob/main/docs/MAINNET-DAY-0.md) — source of the verified mainnet values

Mainnet pool: [`0x040337b1…ffe812a`](https://voyager.online/contract/0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a)

## License

[MIT](LICENSE)
