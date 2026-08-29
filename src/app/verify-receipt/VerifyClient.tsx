"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import {
  RECEIPT_CLAIM,
  parseReceipt,
  receiptTypedData,
  decodeReceipt,
  type Receipt,
} from "@/lib/request/receipt";
import { CARD_SURFACE } from "@/components/ui/surfaces";
import { mainnetProvider } from "@/lib/strk20/provider";
import { verifyMessageInStarknet } from "starknet";

/**
 * Checking a signed receipt, and being straight about what checking it means.
 *
 * Verification runs here, in the reader's own browser, against the account
 * contract on mainnet — no Whisper Pay server is consulted and none could
 * change the answer. That matters for a receipt: an artifact you have to ask us
 * to vouch for would be worth as much as our word, which is not the point.
 */
type Outcome =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "malformed" }
  | { state: "verified"; receipt: Receipt }
  | { state: "rejected"; receipt: Receipt }
  | { state: "unreachable"; receipt: Receipt };

export default function VerifyClient({ encoded }: { encoded?: string }) {
  const [input, setInput] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ state: "idle" });

  const check = useCallback(async (receipt: Receipt) => {
    setOutcome({ state: "checking" });
    try {
      const valid = await verifyMessageInStarknet(
        mainnetProvider,
        receiptTypedData(receipt.request, receipt.issuedAt),
        receipt.signature,
        receipt.recipient
      );
      setOutcome({ state: valid ? "verified" : "rejected", receipt });
    } catch {
      // An account that isn't deployed has no `is_valid_signature` to call, and
      // an RPC that's down looks identical from here. Neither is a verdict, so
      // neither is reported as one.
      setOutcome({ state: "unreachable", receipt });
    }
  }, []);

  // A receipt handed over as a link verifies itself on arrival.
  useEffect(() => {
    if (!encoded) return;
    const receipt = decodeReceipt(encoded);
    if (!receipt) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOutcome({ state: "malformed" });
      return;
    }
    void check(receipt);
  }, [encoded, check]);

  function checkPasted() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      setOutcome({ state: "malformed" });
      return;
    }
    const receipt = parseReceipt(parsed);
    if (!receipt) {
      setOutcome({ state: "malformed" });
      return;
    }
    void check(receipt);
  }

  return (
    <div className="space-y-5">
      <section className={CARD_SURFACE}>
        <h1 className="text-lg font-semibold">Check a signed receipt</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Paste a receipt below, or open the link its issuer gave you. The
          signature is checked against the recipient's account contract on
          Starknet mainnet, from your browser — Whisper Pay isn't asked, and
          couldn't change the answer if it were.
        </p>

        {!encoded ? (
          <>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              rows={8}
              spellCheck={false}
              placeholder='{ "version": 1, "request": "…", "claim": "Request paid in full", … }'
              className="mt-4 w-full rounded-xl border border-hairline bg-surface-raised/40 p-3 font-mono text-xs outline-none focus:border-accent/60"
            />
            <button
              type="button"
              onClick={checkPasted}
              disabled={input.trim() === "" || outcome.state === "checking"}
              className="mt-3 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-[#14101f] transition hover:brightness-110 disabled:opacity-50"
            >
              {outcome.state === "checking" ? "Checking…" : "Check this receipt"}
            </button>
          </>
        ) : null}

        <Result outcome={outcome} />
      </section>

      <section className={CARD_SURFACE}>
        <h2 className="text-sm font-semibold">What a receipt does and doesn't show</h2>

        <p className="mt-3 text-sm leading-relaxed text-muted">
          <strong className="font-medium text-foreground">What it shows:</strong>{" "}
          that whoever holds the key to that Starknet account signed the sentence
          "{RECEIPT_CLAIM}" about that request id, at that time. They can't
          later deny signing it. It's the trust model of a signed paper receipt.
        </p>

        <p className="mt-3 text-sm leading-relaxed text-muted">
          <strong className="font-medium text-foreground">
            What it does not show:
          </strong>{" "}
          it is not a cryptographic proof that money moved, and not a
          zero-knowledge proof of anything. It doesn't say <em>who</em> paid —
          the privacy pool hides the sender from everyone, the recipient
          included — and it deliberately doesn't say <em>how much</em>, because
          the amount is left out of the signed message rather than merely hidden
          from display. Nobody, including us, can verify the payment itself
          against this.
        </p>

        <p className="mt-3 text-sm leading-relaxed text-muted">
          <strong className="font-medium text-foreground">
            When not to rely on it:
          </strong>{" "}
          a dispute. The recipient is the one signing, so in any disagreement
          about whether they were paid, they simply won't issue a receipt that
          hurts their case. This is for cooperative use — showing an accountant
          or a client that a request was fulfilled.
        </p>

        <Link
          href="/"
          className="mt-4 inline-block rounded-xl border border-hairline px-4 py-2 text-sm transition hover:bg-surface-raised"
        >
          What is Whisper Pay?
        </Link>
      </section>
    </div>
  );
}

function Result({ outcome }: { outcome: Outcome }) {
  if (outcome.state === "idle") return null;

  if (outcome.state === "checking") {
    return (
      <p className="mt-5 border-t border-hairline pt-4 text-sm text-muted">
        Checking the signature against the account contract…
      </p>
    );
  }

  if (outcome.state === "malformed") {
    return (
      <div className="mt-5 border-t border-hairline pt-4">
        <p className="text-sm font-semibold text-amber-300">
          That isn't a Whisper Pay receipt
        </p>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          It couldn't be read as one — wrong shape, altered claim, or damaged in
          copying. Nothing was checked, so this says nothing either way about
          the payment it may have referred to.
        </p>
      </div>
    );
  }

  const { receipt } = outcome;

  return (
    <div className="mt-5 border-t border-hairline pt-4">
      {outcome.state === "verified" ? (
        <p className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
          <span className="flex size-6 items-center justify-center rounded-full bg-emerald-400/15 text-xs">
            ✓
          </span>
          Signature verified
        </p>
      ) : outcome.state === "rejected" ? (
        <p className="flex items-center gap-2 text-sm font-semibold text-amber-300">
          <span className="flex size-6 items-center justify-center rounded-full bg-amber-400/15 text-xs">
            ✕
          </span>
          Signature not valid for that account
        </p>
      ) : (
        <p className="text-sm font-semibold text-amber-300">
          Couldn't reach the account contract
        </p>
      )}

      <p className="mt-2 text-sm leading-relaxed text-muted">
        {outcome.state === "verified"
          ? `The holder of this account's key asserted "${receipt.claim}" about request ${receipt.request}. Read the section below for what that is and isn't worth.`
          : outcome.state === "rejected"
            ? "The account didn't accept this signature. The receipt may have been edited after signing, or it may never have been signed by this account at all."
            : "The account contract couldn't be called — it may not be deployed on mainnet, or the RPC may be unavailable. This is not a verdict on the receipt; try again."}
      </p>

      <dl className="mt-4 space-y-2 text-sm">
        <Row label="Request">
          <span className="font-mono text-xs">{receipt.request}</span>
        </Row>
        <Row label="Claim">{receipt.claim}</Row>
        <Row label="Issued">
          {new Date(receipt.issuedAt * 1000).toLocaleString("en-GB", {
            timeZone: "UTC",
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}{" "}
          UTC
        </Row>
        <Row label="Signed by">
          <span className="font-mono text-xs break-all">{receipt.recipient}</span>
        </Row>
        <Row label="Amount">
          <span className="text-muted">not part of this receipt</span>
        </Row>
        <Row label="Payer">
          <span className="text-muted">never knowable — the pool hides it</span>
        </Row>
      </dl>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-right">{children}</dd>
    </div>
  );
}
