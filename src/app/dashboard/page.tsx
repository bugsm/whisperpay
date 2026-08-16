import type { Metadata } from "next";

import Dashboard from "@/components/dashboard/Dashboard";

export const metadata: Metadata = {
  title: "Dashboard — Whisper Pay",
  description: "Your shielded balance, withdrawals, and payment links.",
};

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted">
          Your private balance and the links you've created.
        </p>
      </div>
      <Dashboard />
    </div>
  );
}
