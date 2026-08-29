# Whisper Pay

**Send someone a link to get paid — without publishing what you charged them.**

A payment link is the easiest way to invoice someone and the worst way to keep
it private. Whisper Pay keeps the link and routes the money through the STRK20
privacy pool, so the amount, the payer and the recipient stay off the public
record.

- **Live:** https://whisperpay.vercel.app
- **Mainnet proof:** [five pool transactions](#mainnet-proof), all
  `ACCEPTED_ON_L1`
- **Tests:** 213, no test framework — `npm test`

## The problem, precisely

Routing a payment through a privacy pool is not the same as making it private.
Here is the failure a naive integration ships with:

A payer opens your link and has never used the pool. To pay, their wallet must
first **deposit** funds into it — and a deposit is public, carrying their
address and its amount. The private transfer follows in the same transaction.

If that deposit is for exactly the amount you asked for, then anyone watching
the pool reads the amount off the public leg and ties it to your transfer by
timing. The payment is nominally private and effectively published. The pool did
its job; the integration gave it away.

Whisper Pay detects that case before the payer signs, in
[`planPayment`](src/lib/strk20/plan.ts), and offers to break the equality by
rounding the deposit up — the surplus stays in the payer's shielded balance
rather than being spent. `revealsAmount` is a field on the returned plan, not an
afterthought, and [`privacy.test.ts`](src/lib/strk20/privacy.test.ts) holds it
to that in both directions: it must be flagged when deposit equals payment, and
must stop being flagged once rounding breaks the equality.

Two honest limits, because this is easy to overclaim:

- **Rounding is offered, not forced**, and it is deterministic — the next
  multiple of 10 STRK, not a random figure. When the amount is already a
  multiple of 10, rounding changes nothing and the app keeps the warning up
  rather than pretending it helped.
- **It narrows, it doesn't erase.** A 20 STRK deposit still bounds the payment
  at "at most 20". Shielding ahead of time, unlinked in time from any payment,
  is the only route that publishes nothing — and it is the route the app takes
  automatically whenever the payer is already funded.

## What's hidden, what isn't

| | Hidden | Visible on-chain |
| --- | --- | --- |
| Paying from an existing shielded balance | amount, payer, recipient — the whole payment | nothing |
| Paying with an empty balance (deposit + transfer) | the transfer: amount, payer, recipient | the **deposit**: payer's address, token, deposited amount |
| Withdrawing to a public address | which shielded notes it came from | recipient address and amount |
| The payment link itself | — | not on-chain, but the URL **is** the invoice: amount, recipient, memo |
| A split-bill link `/bill/<payload>` | — | not on-chain, and no server holds it, but the URL **is** the whole bill: every name and every share |
| A short bill link `/b/<id>#<key>` | the bill — the server holds a ciphertext and no key | the id and the fact that *something* was stored |
| A scanned receipt photo | it is read and dropped — never written to disk, to Redis, or to a log | nothing; the image never goes on-chain or into storage |
| The status link `/s/<id>` | amount, token, both parties, memo, transaction | one word — unpaid or received — and the date |
| The recipient's dashboard | read locally with their own viewing key; never sent to a server | nothing |
| A signed receipt | amount, token, payer — none are in the signed payload | the request id, the claim, the time, the recipient's address |

The second row is the one that matters, and the reason for the section above.

## How it works

**1. The link carries the request.** Creating one writes nothing to a database
— recipient, amount and memo are encoded into the URL by
[`codec.ts`](src/lib/request/codec.ts). There is no server-side table of who
billed whom, because there is no server-side table.

**2. The route is chosen from the payer's shielded balance.**
[`planPayment`](src/lib/strk20/plan.ts):

| Payer's state | Actions submitted | What's public |
| --- | --- | --- |
| Funded in the pool | `[transfer]` | nothing |
| Not funded | `[deposit, transfer]` — one atomic transaction | the deposit only |

Both actions reach the wallet as a single `strk20InvokeTransaction`, so they
settle together or not at all. The second route is what lets someone pay a link
having never touched the pool before.

**3. The Privacy Risk Meter shows that decision before signing.**
[`assessPrivacy`](src/lib/strk20/privacy.ts) turns the plan into a claim
specific enough to check against the numbers on the same screen — "the deposit
is rounded up to 20 STRK, so the public leg says 20 STRK shielded, not what you
paid" — rated `strong`, `moderate` or `weak`. It adds no routing logic of its
own; every branch reads a decision `planPayment` already made. It separately
flags an amount specified to four or more decimal places, which stops looking
like a price and starts looking like a serial number — advice, never a blocker.

**4. Status is one bit, and the transaction hash is not kept.** When a payment
is reported, the server verifies the hash on-chain — it exists, it succeeded, it
emitted a pool event ([`verify.ts`](src/lib/strk20/verify.ts)) — and then
discards it. Keeping it would undo the point: for a payer who had to shield
first, that hash leads straight to their public deposit, and a status record is
readable by anyone holding the id. What survives is
`{id, status, submittedAt?, confirmedAt?}` and nothing else.

That is a claim the code has to keep on two sides, so both are tested.
[`status-privacy.test.ts`](src/lib/request/status-privacy.test.ts) fails the
build if a hash-shaped field reappears in the record type or the route — the
writing side. [`record.test.ts`](src/lib/store/record.test.ts) covers the
reading side: a stored record is rebuilt from the four permitted fields rather
than cast, so a record written by an older version — one that *did* keep the
hash — cannot carry it back out during the days before it expires.

**5. Signed receipts, framed for what they are.** A recipient can sign "request
X was paid" with the account the request was addressed to, and hand the artifact
to an accountant or a client. Anyone can check it at `/verify-receipt` — in
their own browser, against the account contract on mainnet, with no Whisper Pay
server consulted and none able to change the answer.

It is a **signed receipt, not a proof of payment**, and never a zero-knowledge
proof. What a verifier learns is that whoever holds that account's key asserted
a specific sentence about a specific request id, and cannot later deny it —
exactly the trust model of a signed paper receipt. Two limits are built into the
format rather than only written here:

- **It cannot name the payer.** The pool hides the sender from everyone, the
  recipient included.
- **The amount is absent from the signed payload** — not hidden from display,
  absent. [`receipt.test.ts`](src/lib/request/receipt.test.ts) serialises the
  typed data and fails if the words `amount`, `token`, `payer`, `sender` or
  `txhash` appear anywhere in it.

And one no format can fix: it is **for cooperative use only**. In a dispute the
recipient is the party being disputed, and simply won't sign a receipt that
hurts their case. The verification page tells its reader so.

**6. A split bill is not a new kind of payment.** One person covers the table
and several people owe different amounts. `/bill` builds the list once; each
line is then derived into an ordinary v1 payment request with its own
`/pay/<payload>` link ([`share.ts`](src/lib/bill/share.ts)), so the payer page,
the plan, the verification and the status store are untouched by the feature.
The person paying sees an amount and a note — not the bill, not the other names.

The organiser link carries the whole list, which is why the wire format
([`codec.ts`](src/lib/bill/codec.ts)) is validated as hostilely as a request
payload is, and why the total is **computed from the lines rather than carried
next to them**: two numbers that can disagree, in a payload supplied by whoever
sent the link, is one number too many. Splitting evenly goes through
largest-remainder allocation ([`allocate.ts`](src/lib/bill/allocate.ts)), so the
shares add back up to the total exactly instead of leaving the organiser a
rounding gap — a property test pins it across five hundred random splits.

The organiser page reads every line's status in one round trip (`getMany`) and
says "3 of 8 paid". That count is derived, never stored: the server still holds
only `{id, status, timestamps}` per line, and still doesn't know the lines
belong together.

**7. A short bill link, encrypted before it is stored.** A twenty-line bill is a
1.8k URL, and chat apps cut long links. `/b/<id>#<key>` is the opt-in fix: the
payload is encrypted in the browser with a fresh AES-GCM-256 key, the ciphertext
is stored under a random id, and the key goes after the `#` — the part of a URL
browsers never transmit. A real bill measured end to end: 80 characters against
531.

What the server gains is the ability to *lose* a bill, not to read one. So the
stateless link stays the default, the short one says plainly that it expires,
and where no store is configured the option is not offered at all and the
endpoint refuses to mint one — a short link backed by process memory works once
and looks identical to one that works. [`crypto.ts`](src/lib/bill/crypto.ts)
carries the round trip; its tests cover the wrong key, the tampered ciphertext
and the truncated link, since GCM answers all three the same way and each has to
reach the reader as a sentence rather than a blank page.

**8. A receipt photo becomes a bill, and the model never gets the last word.**
Typing eight lines off a receipt is where people give up before the links exist,
so `/bill` will read the photo instead: `claude-opus-5` returns a structured
list of items and amounts ([`scan.ts`](src/lib/ai/scan.ts)), each item is
tapped onto the people who ate it, and tax and service are pro-rated by what
each person had.

Three things are structural rather than cosmetic, because a receipt read from a
photo of a creased warung bill *will* misread a line:

- **The image is never stored.** Not to disk, not to Redis, not to a log, and
  not into an error message. There is nowhere for it to go, which is a stronger
  guarantee than a deletion policy.
- **Every number stays editable, and a total that disagrees is shown, not
  fixed.** [`notaTotals`](src/lib/ai/nota.ts) returns the difference between
  what the lines add up to and what the receipt printed; the UI shows it as a
  warning. Silently adjusting the lines to match would erase the one signal
  that the scan went wrong.
- **The answer is rebuilt field by field, not cast.** A schema constrains
  generated output; it doesn't guarantee it. Amounts must be integer strings in
  the currency's smallest unit — a JSON number for a rupiah figure is a float,
  and a float in a money path is the failure this codebase is built to avoid.

Currency conversion has the same shape as the split itself: the **whole**
receipt is converted once and then divided with `allocate`
([`quote.ts`](src/lib/quote.ts)), because converting each person separately
floors each of them down and leaves the organiser carrying the remainder. The
rate is locked into the payload and refused if it is over ten minutes old — and
what the link asks for is always the STRK figure, with the rupiah beside it as
context that does not follow the market.

The endpoint is the only one here that costs money to answer, so it is
rate-limited per caller, size-capped, and restricted to image types; the browser
downscales before it uploads. With no `ANTHROPIC_API_KEY` the mode is not
offered and the route answers 503 — the rest of the bill flow is unchanged.

## What's actually distinctive

Measured against a baseline STRK20 payment app, four things:

- **Correlation detection with an opt-in fix.** `planPayment` returns
  `revealsAmount` and offers deterministic over-funding. Most integrations
  deposit the exact shortfall and publish the amount without noticing.
- **The meter is pre-signature UI, not a backend decision.** The payer sees what
  this specific transaction will publish, quoting its own figures, while they
  can still change it.
- **A receipt format that is provably narrow.** The exclusion of amount, payer
  and token from the signed payload is enforced by a test, so it cannot regress
  into a marketing claim.
- **A correctness bug fixed with a regression test behind it.** A Starknet
  address arrives padded to 64 hex digits from a wallet and unpadded from a
  link; comparing the two as strings locked a recipient out of signing a receipt
  for their own request. Every comparison now goes through `sameAddress`, and
  [`address.test.ts`](src/lib/strk20/address.test.ts) pins the real
  padded/unpadded pair for the account in the transactions below.

  A second fix has no test and is listed here without one: history pruning
  deleted entries whose date it could not read, so it now removes only what it
  can positively identify as expired ([`history.ts`](src/lib/request/history.ts)).

## Milestones

Following [Private Sprint (STRK20)](https://strk20.starknet.io/hackathon), Aug 14–31.

* ✅ **M1** — payment request object, shareable link, shield-to-pay flow
* ✅ **M2** — paid detection + private balance dashboard (viewing key)
* ✅ **M3** — unshield ("withdraw to spend") + pay-by-identifier via Starknet ID
* ✅ **M4** — recurring requests (subscriptions / repeat invoices)
* ✅ **M5** — stretch: public status page per link, no amount and no parties
* ✅ **M6** — stretch: signed receipts anyone can verify
* ✅ **M7** — stretch: split bill — one organiser link, a normal payment link each
* ✅ **M8** — stretch: short bill links, encrypted in the browser (`/b/<id>#<key>`)
* ✅ **M9** — stretch: read a receipt photo into a bill, with tap-to-assign

The v2 plan in [`plans/`](plans/) numbers split bill **M6**, short links **M7**
and receipt scanning **M8**; they are M7-M9 here because M5 and M6 were already
spent on the two stretch milestones above.

## Architecture

**Wallet-based. No custom Cairo contract, nothing deployed by us.** Every pool
operation — deposit, transfer, withdraw — is composed as STRK20 actions and
submitted through the user's own wallet via `strk20InvokeTransaction`.

That is a deliberate integration choice, not a shortcut. The viewing key and the
SNIP-36 proof both belong inside the wallet; a dapp that wanted to touch note
internals would need the user's key on a server, which is the thing this
category exists to avoid. Staying wallet-side means there is no contract of ours
to audit, no privileged key, and nothing to trust beyond the pool itself.

```
src/
  app/
    page.tsx                  create a request
    pay/[id]/                 the payer's view — routing, meter, submit
    dashboard/                shielded balance, your links, receipts
    s/[id]/                   public status page (one bit, self-refreshing)
    verify-receipt/           check a receipt, in the reader's own browser
    api/
      requests/               encode a request into a link
      resolve/                Starknet ID → address
      status/[id]/            report a payment, read status
  lib/
    strk20/plan.ts            routing + correlation detection
    strk20/privacy.ts         the Privacy Risk Meter's wording
    strk20/verify.ts          on-chain check of a reported transaction
    strk20/constants.ts       pool/token config, address normalization
    request/codec.ts          link encode/decode
    request/receipt.ts        SNIP-12 receipt format
    request/schedule.ts       calendar-month recurrence
    request/history.ts        browser-local list of your links
    store/index.ts            status store (Upstash Redis over REST)
    store/record.ts           what a stored record may contain on the way out
```

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind CSS v4 · starknet.js v10.4 ·
get-starknet (Wallet Standard) · STRK20 Privacy Wallet API · Starknet ID ·
Zustand · Upstash Redis

## Run it yourself

```bash
git clone https://github.com/bugsm/whisperpay.git
cd whisperpay
npm install
npm run dev      # http://localhost:3000
npm test         # 89 tests, node:test, no extra dependencies
npm run build    # production build
```

No configuration is required to run it — it defaults to a public mainnet RPC and
an in-memory status store.

For a real deployment, copy `.env.example` to `.env.local`:

| Variable | Needed? | Why |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL` + `_TOKEN` | **yes on serverless** | without it the status store is process memory, and on Vercel the API route and the status page are separate functions with separate memory. `KV_REST_API_*` is read too. |
| `NEXT_PUBLIC_RPC_URL` | recommended | the public default rate-limits, and receipt polling is chatty |
| `NEXT_PUBLIC_APP_URL` | only behind a custom domain | otherwise forwarded headers are used, correct on Vercel out of the box |

To use it against mainnet you need a wallet with STRK20 support —
[Ready](https://www.ready.co/) or [Xverse](https://www.xverse.app/) — switched
to mainnet, and registered with the pool. **Registering and shielding both
happen inside the wallet**: it holds the viewing key, so no dapp can do either
on your behalf.

## Mainnet proof

Five real STRK20 pool transactions, each verified by
[`scripts/strk20-json.mjs`](scripts/strk20-json.mjs) — the same check the
judging panel runs — and recorded in [`strk20.json`](strk20.json). All five are
`ACCEPTED_ON_L1` with 4 pool events each.

No amounts are listed, and that is not an oversight: the pool hides the amount
of a private transfer, so printing it here would give away the one number the
protocol exists to keep. The same goes for the paying account.

| # | Transaction |
| --- | --- |
| 1 | [`0x6f3417cb…557ede`](https://voyager.online/tx/0x6f3417cba37b8f2faa352f4300f561717d80a33eeaf8bbc2e985fa6e1557ede) |
| 2 | [`0x5875580f…fb2ba9`](https://voyager.online/tx/0x5875580f10aec7c0d90fcf531908f14323caad0685842b8515282c0fcfb2ba9) |
| 3 | [`0x568f522b…8c2c4c`](https://voyager.online/tx/0x568f522b9c66714afd2b7f7bbb614ef78749510d49bce015bd16add408c2c4c) |
| 4 | [`0x0420267e…bd4047`](https://voyager.online/tx/0x0420267e047d68dbf9e3bc4dff7a61d443ede396f3bba4878bd9e3a076bd4047) |
| 5 | [`0x05190a7b…36443b`](https://voyager.online/tx/0x05190a7b8bb6e08b5c1aa3fb8f7eb1c8c2387a9df0a209ff05a0d8ff3e36443b) |

Re-check them yourself:

```bash
node scripts/strk20-json.mjs --check
```

## Status, and what's left

M1–M9 are built and running against mainnet. The app is deployed, the five
transactions are verified and recorded.

**Still open before the deadline:**

- [ ] **Demo video (≤3 min)** — the one remaining requirement for scoring.
      `node scripts/strk20-json.mjs --video <url>` records it.
- [ ] **A Redis for the deployment.** Set `KV_REST_API_URL` +
      `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) and redeploy. Without it
      the deployed app falls back to process memory, so a request can report
      `confirmed` from one function while `/s/<id>` still reads "Awaiting
      payment" from another — and short bill links switch themselves off. Paying
      is unaffected either way; it never touches the store.

**Known limits, stated rather than hidden:**

- A status record lives 7 days, and the browser-local list of your links prunes
  on the same schedule. Long-running subscriptions are exempt.
- `submitted` remains in the status type for records written before payments
  settled on verification alone. Nothing writes it now.

## Docs

- [**docs/PRIVACY.md**](docs/PRIVACY.md) — the full accounting of what is and
  isn't hidden, what "received" is and isn't evidence of, and the privacy cost
  of a recurring shield-per-payment cadence.

## Team

- GitHub: [@bugsm](https://github.com/bugsm)
- Telegram: [@genobu](https://t.me/genobu)
