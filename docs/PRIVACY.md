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
- **Status is minimal.** Where a Redis is configured, the server holds
  `{id, status, submittedAt?, confirmedAt?}` — no amounts, no addresses, and
  **not the transaction hash**. The hash is verified when it's reported and then
  discarded: for a payer who shielded in order to pay, it leads straight to a
  public deposit carrying their address, so storing it against a request id
  would rebuild exactly the link the pool exists to break. Status is readable by
  anyone holding the id, which is the other half of the reason.
- **A split bill adds no server state.** The organiser link carries every name
  and every share in the URL, exactly as a single request does. Each line is
  derived into an ordinary payment request, so what the store holds is the same
  `{id, status, timestamps}` per line and nothing tying the lines together — the
  "3 of 8 paid" count on the bill page is computed from those records while it
  renders, and never written anywhere.
- **A short-linked bill is stored, and stored encrypted.** Choosing the short
  link is one of the two actions in this app that put something of yours on the
  server. What lands there is a ciphertext it has no key for — see the section
  below.
- **A receipt photo is read and dropped.** It is sent to the model that reads
  it and is never written anywhere — see the section below.
- **Scanning a receipt counts you for ten minutes, without recording who you
  are.** That is the other one. The scan endpoint is the only one here that
  costs money to answer, so it is rate-limited per caller — but what reaches
  the store is a salted digest of your address rather than the address, and the
  window is folded into it, so the same person digests to something different
  ten minutes later. Nothing reads the value back; it exists to be counted
  against. What that leaves in Redis is a number under an opaque key, expiring
  within seconds of its window — not the photo, not the bill, and nothing that
  links two requests across windows. `RATELIMIT_SALT` is what makes the digest
  irreversible: without it set, an address can be recovered by hashing the 2^32
  IPv4 space, so a deployment that leaves it unset is storing something
  obfuscated rather than something private, and the app says so in its log.
  Scanning is opt-in; the other two ways of building a bill write nothing.
- **The server never sees a viewing key or a private key.** Every pool operation
  goes through the user's wallet via the STRK20 Wallet API.

Whoever hosts the app does see standard web traffic: the fact that an IP opened a
particular payment link, and — because the request is in the URL path — the
contents of that link. Self-host if that matters to you.

A bill link raises the stakes of that last point, so it is worth saying plainly:
opening `/bill/<payload>` shows the host the whole list — every name, every
share, and the fact that these people ate together. A payer opening their own
`/pay/<payload>` link reveals only their own line, which is why the organiser
link is the one to be careful with.

## Short bill links

A bill link carries every line in its own URL, which is what keeps it free of
the server — and what makes it long enough that some chat apps cut it in half.
The short link is the opt-in answer, and it is worth being exact about what it
changes.

`/b/<id>#<key>`. The bill is encrypted **in your browser** with a fresh
AES-GCM-256 key and a fresh 12-byte IV; the ciphertext is posted and stored
under a random id; the key is put after the `#`. A URL fragment is never
transmitted to a server — that is a property of HTTP, not a promise this app is
making — so the key reaches nobody but the people you send the link to.

What the server holds is therefore bytes with no key: the id, a ciphertext, an
IV, and an expiry. It does not know how many people are on the bill, what they
owe, who they are, or that the blob is a bill at all. The route that stores it
never parses it, and there is no decryption path in the server to add one to.

Three limits, all of them consequences rather than caveats:

- **A short link can die.** It lives `min(expiresAt, 30 days)`, and it is gone
  if the store is ever lost. The full `/bill/<payload>` link cannot die, which
  is why it stays the default and this is offered as an extra.
- **The option disappears without a store.** Where no Redis is configured, the
  app does not offer a short link and the endpoint refuses to mint one, rather
  than handing you a link that works once.
- **Whoever holds the whole link can read the bill.** The key is in it. That is
  the same standing as the full link — the difference is only where the bytes
  live, not who can read them.

## Scanning a receipt

Building a bill from a photo sends that photo to a model, which reads it and
returns a list of items and amounts. That is a real disclosure and worth stating
plainly rather than burying: a receipt carries a place, a time, what was
ordered, and often the last four digits of a card.

**Which model, and whose servers, is a deployment's choice.** By default it is
Anthropic's API. A deployment that sets `ANTHROPIC_BASE_URL` sends the photo to
that host instead — a gateway, a router, a proxy — and everything below still
holds of *this* app while none of it says anything about what that operator
does with what it receives. Their retention and training policy governs from
that point on, not this document. If you are reading this to decide whether to
photograph a receipt, the honest answer is that you also need to know who is
running the deployment and where they pointed it.

What happens to it here:

- **It is never stored.** Not written to disk, not put in the Redis above, not
  logged, and not included in any error message. It exists for the length of one
  request. There is no code path that keeps it, which is a stronger statement
  than a policy that says it is deleted.
- **The request that carried it is counted, though.** The photo stays out of the
  Redis above; a rate-limit counter does not, and lives there for ten minutes.
  It is keyed by a salted digest of your address rather than the address itself,
  and it rotates with the window — but saying the image is never stored while
  staying quiet about the counter would be true by the letter and misleading in
  the way that matters, so it is spelled out under *What the server knows*.
- **It is never linked to a bill.** The scan and the link-minting are separate
  steps; nothing associates the image with the bill that comes out of it,
  because nothing holds the image at all.
- **It is opt-in and per-bill.** Nothing is scanned unless someone chooses the
  receipt mode and picks a photo. The other two ways of building a bill send
  nothing anywhere.
- **The feature can be switched off entirely.** With neither
  `ANTHROPIC_API_KEY` nor `ANTHROPIC_AUTH_TOKEN` set, the option does not
  appear and the endpoint refuses. A deployment that would rather not send
  photos to anyone simply doesn't set a credential.

The exchange rate used to convert a receipt into STRK comes from a public price
API. A price is nobody's personal data, and the request carries nothing about
the bill — only which currency to quote.

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

## The public status page

A payment link cannot double as proof of payment. It *is* the invoice — the
amount, the recipient and the note are all encoded in it, so handing it to an
accountant, a client's finance team, or a public page hands them everything.

`/s/<id>` exists to be shared instead. It is addressed by the request id alone,
and an id is 72 random bits that describe nothing: no amount, no token, neither
party, no note. What a reader learns is one fact per period — unpaid or
received — and the date it changed.

That page can only be this thin because the record behind it is. Since the
server never stores the transaction hash, there is nothing on the page to
redact and nothing at the API next door to leak — `/api/status/<id>` returns
the same fields to anyone holding the same id.

Two smaller choices follow from the same reasoning:

- **Dates are shown to the day, in UTC.** A precise timestamp would narrow a
  private transfer to the handful of pool transactions in that second, which is
  a strange thing to publish on a page whose point is publishing almost nothing.
- **The page is `noindex`.** Status links are meant to be handed to someone, not
  crawled into a search index where ids become discoverable.

A recurring request carries its schedule in the URL's `s` parameter, so the page
can say "payment 3 of 12" and list recent periods. That parameter reveals
cadence and length — worth knowing before you share one — and still nothing
about amount or parties.

## What "received" is, and isn't

When a payer completes a payment, their browser reports the transaction hash.
The server verifies that hash on-chain: it exists, it succeeded, and the pool
emitted an event in it (`src/lib/strk20/verify.ts`). That moves the request to
**received**.

Be exact about what that establishes, because it is less than the word suggests.
A verified hash proves *a* successful pool transaction happened. It does not
prove that transaction paid *this* request — a private transfer hides its amount
and its parties, so nobody, us included, can tie one to the other. A payer could
report an unrelated pool transaction and it would verify just the same.

Treating a verified hash as settlement is a deliberate trade: it costs the
recipient no clicks, and the alternative — an intermediate "submitted" state
waiting on the recipient to confirm — turned out to strand payments whenever
that person never opened the app. What it buys in convenience it gives up in
precision, and the status page says so to whoever reads it.

The one source of certainty is unchanged, and it isn't here: the recipient,
looking at their own shielded balance through their own viewing key. That is the
privacy guarantee showing through the product — the reason this page reports a
verified payment rather than a proven one.

Since the hash proves so little and reveals so much, it isn't kept: verification
happens at the moment it's reported, and what survives is that *a* verified pool
transaction was reported, and when. `src/lib/request/status-privacy.test.ts`
fails the build if that stops being true.
