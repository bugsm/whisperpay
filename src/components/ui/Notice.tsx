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
      className={`border-2 p-4 ${
        tone === "warn"
          ? "border-warn/50 bg-warn/10"
          : "border-hairline bg-surface-raised"
      }`}
    >
      <p className="display text-sm">{title}</p>
      {/* A div rather than a p — callers put buttons inside this. */}
      <div className="mt-1 text-xs leading-relaxed text-muted">{children}</div>
    </div>
  );
}
