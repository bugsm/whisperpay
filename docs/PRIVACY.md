# What Whisper Pay hides, and what it doesn't

Overclaiming is the fastest way to mislead someone into a disclosure they
didn't sign up for. This document is the precise version.

## The short answer

A payment made **entirely from an existing shielded balance** reveals nothing:
not the amount, not the payer, not the recipient.

A payment that requires **shielding first** publishes one number — the deposit —
tied to one address, the payer's. Everything after that is private.

## The two routes

Whisper Pay picks between them automatically, based on the payer's shielded
balance at the moment they open the link. See `src/lib/strk20/plan.ts`.

### Route 1 — private transfer

The payer already holds enough inside the pool.

```
[ transfer  token · amount · recipient ]
```

One note-to-note transfer. On-chain an observer sees an encrypted note and a
nullifier: no amount, no sender, no recipient. The transaction is submitted by a
rotating shared relayer, so even the transaction's `sender_address` isn't the
payer — it's a relayer with an unrelated nonce.

### Route 2 — shield and transfer, atomically

The payer holds too little, which is the normal case for someone paying a link
for the first time.

```
[ deposit   token · shortfall          ]
[ transfer  token · amount · recipient ]
```

Both actions go to the wallet as a **single STRK20 transaction**. They settle
together or not at all — there's no window where the payer has shielded funds
but the payment hasn't happened.

The `deposit` half is public, and this is inherent to the pool rather than
anything Whisper Pay chose:

| Public | Private |
| --- | --- |
| The payer's address | Who they paid |
| The token | The amount transferred |
| The deposit amount | Which notes were spent |
| The timing | Whether a transfer happened at all |

## The correlation problem

When a payer has *zero* shielded balance, the natural deposit is exactly the
payment amount. That publishes the payment amount, and the timing links it to
the transfer in the same transaction. Someone watching the pool learns "this
address paid 12.5 STRK to someone, now."

Whisper Pay detects this exact case — `revealsAmount` in the payment plan — and
says so on the payment page rather than letting it pass silently. The payer can
round the deposit up to the nearest 10 STRK, which breaks the equality; the
surplus stays in their shielded balance and can be spent on a later payment with
no public trace at all.

Rounding weakens the correlation. It does not eliminate it: a deposit of 20 STRK
followed immediately by a transfer still narrows the amount to "at most 20". The
strongest privacy comes from shielding **ahead of time, in an unremarkable
amount, unlinked in time from any payment** — which Route 1 then uses.

## Recurring requests

A recurring link asks for the same amount every period. It is **not** a standing
authorisation, and the difference is structural rather than a policy choice:
every private transfer is a zero-knowledge proof generated inside the payer's
wallet, so nothing can charge them without their wallet approving it. There is
no key on a server, no cron job, and no way for a recipient to pull funds. The
schedule rides in the link like everything else, so the server still holds no
list of subscriptions.

The repetition itself carries a privacy cost, and it lands on Route 2. A payer
who shields per payment publishes *the same amount, from the same address, at a
regular interval* — a much stronger fingerprint than any single deposit. An
observer who spots the cadence can infer an ongoing relationship and its size,
even though every transfer stays hidden.

Route 1 has no such pattern. So for anything that repeats, shield once, in an
amount that covers several periods, unlinked in time from any payment — each
installment is then a pure note-to-note transfer and the schedule leaves no
public trace at all. Rounding the deposit up helps a single payment; it does not
break a cadence.

Status is tracked per installment (`<id>.<n>`), because one period being paid
says nothing about the next. That means one small record per period instead of
one per request — same fields, no amounts and no addresses, but the count of
records does reveal how many periods have been reported to a configured store.

## Withdrawals

Unshielding is public: the destination address and the amount are visible.
What stays hidden is which deposit the money originally came from. The dashboard
says this on the withdrawal form.

## What the server knows

Whisper Pay's backend is deliberately thin.

- **Payment links carry the whole request.** Creating one writes nothing to a
  database — the recipient, amount and memo are encoded in the URL. There is no
  server-side table of who billed whom.
- **The list of links you created lives in your browser's localStorage**, not on
  the server. Clearing site data clears it.
- **Status is opt-in and minimal.** If a KV store is configured, the server holds
  `{id, status, txHash}` — no amounts, no addresses.
- **The server never sees a viewing key or a private key.** Every pool operation
  goes through the user's wallet via the STRK20 Wallet API.

Whoever hosts the app does see standard web traffic: the fact that an IP opened a
particular payment link, and — because the request is in the URL path — the
contents of that link. Self-host if that matters to you.

## Names are labels, addresses are what get paid

A request can be addressed to `alice.stark` instead of a hex string. The name is
resolved **once, when the link is created**, and the resolved address is what
goes into the link and what the wallet is asked to pay. The name rides along
only as a display label.

This ordering is deliberate. Names are transferable: if the link stored the name
and resolved it at payment time, selling or re-pointing the name would silently
redirect every link ever shared with it. Resolving at creation time means an old
link keeps paying the party it was created for.

The payer page still re-resolves the label and compares it to the address in the
link. If they've diverged, it says so, shows where the name points now, and
stops presenting the name as the recipient — the payer can then check with
whoever sent the link. A network failure during that check reports "unchecked"
rather than a false alarm.

Resolution runs against the Starknet ID naming contract through the app's own
RPC. The public HTTP resolver would work too, but it would tell a third party
which names are being looked up.

## Why "submitted" and "confirmed" are different states

When a payer completes a payment, their browser reports the transaction hash.
The server verifies that hash on-chain: it exists, it succeeded, and the pool
emitted an event in it (`src/lib/strk20/verify.ts`).

That is the *most* anyone can verify from a hash. Because a private transfer
hides its amount and its parties, nobody — not the server, not an observer, not
us — can prove from the chain that a given transaction paid a given request. A
payer could report an unrelated pool transaction and it would verify.

So the request moves to **submitted**, not paid. Only the recipient, looking at
their own shielded balance through their own viewing key, can tell that the money
arrived — and it's their click that moves it to **confirmed**.

The gap between those two states is not a limitation to be engineered away. It
is the privacy guarantee, showing through the product.
