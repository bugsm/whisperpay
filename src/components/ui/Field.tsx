/**
 * A labelled form control.
 *
 * This is a `<label>`, so the whole block is a click target for the input
 * inside it and no `htmlFor`/`id` pair has to be kept in sync. The catch is
 * that labels can't nest: a control that needs its own label inside a `Field`
 * has to carry `aria-label` instead — see the installment count on the create
 * form.
 */
export default function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="display mb-2 block text-xs tracking-wide text-muted uppercase">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1.5 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}
