import Link from "next/link";
import { ApiEndpoint } from "./components/ApiEndpoint";
import { Circuit } from "./components/Circuit";
import { HideWhileSharing } from "./components/HideWhileSharing";
import { HeroStats } from "./components/HeroStats";
import { ProvidersTable } from "./components/ProvidersTable";
import { card, primaryButton } from "./components/ui";

function Check({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" className="mt-1 shrink-0 text-accent">
        <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <span>{children}</span>
    </li>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<{ signin?: string }> }) {
  const { signin } = await searchParams;
  return (
    <main className="relative">
      <Circuit />
      <div className="mx-auto max-w-5xl space-y-8 px-4 py-10 sm:py-14">
        {signin === "failed" && (
          <p role="alert" className="rounded-md border border-red-500/50 bg-red-950/40 px-4 py-2 text-sm text-red-300">
            Sign-in failed. Please try again.
          </p>
        )}
        <HeroStats />

        <HideWhileSharing>
          <div className="grid gap-4 md:grid-cols-2 md:grid-rows-[auto_auto_1fr_auto]">
            <section className={`${card} flex flex-col gap-4 md:row-span-4 md:grid md:grid-rows-subgrid`}>
              <h2 className="text-sm font-semibold tracking-wide uppercase">Provide inference (earn credits)</h2>
              <p className="text-sm text-neutral-400">
                Share your spare Mac or PC GPU straight from a browser tab. Nothing to install.
              </p>
              <ul className="space-y-1.5 text-sm text-neutral-300">
                <Check>Earn credits for every token you serve (1 per input token, 5 per output token)</Check>
                <Check>Auto-detects WebGPU capabilities</Check>
                <Check>Runs quietly in a background tab; the model downloads once and is cached</Check>
              </ul>
              <div className="space-y-2">
                <Link href="/share" className={`${primaryButton} block border border-transparent py-2.5 text-center`}>
                  Start Sharing GPU
                </Link>
                <p className="text-center text-xs text-neutral-500">
                  Needs Chrome or Edge with WebGPU: Apple Silicon or a recent NVIDIA / AMD GPU
                </p>
              </div>
            </section>

            <section className={`${card} flex flex-col gap-4 md:row-span-4 md:grid md:grid-rows-subgrid`}>
              <h2 className="text-sm font-semibold tracking-wide uppercase">Access inference (spend credits)</h2>
              <p className="text-sm text-neutral-400">
                Use an OpenAI-compatible API endpoint with open models from your apps.
              </p>
              <ul className="space-y-1.5 text-sm text-neutral-300">
                <Check>Free tier with fair-queue access from day one</Check>
                <Check>Spend credits for priority routing at the front of the queue</Check>
                <Check>
                  Standard OpenAI REST and streaming API (
                  <Link href="/docs/api" className=" hover:text-white">
                    docs
                  </Link>
                  )
                </Check>
              </ul>
              <div className="space-y-2">
                <Link
                  href="/dashboard"
                  className="block rounded-md border border-accent/50 bg-accent/10 py-2.5 text-center text-sm font-semibold text-accent hover:bg-accent/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  Get API Key &amp; Start
                </Link>
                <ApiEndpoint />
              </div>
            </section>
          </div>
        </HideWhileSharing>

        <ProvidersTable limit={5} />
        <p className="text-center text-sm">
          <Link href="/leaderboard" className="text-accent">
            See the full leaderboard
          </Link>
        </p>
      </div>
    </main>
  );
}
