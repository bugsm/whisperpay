import type { Metadata } from "next";

import ShortBillClient from "./ShortBillClient";

/**
 * The short form of a bill link: `/b/<id>#<key>`.
 *
 * Nothing is rendered on the server, and that is not an implementation detail —
 * the server has never held anything renderable. It stores a ciphertext under
 * `<id>` and the key travels in the fragment, which browsers do not send. So
 * this page is a shell around the client that does the reading.
 */
export const metadata: Metadata = {
  title: "Split bill — Whisper Pay",
  description: "One link per person, and who has paid so far.",
  robots: { index: false, follow: false },
};

export default async function ShortBillPage({ params }: PageProps<"/b/[id]">) {
  const { id } = await params;
  return <ShortBillClient id={id} />;
}
