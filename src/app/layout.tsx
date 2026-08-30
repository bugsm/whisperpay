import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono, Pixelify_Sans } from "next/font/google";

import ConnectWallet from "@/components/wallet/ConnectWallet";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

/**
 * The display face, for headings and labels only.
 *
 * Body copy stays in Geist and amounts stay in Geist Mono. That split isn't a
 * compromise on the look — it's the whole reason the look is usable here. This
 * app asks people to read paragraphs about what does and doesn't stay private,
 * and it asks them to check a number before approving a transfer. A bitmap face
 * is the wrong tool for both.
 */
const pixel = Pixelify_Sans({ variable: "--font-pixel", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Whisper Pay — private payment requests on Starknet",
  description:
    "Create a payment link. The payer pays through the STRK20 privacy pool, so the amount and the parties stay private on-chain.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${pixel.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <header className="border-b-2 border-hairline bg-surface">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-4 px-5 py-4">
            <Link href="/" className="display flex items-center gap-2.5 text-base">
              {/*
                The PNG, not `whislogo.svg` beside it. That file is an
                auto-trace — ~979 paths at 2048x2048 — which is the right master
                to keep and the wrong thing to make a browser parse and
                rasterise to fill 28 square pixels. Rendered at 96px, it is
                sharp past 3x and costs a few kilobytes instead of 200.
              */}
              <img
                src="/whislogo.png"
                alt=""
                aria-hidden
                width={28}
                height={28}
                className="size-7 shrink-0"
              />
              Whisper&nbsp;Pay
            </Link>
            <nav className="ml-auto flex items-center gap-4 text-sm text-muted">
              <Link
                href="/dashboard"
                className="display text-xs transition-colors hover:text-foreground"
              >
                Dashboard
              </Link>
              <ConnectWallet variant="compact" />
            </nav>
          </div>
        </header>

        <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-10">
          {children}
        </main>

        <footer className="border-t-2 border-hairline bg-surface">
          <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-4 gap-y-1 px-5 py-4 text-xs text-muted">
            <span>Starknet mainnet · STRK20 privacy pool</span>
            <a
              href="https://github.com/bugsm/whisperpay"
              target="_blank"
              rel="noreferrer"
              className="ml-auto transition hover:text-foreground"
            >
              Source
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
}
