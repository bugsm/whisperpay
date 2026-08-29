"use client";

import { useEffect, useState } from "react";

import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import QrCode from "@/components/ui/QrCode";
import { INSET_SURFACE } from "@/components/ui/surfaces";
import type { RequestStatus } from "@/lib/request/types";

/**
 * One line of a bill, as the organiser page needs it.
 *
 * `path` is an ordinary `/pay/<payload>` — the whole point of the design is
 * that there is nothing bill-shaped about it, and the page that opens it has no
 * idea it came from here.
 */
export interface BillRowDto {
  label: string;
  /** What they ordered. */
  memo?: string;
  /** Already formatted for display — the page owns the token's decimals. */
  amount: string;
  path: string;
  status: RequestStatus;
}

export default function BillRows({
  rows,
  title,
  symbol,
  total,
}: {
  rows: BillRowDto[];
  title?: string;
  symbol: string;
  total: string;
}) {
  // `window` only exists after mount, and every link on this page is absolute,
  // so nothing here can be rendered on the server without a hydration mismatch.
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [showing, setShowing] = useState<number | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrigin(window.location.origin);
  }, []);

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* a browser that refuses the clipboard still shows the link in its QR */
    }
  }

  /**
   * Every line as one block of text, ready to paste into the group chat the
   * bill came from. Names and links stay adjacent so nobody has to work out
   * which link is theirs — that mistake costs someone else's money.
   */
  function copyAll() {
    const lines = [
      title ? `${title} — ${total} ${symbol} total` : `${total} ${symbol} total`,
      "",
      ...rows.flatMap((row) => [
        `${row.label}${row.memo ? ` — ${row.memo}` : ""} · ${row.amount} ${symbol}`,
        `${origin}${row.path}`,
        "",
      ]),
    ];
    void copy(lines.join("\n").trimEnd(), "all");
  }

  return (
    <>
      <ul className="mt-4 divide-y-2 divide-hairline border-t-2 border-hairline">
        {rows.map((row, index) => (
          <li key={index} className="py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1">
                <p className="display text-sm">
                  {row.label}
                  {row.memo ? (
                    <span className="ml-2 font-sans text-xs text-muted">
                      {row.memo}
                    </span>
                  ) : null}
                </p>
              </div>

              <p className="tabular shrink-0 text-sm">
                {row.amount}{" "}
                <span className="text-xs text-muted">{symbol}</span>
              </p>

              <Badge status={row.status} />

              <div className="flex shrink-0 gap-1.5">
                <Button
                  size="sm"
                  title={`Copy ${row.label}'s payment link`}
                  // Gated on the same mount effect the QR and "copy all" are:
                  // before it runs there is no origin, and the link would go to
                  // the clipboard as a bare path with no host.
                  disabled={origin === ""}
                  onClick={() => void copy(`${origin}${row.path}`, String(index))}
                >
                  {copied === String(index) ? "Copied" : "Copy"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={showing === index}
                  title={`Show ${row.label}'s link as a QR code`}
                  onClick={() => setShowing(showing === index ? null : index)}
                >
                  QR
                </Button>
              </div>
            </div>

            {showing === index && origin ? (
              <div className={`${INSET_SURFACE} mt-3 flex flex-col items-center gap-3 p-4`}>
                <QrCode
                  value={`${origin}${row.path}`}
                  title={`Payment link for ${row.label}`}
                />
                <p className="text-center text-xs leading-relaxed text-muted">
                  Point {row.label}'s phone at this. It opens the same link as
                  the Copy button — hand it over either way.
                </p>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="mt-5 flex flex-wrap gap-3">
        <Button variant="primary" onClick={copyAll} disabled={origin === ""}>
          {copied === "all" ? "Copied every line" : "Copy all lines"}
        </Button>
      </div>
    </>
  );
}
