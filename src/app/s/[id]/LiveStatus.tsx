"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeping the status page current without anyone reloading it.
 *
 * The page is a server component, and everything it renders — the headline, the
 * dot, each period of a subscription — comes from one store read. Rather than
 * duplicating that rendering on the client to patch a badge, this asks the
 * router to re-run the page: `dynamic = "force-dynamic"` means the refresh is a
 * genuine re-read, and React reconciles the result without losing scroll
 * position.
 *
 * Refreshing stops once the status is settled, because `confirmed` is terminal
 * — a status page for a paid request would otherwise poll a server forever on
 * whatever machine left the tab open.
 */
const POLL_MS = 15_000;

export default function LiveStatus({ settled }: { settled: boolean }) {
  const router = useRouter();
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  useEffect(() => {
    if (settled) return;

    function poll() {
      // A background tab that no one is reading doesn't need the freshest
      // answer; it gets one as soon as it's looked at again.
      if (document.visibilityState !== "visible") return;
      router.refresh();
      setCheckedAt(Date.now());
    }

    const timer = setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", poll);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [settled, router]);

  if (settled) return null;

  return (
    <p className="mt-4 text-xs text-muted">
      This page updates itself — leave it open.
      {checkedAt === null ? null : (
        // Rendered only after a refresh, so the server and the client never
        // disagree about the time on first paint.
        <span suppressHydrationWarning>
          {" "}
          Last checked{" "}
          {new Date(checkedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
          .
        </span>
      )}
    </p>
  );
}
