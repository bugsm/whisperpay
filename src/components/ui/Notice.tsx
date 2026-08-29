/**
 * A callout that sits inside a card.
 *
 * Two tones only, and no `error` among them. Anything that failed is reported
 * where it failed, next to the control that caused it — a general-purpose error
 * box invites piling every failure into one corner of the page, far from
 * whatever the reader was doing.
 */
export default function Notice({
  tone,
  title,
  children,
}: {
  tone: "warn" | "info";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        tone === "warn"
          ? "border-amber-400/30 bg-amber-400/5"
          : "border-hairline bg-surface-raised/40"
      }`}
    >
      <p className="text-sm font-medium">{title}</p>
      {/* A div rather than a p — callers put buttons inside this. */}
      <div className="mt-1 text-xs leading-relaxed text-muted">{children}</div>
    </div>
  );
}
