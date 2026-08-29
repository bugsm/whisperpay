import Link from "next/link";

import CreateRequestForm from "@/components/CreateRequestForm";
import Card from "@/components/ui/Card";

const STEPS = [
  {
    step: "01",
    title: "Create",
    body: "Pick an amount and get a link. The request is encoded in the link itself — no account, no database.",
  },
  {
    step: "02",
    title: "Pay",
    body: "The payer connects a wallet and approves once. If they hold no shielded balance, Whisper Pay shields and pays in a single atomic transaction.",
  },
  {
    step: "03",
    title: "Receive",
    body: "The payment lands in your shielded balance. You can hold it privately or withdraw to a public address.",
  },
];

export default function Home() {
  return (
    <div className="space-y-10">
      <section>
        <h1 className="display text-3xl text-balance sm:text-4xl">
          One link. The payment stays private.
        </h1>
        <p className="mt-4 max-w-xl leading-relaxed text-muted">
          Share a link the way you'd share any payment request. The payer pays
          through the STRK20 privacy pool on Starknet mainnet, so the amount and
          the parties don't end up in public view.
        </p>
      </section>

      <CreateRequestForm />

      <p className="text-sm text-muted">
        Several people owing different amounts?{" "}
        <Link href="/bill" className="text-accent underline underline-offset-4">
          Split a bill
        </Link>{" "}
        — one line each, one page showing who has paid.
      </p>

      {/*
        One hairline grid drawn as gaps between opaque tiles, so the dividers
        stay exactly 2px whatever the tiles do on hover.
      */}
      <section className="grid gap-0.5 border-2 border-hairline bg-hairline shadow-hard sm:grid-cols-3">
        {STEPS.map((item) => (
          <div
            key={item.step}
            className="bg-background p-5 transition-colors duration-75 hover:bg-surface"
          >
            <span className="display text-xs text-accent">{item.step}</span>
            <h2 className="display mt-2 text-base">{item.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">{item.body}</p>
          </div>
        ))}
      </section>

      <Card>
        <h2 className="display text-sm">What's private, and what isn't</h2>
        <p className="mt-2.5 text-sm leading-relaxed text-muted">
          Note-to-note transfers inside the pool hide amounts and parties.
          Shielding does not: a deposit publicly shows the depositor, the token
          and the amount. When a payer has to shield in order to pay, Whisper Pay
          says so on the payment page and offers to round the deposit up so the
          public number isn't the payment.
        </p>
      </Card>
    </div>
  );
}
