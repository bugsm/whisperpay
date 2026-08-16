import CreateRequestForm from "@/components/CreateRequestForm";

export default function Home() {
  return (
    <div className="space-y-10">
      <section>
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          One link. The payment stays private.
        </h1>
        <p className="mt-3 max-w-xl leading-relaxed text-muted">
          Share a link the way you'd share any payment request. The payer pays
          through the STRK20 privacy pool on Starknet mainnet, so the amount and
          the parties don't end up in public view.
        </p>
      </section>

      <CreateRequestForm />

      <section className="grid gap-px overflow-hidden rounded-2xl border border-hairline bg-hairline sm:grid-cols-3">
        {[
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
        ].map((item) => (
          <div key={item.step} className="bg-background p-5">
            <span className="font-mono text-xs text-accent">{item.step}</span>
            <h3 className="mt-2 font-medium">{item.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{item.body}</p>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-hairline bg-surface p-5">
        <h2 className="text-sm font-semibold">What's private, and what isn't</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Note-to-note transfers inside the pool hide amounts and parties.
          Shielding does not: a deposit publicly shows the depositor, the token
          and the amount. When a payer has to shield in order to pay, Whisper Pay
          says so on the payment page and offers to round the deposit up so the
          public number isn't the payment.
        </p>
      </section>
    </div>
  );
}
