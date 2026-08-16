import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";

import ConnectWallet from "@/components/wallet/ConnectWallet";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Whisper Pay — private payment requests on Starknet",
  description:
    "Create a payment link. The payer pays through the STRK20 privacy pool, so the amount and the parties stay private on-chain.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="ambient flex min-h-full flex-col">
        <header className="border-b border-hairline">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-4 px-5 py-4">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <span
                aria-hidden
                className="size-2.5 rounded-full bg-accent shadow-[0_0_12px_var(--accent)]"
              />
              Whisper&nbsp;Pay
            </Link>
            <nav className="ml-auto flex items-center gap-4 text-sm text-muted">
              <Link href="/dashboard" className="transition hover:text-foreground">
                Dashboard
              </Link>
              <ConnectWallet variant="compact" />
            </nav>
          </div>
        </header>

        <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-10">
          {children}
        </main>

        <footer className="border-t border-hairline">
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
