import type { Metadata } from "next";
import { ProvidersTable } from "../components/ProvidersTable";
import { pageMetadata } from "../lib/site";

export const metadata: Metadata = pageMetadata({
  title: "GPU Provider Leaderboard",
  description:
    "The top community GPU providers on ShareInference, ranked by tokens served. See who is sharing WebGPU compute for open-source LLM inference right now.",
  path: "/leaderboard",
});

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
