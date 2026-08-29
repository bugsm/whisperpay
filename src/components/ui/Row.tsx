/**
 * A label/value line inside a `<dl>`.
 *
 * The most-copied piece in the app — nineteen call sites across the payer view
 * and the status page, from two identical local definitions.
 *
 * `items-baseline` rather than `items-center` is the part worth keeping: values
 * here are often a large tabular number next to small label text, and aligning
 * their baselines is what stops the number from looking like it sits too high.
 */
export default function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
