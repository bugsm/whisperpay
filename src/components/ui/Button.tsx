export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "border-accent bg-accent text-accent-ink shadow-hard-sm hover:brightness-110",
  secondary:
    "border-hairline bg-surface-raised text-foreground shadow-hard-sm hover:border-accent",
  ghost: "border-hairline bg-transparent text-muted hover:text-foreground",
};

/**
 * Sizes are set by padding, not height, so a control still grows to fit its
 * label. `sm` is the one to watch: 44px of touch target comes from the padding
 * plus the line box, and trimming either takes it under.
 */
const SIZE: Record<ButtonSize, string> = {
  sm: "px-3 py-2 text-xs",
  md: "px-4 py-2.5 text-sm",
  lg: "px-4 py-3 text-sm",
};

/**
 * The button surface as a class string, for the anchors and `Link`s that have
 * to look like buttons without being one. Same reasoning as `CARD_SURFACE`:
 * a component can't be a `<a>`, and faking one with a click handler would cost
 * the reader middle-click, right-click and the status bar.
 */
export function buttonClass(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md"
): string {
  return `pixel-press inline-flex items-center justify-center border-2 font-medium disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none ${VARIANT[variant]} ${SIZE[size]}`;
}

/**
 * A control that physically depresses.
 *
 * The press is `.pixel-press` in globals.css rather than a Tailwind transition,
 * because it moves the button onto its own shadow — the translate and the
 * `shadow-hard-sm` offset are sized against each other, and splitting them
 * across two files is how they end up disagreeing.
 */
export default function Button({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...props
}: React.ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      type={type}
      className={`${buttonClass(variant, size)} ${className}`}
      {...props}
    />
  );
}
