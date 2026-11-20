import type { Metadata } from "next";
import { ProvidersTable } from "../components/ProvidersTable";

export const metadata: Metadata = { title: "Leaderboard" };

export default function LeaderboardPage() {
  return (
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-8">
      <h1 className="text-2xl font-bold">Leaderboard</h1>
      <p className="text-sm text-neutral-400">
        The 100 providers that have served the most tokens, 20 per page. Names are public display names; updates every
        few seconds.
      </p>
      <ProvidersTable pageSize={20} showSpeed />
    </main>
  );
}
