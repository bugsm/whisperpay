"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import type { BillRowDto } from "@/components/bill/BillRows";
import BillView from "@/components/bill/BillView";
import { buttonClass } from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { formatDisplay } from "@/lib/amount";
import { BillDecodeError, decodeBill } from "@/lib/bill/codec";
import { BillCryptoError, decryptBill, importBillKey } from "@/lib/bill/crypto";
import { sharePath, shareStatusId } from "@/lib/bill/share";
import { rowStatus } from "@/lib/bill/status";
import { billTotal, type SplitBill } from "@/lib/bill/types";
import { isExpired, type RequestStatus } from "@/lib/request/types";
import { readRouteBody, routeErrorMessage } from "@/lib/routeError";
import { DEFAULT_TOKEN, findToken } from "@/lib/strk20/constants";

/**
 * The short link, opened.
 *
 * Everything that matters happens in this file rather than on the server, and
 * that is the design: the key sits in the URL fragment, which the browser does
 * not transmit, so the only place the bill can be reassembled is here. The
 * server's part is to hand back bytes it cannot read.
 *
 * The consequence is that this page has more ways to fail than a stateless one,
 * and each of them has to arrive as a sentence. A blank screen is the one
 * unacceptable outcome — the reader is holding a link someone sent them and
 * needs to know whether to ask for it again.
 */
const POLL_MS = 15_000;

type Load =
  | { state: "loading" }
  | { state: "failed"; title: string; detail: string }
  | { state: "ready"; bill: SplitBill };

export default function ShortBillClient({ id }: { id: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [statuses, setStatuses] = useState<Record<string, RequestStatus>>({});
  const [durable, setDurable] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function open() {
      // The key never leaves this line. It is not logged, not put in state, and
      // not sent anywhere — it only exists long enough to decrypt.
      const fragment = window.location.hash.replace(/^#/, "");
      if (fragment === "") {
        return {
          state: "failed" as const,
          title: "This link is missing its key",
          detail:
            "The part after the # is what decrypts the bill, and it isn't here. Chat apps often cut a link at the #, so ask whoever sent it to send the whole thing — or to send you the full bill link instead.",
        };
      }

      let response: Response;
      try {
        response = await fetch(`/api/bills/${encodeURIComponent(id)}`);
      } catch {
        return {
          state: "failed" as const,
          title: "Couldn't reach the server",
          detail:
            "The bill itself is fine — this link just needs the server to hand back the stored copy. Check your connection and reload.",
        };
      }

      if (!response.ok) {
        const body = await readRouteBody(response);
        return {
          state: "failed" as const,
          title:
            response.status === 404
              ? "This short link has expired"
              : "This short link couldn't be opened",
          detail:
            routeErrorMessage(body) ??
            "A short link is stored for a limited time. The full bill link never expires — ask whoever sent this for that one.",
        };
      }

      // Inside the try with everything else: a 200 carrying something other
      // than JSON — a proxy interstitial, a service worker — would otherwise
      // reject here with nothing to catch it, and the page would sit on
      // "Opening the bill…" forever. That is the one outcome this file exists
      // to avoid.
      try {
        const sealed = (await response.json()) as {
          ciphertext: string;
          iv: string;
        };
        const key = await importBillKey(fragment);
        const payload = await decryptBill(sealed, key);
        return { state: "ready" as const, bill: decodeBill(payload) };
      } catch (error) {
        return {
          state: "failed" as const,
          title: "This bill couldn't be read",
          detail:
            error instanceof BillCryptoError || error instanceof BillDecodeError
              ? error.message
              : "The stored bill didn't decrypt to anything this version understands.",
        };
      }
    }

    void open()
      .catch(() => ({
        state: "failed" as const,
        title: "This bill couldn't be opened",
        detail:
          "Something went wrong reading this link in your browser. Reloading is worth a try; if it keeps happening, ask whoever sent it for the full bill link.",
      }))
      .then((result) => {
        if (!cancelled) setLoad(result);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  const bill = load.state === "ready" ? load.bill : null;

  // Status lives on the server keyed by each line's derived id, so it can't
  // come out of the payload — it is read here, in one batched call, and
  // refreshed while the tab is being looked at. Same shape as the dashboard's
  // poll, including reading again the moment the tab is looked at rather than
  // making someone wait out an interval.
  useEffect(() => {
    if (!bill) return;
    const ids = bill.shares.map((_, index) => shareStatusId(bill.id, index));

    async function read() {
      try {
        const response = await fetch(`/api/status?ids=${ids.join(",")}`);
        if (!response.ok) return;
        const body = (await response.json()) as {
          durable: boolean;
          records: { id: string; status: RequestStatus }[];
        };
        setDurable(body.durable);
        setStatuses(
          Object.fromEntries(body.records.map((record) => [record.id, record.status]))
        );
      } catch {
        /* leave the badges as they were */
      }
    }

    const tick = () => {
      if (document.visibilityState === "visible") void read();
    };

    void read();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [bill]);

  if (load.state === "loading") {
    return (
      <Card>
        <h1 className="display text-lg">Opening the bill…</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Fetching the encrypted copy and decrypting it here, in this browser.
        </p>
      </Card>
    );
  }

  if (load.state === "failed") {
    return (
      <Card>
        <h1 className="display text-lg">{load.title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">{load.detail}</p>
        <Link href="/bill" className={`${buttonClass()} mt-5`}>
          Build a new bill
        </Link>
      </Card>
    );
  }

  const token = findToken(load.bill.token) ?? DEFAULT_TOKEN;
  const expired = isExpired(load.bill);
  const rows: BillRowDto[] = load.bill.shares.map((share, index) => ({
    label: share.label,
    memo: share.memo,
    amount: formatDisplay(share.amount, token.decimals),
    path: sharePath(load.bill, index),
    status: rowStatus(statuses[shareStatusId(load.bill.id, index)], expired),
  }));

  return (
    <BillView
      title={load.bill.title}
      recipientLabel={load.bill.recipientName ?? load.bill.recipient}
      symbol={token.symbol}
      total={formatDisplay(billTotal(load.bill.shares), token.decimals)}
      rows={rows}
      expiresAt={load.bill.expiresAt}
      expired={expired}
      durable={durable}
      quote={load.bill.quote}
      totalUnits={billTotal(load.bill.shares).toString()}
      variant="short"
    >
      {rows.every((row) => row.status === "confirmed") ? null : (
        <p className="mt-4 text-xs text-muted">
          This page updates itself — leave it open.
        </p>
      )}
    </BillView>
  );
}
