/**
 * One option in a row of mutually exclusive presets — "Weekly", "7 days".
 *
 * Selection is carried by fill *and* border *and* `aria-pressed`, not by colour
 * alone. On the create form these rows set what a link will ask for and how
 * long it stays valid, so "which one is on" has to survive a reader who can't
 * separate the accent from the hairline.
 */
export default function Choice({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`pixel-press display border-2 px-3 py-1.5 text-xs ${
        selected
          ? "border-accent bg-accent-soft text-foreground shadow-hard-sm"
          : "border-hairline text-muted hover:border-accent hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
