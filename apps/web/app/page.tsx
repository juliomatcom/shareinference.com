import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ApiEndpoint } from "./components/ApiEndpoint";
import { Circuit } from "./components/Circuit";
import { HideWhileSharing } from "./components/HideWhileSharing";
import { HeroStats } from "./components/HeroStats";
import { JsonLd } from "./components/JsonLd";
import { ProvidersTable } from "./components/ProvidersTable";
import { SignInFailed } from "./components/SignInFailed";
import { card, primaryButton } from "./components/ui";
import { DESCRIPTION, SITE_NAME, SITE_URL, absoluteUrl, pageMetadata } from "./lib/site";

export const metadata: Metadata = pageMetadata({
  absoluteTitle: `${SITE_NAME} | Community-Powered Open-Source LLM Inference`,
  description:
    "Share GPU time from a browser tab with WebGPU, earn credits, and spend them on an OpenAI-compatible API for open-weight LLMs. Free queue included.",
  path: "/",
});

// Only facts the site states elsewhere: free to share (credits are earned, no money), WebGPU browser required,
// AGPL-3.0 licence. No ratings, reviews or counts.
const appSchema = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: SITE_NAME,
  url: absoluteUrl("/"),
  description: DESCRIPTION,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Any (WebGPU browser)",
  browserRequirements: "Requires WebGPU (a recent desktop Chrome or Edge)",
  license: "https://www.gnu.org/licenses/agpl-3.0.html",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  publisher: { "@id": `${SITE_URL}/#organization` },
};

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

export default function Home() {
  return (
    <main className="relative">
      <JsonLd data={appSchema} />
      <Circuit />
      <div className="mx-auto max-w-5xl space-y-8 px-4 py-10 sm:py-14">
        <Suspense>
          <SignInFailed />
        </Suspense>
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
