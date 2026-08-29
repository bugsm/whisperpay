import type { Metadata } from "next";
import Link from "next/link";

import { CARD_SURFACE } from "@/components/ui/surfaces";
import PayClient, { type PayRequestDto } from "@/components/pay/PayClient";
import { verifyNameStillResolves, type NameCheck } from "@/lib/identity/starknetid";
import { decodeRequest, RequestDecodeError } from "@/lib/request/codec";

/**
 * Link previews stay deliberately generic.
 *
 * Chat apps and link scrapers fetch this page and cache what they find. Putting
 * the amount or the recipient in the metadata would hand those intermediaries
 * the very details the pool exists to keep private, so the preview says nothing
 * the URL doesn't already say.
 */
export const metadata: Metadata = {
  title: "Payment request — Whisper Pay",
  description: "Open this link to pay privately on Starknet.",
  robots: { index: false, follow: false },
};

export default async function PayPage({ params }: PageProps<"/pay/[id]">) {
  const { id } = await params;

  let dto: PayRequestDto;
  let nameCheck: NameCheck | null = null;
  try {
    const request = decodeRequest(id);
    dto = {
      id: request.id,
      recipient: request.recipient,
      recipientName: request.recipientName,
      token: request.token,
      // bigint doesn't survive the server→client boundary; the client parses it back.
      amount: request.amount.toString(),
      memo: request.memo,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      // Which installment is due depends on the clock, so it's worked out in
      // the browser after mount — the server's `now` and the payer's would
      // disagree and break hydration.
      schedule: request.schedule,
    };

    // Confirm the label still points where it did when the link was made. Done
    // here rather than in the browser so the payer doesn't need their own RPC.
    if (request.recipientName) {
      nameCheck = await verifyNameStillResolves(
        request.recipientName,
        request.recipient
      );
    }
  } catch (error) {
    return (
      <section className={CARD_SURFACE}>
        <h1 className="text-lg font-semibold">This payment link isn't valid</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {error instanceof RequestDecodeError
            ? error.message
            : "The link couldn't be read."}{" "}
          It may have been truncated when it was shared — links are long, and
          some chat apps cut them.
        </p>
        <Link
          href="/"
          className="mt-5 inline-block rounded-xl border border-hairline px-4 py-2 text-sm transition hover:bg-surface-raised"
        >
          Create a request instead
        </Link>
      </section>
    );
  }

  return <PayClient request={dto} nameCheck={nameCheck} />;
}
