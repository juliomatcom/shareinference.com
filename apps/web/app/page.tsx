import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ApiEndpoint } from "./components/ApiEndpoint";
import { Circuit } from "./components/Circuit";
import { GithubIcon } from "./components/GithubIcon";
import { HideWhileSharing } from "./components/HideWhileSharing";
import { HeroStats } from "./components/HeroStats";
import { JsonLd } from "./components/JsonLd";
import { ProvidersTable } from "./components/ProvidersTable";
import { SignInFailed } from "./components/SignInFailed";
import { card, primaryButton } from "./components/ui";
import { REPO_URL } from "./lib/api";
import { DESCRIPTION, SITE_NAME, SITE_URL, absoluteUrl, pageMetadata } from "./lib/site";

export const metadata: Metadata = pageMetadata({
  absoluteTitle: `${SITE_NAME} | Community-Powered Open-Source LLM Inference`,
  description:
    "Share GPU time from a browser tab with WebGPU, earn credits, and use them on an OpenAI-compatible API for open-weight LLMs. No credit card needed.",
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

// The tweet text is fixed (a visitor can edit it in X's composer); the link is the site's own origin.
const SHARE_ON_X_URL = `https://x.com/intent/post?${new URLSearchParams({
  text: "Intelligence for everyone, powered by everyone. Lend your GPU from a browser tab, no credit card needed.",
  url: SITE_URL,
})}`;
const secondaryLink =
  "inline-flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm font-semibold text-neutral-100 hover:border-neutral-500 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

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
              <h2 className="text-sm font-semibold tracking-wide uppercase">Access inference (use credits)</h2>
              <p className="text-sm text-neutral-400">
                Use an OpenAI-compatible API endpoint with open models from your apps.
              </p>
              <ul className="space-y-1.5 text-sm text-neutral-300">
                <Check>Not sharing a GPU? You still get in, through a fair queue, from day one</Check>
                <Check>Credits you earn by sharing give you priority at the front of the queue</Check>
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

        <section
          className={`${card} flex flex-col items-center gap-4 text-center lg:flex-row lg:text-left`}
          aria-labelledby="grow-heading"
        >
          <span
            aria-hidden="true"
            className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-neutral-700 bg-neutral-950 text-neutral-100"
          >
            <GithubIcon className="size-7" />
          </span>
          <div className="lg:flex-1">
            <h2 id="grow-heading" className="font-semibold">
              Help the project grow
            </h2>
            <p className="text-sm text-neutral-400">
              ShareInference is open source and runs on people like you. Star it on GitHub or tell someone about it:
              every new GPU makes the network better for everyone.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-center gap-2">
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={secondaryLink}>
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="currentColor">
                <path d="m12 2.5 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.3 6.2 20.4l1.1-6.5L2.6 9.3l6.5-.9z" />
              </svg>
              Star on GitHub
            </a>
            <a href={SHARE_ON_X_URL} target="_blank" rel="noopener noreferrer" className={secondaryLink}>
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              Share on X
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}
