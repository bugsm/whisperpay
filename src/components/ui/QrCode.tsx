"use client";

import { useMemo } from "react";
import qrcode from "qrcode-generator";

/**
 * A payment link as a QR code.
 *
 * Drawn as one SVG path rather than a grid of rects: a link this long needs a
 * large QR — around 70 modules across — and five thousand DOM nodes per person
 * on a twenty-line bill is not a thing to put on a page.
 *
 * Error correction stays at `L`. The codes here are shown on a screen held in
 * front of another screen, not printed on something that will get wet, and
 * every level above L costs modules that a link this long can't spare.
 *
 * White ground and dark modules regardless of theme, because a scanner needs
 * the contrast the spec assumes — a QR tinted to match the page is a QR that
 * reads slowly or not at all.
 */
export default function QrCode({
  value,
  size = 168,
  title,
}: {
  value: string;
  /** Rendered width in pixels. The module grid scales to fit it. */
  size?: number;
  /** What this code is, for anyone not looking at the screen. */
  title: string;
}) {
  const { path, extent } = useMemo(() => build(value), [value]);

  return (
    <svg
      role="img"
      aria-label={title}
      viewBox={`0 0 ${extent} ${extent}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="border-2 border-hairline bg-white"
    >
      <path d={path} fill="#05040c" />
    </svg>
  );
}

/** Four modules of quiet zone, as the spec asks for. */
const MARGIN = 4;

function build(value: string): { path: string; extent: number } {
  // 0 picks the smallest version that fits, so a short link isn't rendered as a
  // needlessly dense grid.
  const qr = qrcode(0, "L");
  qr.addData(value);
  qr.make();

  const count = qr.getModuleCount();
  let path = "";

  // Horizontal runs, so a solid stretch of modules costs one command instead of
  // one per module.
  for (let row = 0; row < count; row += 1) {
    let start = -1;
    for (let column = 0; column <= count; column += 1) {
      const dark = column < count && qr.isDark(row, column);
      if (dark && start === -1) start = column;
      if (!dark && start !== -1) {
        path += `M${start + MARGIN} ${row + MARGIN}h${column - start}v1h-${column - start}z`;
        start = -1;
      }
    }
  }

  return { path, extent: count + MARGIN * 2 };
}
