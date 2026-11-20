"use client";

import { formatNumber, type PublicStats } from "../lib/api";
import { AnimatedNumber } from "./AnimatedNumber";
import { usePolled } from "../lib/usePolled";

/** "N tokens served" and the live GPU count; polls every 10 s. */
export function HeroStats() {
  const { data, failed } = usePolled<PublicStats>("/public/stats");
  return (
    <div className="text-center">
      <h1 className="bg-gradient-to-b from-green-300 to-accent bg-clip-text text-4xl font-bold tracking-tight text-transparent tabular-nums sm:text-6xl">
        {data ? <AnimatedNumber value={data.tokensServed} /> : "--"} tokens served
      </h1>
      <p className="mt-3 text-sm text-neutral-400 sm:text-base">
        {data
          ? `Live: ${formatNumber(data.activeWorkers)} active ${data.activeWorkers === 1 ? "GPU" : "GPUs"} connected, ${formatNumber(data.modelsOnline)} ${data.modelsOnline === 1 ? "model" : "models"} online`
          : failed
            ? "Could not load live stats."
            : "Connecting to the network..."}
      </p>
    </div>
  );
}
