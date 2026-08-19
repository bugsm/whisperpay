import type { Metadata } from "next";

import VerifyClient from "./VerifyClient";

/**
 * Checking someone else's receipt.
 *
 * Deliberately readable by anyone with no wallet, no account and no connection
 * to Whisper Pay — an accountant handed a JSON file is the whole use case. The
 * receipt travels in the link or the paste, so this page holds nothing and
 * looks nothing up.
 */
export const metadata: Metadata = {
  title: "Check a receipt — Whisper Pay",
  description:
    "Verify that a Whisper Pay receipt was signed by the account it claims. Not a proof of payment.",
  robots: { index: false, follow: false },
};

export default async function VerifyReceiptPage({
  searchParams,
}: {
  searchParams: Promise<{ r?: string | string[] }>;
}) {
  const { r } = await searchParams;
  const encoded = typeof r === "string" ? r : undefined;

  return <VerifyClient encoded={encoded} />;
}
