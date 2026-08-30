import type { Metadata } from "next";

import CreateBillForm from "@/components/bill/CreateBillForm";
import Card from "@/components/ui/Card";
import { scanConfigured } from "@/lib/ai/credential";
import { getBillStore } from "@/lib/store/blobs";

export const metadata: Metadata = {
  title: "Split a bill — Whisper Pay",
  description:
    "One link per person, each an ordinary private payment request, and one page showing who has paid.",
};

/**
 * Rendered per request, not baked at build time: whether a store is configured
 * is a property of the deployment, and a statically rendered page would keep
 * answering with whatever was true when it was built.
 */
export const dynamic = "force-dynamic";

export default function NewBillPage() {
  return (
    <div className="space-y-10">
      <section>
        <h1 className="display text-3xl text-balance sm:text-4xl">
          One bill. A link each.
        </h1>
        <p className="mt-4 max-w-xl leading-relaxed text-muted">
          You covered the table; now several people owe you different amounts.
          Build the list once and hand each person their own link — they pay
          privately through the pool, and you watch the whole bill from one page.
        </p>
      </section>

      {/*
        Whether the short-link option appears at all is decided here, on the
        server, because only the server can see whether a store is configured.
        Offering it and failing later would hand someone a link that works once.
      */}
      {/*
        Asked of `scanConfigured` rather than read from the environment here:
        the endpoint gates on the same predicate, so the mode cannot be offered
        by this page and then refused by that route. It trims for the reason
        `scanNota` trims — a credential that is nothing but whitespace is truthy
        to a `Boolean` and empty to a header.
      */}
      <CreateBillForm
        canShorten={getBillStore().durable}
        canScan={scanConfigured()}
      />

      <Card>
        <h2 className="display text-sm">What everyone else sees</h2>
        <p className="mt-2.5 text-sm leading-relaxed text-muted">
          Only their own line. A share is turned into a normal payment request
          with its own link, so the person paying sees an amount and a note —
          not the bill, not the other names, not what anyone else owes. The
          whole list lives in the organiser link and is never written to a
          database — though opening that link does send it, like any URL, to
          whoever hosts this app. So it's the one worth keeping, and the one
          worth not posting where everybody can read everybody else's share.
        </p>
      </Card>
    </div>
  );
}
