"use client";

import Link from "next/link";
import { formatNumber } from "../lib/api";
import { STATUS_LABEL, useSharing } from "./SharingProvider";

/**
 * Bottom bar (above the footer, sticky) shown on every page while the visitor shares their GPU: status, credits
 * earned and requests served. It stays until Stop (or the tab closes); a failure keeps it
 * visible with the error so it is not missed on another page.
 */
export function ShareBar() {
  const { active, error } = useSharing();
  if (!active && !error) return null;
  return <Bar />;
}

function Bar() {
  const { run, active, stats, error, progress, stop, dismissError } = useSharing();
  const live = run === "ready" || run === "busy";

  return (
    <section
      role="region"
      aria-label="GPU sharing"
      className="sticky bottom-0 z-20 border-t border-accent/30 bg-neutral-950/95 px-4 py-2 text-sm backdrop-blur"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-5 gap-y-2">
        <p role="status" className="flex items-center gap-2 font-medium text-neutral-100">
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${
              !active ? "bg-red-500" : live ? "bg-accent shadow-[0_0_8px_#22c55e]" : "animate-pulse bg-amber-400"
            }`}
          />
          {active ? STATUS_LABEL[run] : "Sharing stopped"}
          {run === "loading" && progress && (
            <span className="text-xs font-normal text-neutral-400 tabular-nums">
              {Math.round(progress.value * 100)}%
            </span>
          )}
        </p>
        {active && (
          <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-neutral-300">
            <Metric label="Credits earned" value={formatNumber(stats.creditsEarned)} accent />
            <Metric label="Requests served" value={formatNumber(stats.jobsServed)} />
          </dl>
        )}
        {error && (
          <p role="alert" className="text-red-400">
            {error}
          </p>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Link href="/share" className="text-neutral-400 hover:text-white">
            Details
          </Link>
          {active ? (
            <button
              type="button"
              onClick={stop}
              className="rounded-md border border-neutral-700 px-3 py-1 hover:border-red-500 hover:text-red-400 focus-visible:outline-2 focus-visible:outline-accent"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={dismissError}
              className="rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500 focus-visible:outline-2 focus-visible:outline-accent"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-xs text-neutral-400">{label}</dt>
      <dd className={`font-semibold tabular-nums ${accent ? "text-accent" : "text-neutral-100"}`}>{value}</dd>
    </div>
  );
}
