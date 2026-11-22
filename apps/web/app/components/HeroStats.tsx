"use client";

import { formatNumber, type PublicStats } from "../lib/api";
import { AnimatedNumber } from "./AnimatedNumber";
import { usePolled } from "../lib/usePolled";

/** "N tokens served" and the live GPU count; polls every 10 s. */
export function HeroStats() {
  const { data, failed } = usePolled<PublicStats>("/public/stats");
  return (
    <div className="flex flex-col items-center text-center">
      {/* The live number is a stat, not the page heading: it is "--" in the server-rendered HTML. */}
      <p className="bg-gradient-to-b from-green-300 to-accent bg-clip-text text-4xl font-bold tracking-tight text-transparent tabular-nums sm:text-6xl">
        {data ? <AnimatedNumber value={data.tokensServed} /> : "--"} tokens served
      </p>
      <h1 className="mx-auto mt-4 max-w-2xl text-lg font-semibold text-neutral-200 sm:text-xl">
        Community-powered AI inference: share GPU time from a browser tab, spend it through an OpenAI-compatible API.
      </h1>
      <p className="mt-3 text-sm text-neutral-400 sm:text-base">
        {data
          ? `Live: ${formatNumber(data.activeWorkers)} active ${data.activeWorkers === 1 ? "GPU" : "GPUs"} connected, ${formatNumber(data.modelsOnline)} ${data.modelsOnline === 1 ? "model" : "models"} online`
          : failed
            ? "Could not load live stats."
            : "Connecting to the network..."}
      </p>
      <p className="mx-auto mt-4 inline-flex items-center gap-2 rounded-2xl border border-accent/30 bg-accent/10 px-4 py-2 text-left text-sm font-medium text-green-300">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-4 shrink-0"
        >
          <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
          <path d="M2.5 10h19" />
          <path d="m3 21 18-18" />
        </svg>
        <span>
          <strong className="font-semibold text-green-200">Intelligence for everyone, powered by everyone.</strong> No
          credit card, just GitHub.
        </span>
      </p>
    </div>
  );
}
