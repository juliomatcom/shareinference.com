"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRequireMe } from "../components/MeProvider";
import { STATUS_LABEL, useSharing } from "../components/SharingProvider";
import { card, gateMessage } from "../components/ui";
import { MODEL_VRAM_MB, formatNumber, pickDefaultModel } from "../lib/api";

// Provider mode (wiki-llm/web.md): the Web Worker lives in `SharingProvider` (root layout), so sharing keeps running
// while you navigate. This page only starts and stops it and shows status and usage.

export default function Share() {
  const { state } = useRequireMe();
  const ready = state.status === "ready";
  const {
    gpu,
    models,
    model,
    select,
    run,
    active,
    progress,
    stats,
    error,
    awake,
    understood,
    prepare,
    acknowledge,
    start,
    stop,
  } = useSharing();

  useEffect(() => {
    if (ready) prepare();
  }, [ready, prepare]);

  const canStart = gpu.status === "ok" && !!model && !active && understood;
  const startHint = !understood
    ? "Tick “I understand” below to turn sharing on."
    : gpu.status === "checking" || !model
      ? "Checking your GPU..."
      : gpu.status === "unsupported"
        ? "This browser cannot share a GPU."
        : STATUS_LABEL[run];

  const live = run === "ready" || run === "busy"; // green while serving, amber while loading or reconnecting
  const recommendedId = pickDefaultModel(models)?.id;
  const gate = gateMessage(state);
  if (gate) return gate;

  const gpuLabel =
    gpu.status === "ok" ? [gpu.info.vendor, gpu.info.architecture].filter(Boolean).join(" / ") || "unknown GPU" : null;

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-bold">Share your GPU</h1>
      <p className="text-sm text-neutral-400">
        Keep this browser tab open and your GPU generates AI answers for other people. You can browse the site
        meanwhile: sharing continues until you press Stop or close the tab. You earn credits for every token served.
        Requests are processed in your browser; this page never shows who asked or what was asked.
      </p>

      <section
        className={`${card} space-y-2 !p-3 ${active ? "border-accent/40 shadow-[0_0_32px_-12px_rgba(34,197,94,0.6)]" : ""}`}
        aria-labelledby="status-heading"
      >
        <h2 id="status-heading" className="sr-only">
          Status
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            role="status"
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-0.5 text-xs font-medium ${
              !active
                ? "border-neutral-700 text-neutral-400"
                : live
                  ? "border-accent/40 text-accent"
                  : "border-amber-400/40 text-amber-400"
            }`}
          >
            <span
              aria-hidden="true"
              className={`size-1.5 rounded-full ${!active ? "bg-neutral-500" : live ? "bg-accent" : "bg-amber-400"}`}
            />
            {STATUS_LABEL[run]}
          </p>
          <div className="flex items-center gap-2">
            {active ? (
              <span
                className={`inline-flex items-center gap-2 rounded-md border px-3.5 py-1.5 text-sm font-semibold ${
                  live
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-amber-400/60 bg-amber-400/10 text-amber-400"
                }`}
              >
                <span className="relative flex size-4 items-center justify-center">
                  <span
                    aria-hidden="true"
                    className={`absolute size-3 rounded-full opacity-60 motion-safe:animate-ping ${live ? "bg-accent" : "bg-amber-400"}`}
                  />
                  <span
                    aria-hidden="true"
                    className={`relative size-2 rounded-full ${live ? "bg-accent" : "bg-amber-400"}`}
                  />
                </span>
                Sharing is ON
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void start()}
                disabled={!canStart}
                className="inline-flex items-center gap-2 rounded-md bg-gradient-to-b from-green-400 to-accent px-3.5 py-1.5 text-sm font-bold text-neutral-950 shadow-[0_0_18px_-3px_rgba(34,197,94,0.8)] transition hover:shadow-[0_0_26px_0_rgba(34,197,94,0.9)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:from-neutral-700 disabled:to-neutral-800 disabled:text-neutral-400 disabled:shadow-none"
              >
                <PowerIcon className="size-4" />
                {run === "stopped" ? "Turn ON again" : "Turn ON"}
              </button>
            )}
            <button
              type="button"
              onClick={stop}
              disabled={!active}
              className="inline-flex items-center gap-2 rounded-md border border-red-500/50 bg-red-950/30 px-3.5 py-1.5 text-sm font-semibold text-red-300 hover:bg-red-950/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400 disabled:opacity-40 disabled:hover:bg-red-950/30"
            >
              <PowerIcon className="size-4" />
              Stop
            </button>
          </div>
        </div>
        {!canStart && !active && <p className="text-xs text-neutral-400">{startHint}</p>}
        {run === "loading" && progress && (
          <div>
            <progress
              value={progress.value}
              max={1}
              className="w-full accent-green-500"
              aria-label="Model load progress"
            />
            <p className="mt-1 truncate text-xs text-neutral-400">{progress.text}</p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        {active && (
          <p className="text-xs text-neutral-500">
            {awake
              ? "Your screen is kept awake while this tab is visible."
              : "Keep this tab open to keep sharing. Navigating inside the site is fine."}
          </p>
        )}
      </section>

      <section className={`${card} space-y-2`} aria-labelledby="gpu-heading">
        <h2 id="gpu-heading" className="font-semibold">
          Your GPU
        </h2>
        {gpu.status === "checking" && <p className="text-sm text-neutral-400">Checking WebGPU...</p>}
        {gpu.status === "unsupported" && (
          <p role="alert" className="text-sm text-red-400">
            {gpu.reason}
          </p>
        )}
        {gpu.status === "ok" && (
          <p className="text-sm text-neutral-300">
            {gpuLabel} · 16-bit shaders supported · max buffer {Math.round(gpu.info.maxBufferSize / 2 ** 20)} MiB
          </p>
        )}
      </section>

      <section className={`${card} space-y-2`} aria-labelledby="model-heading">
        <h2 id="model-heading" className="font-semibold">
          Model
        </h2>
        {models.length > 0 ? (
          <>
            <fieldset disabled={active} className="space-y-2">
              <legend className="mb-1 text-sm text-neutral-300">Choose the model your GPU will serve</legend>
              {models.map((m) => {
                const vram = MODEL_VRAM_MB[m.id];
                return (
                  <label
                    key={m.id}
                    className={`flex items-start gap-3 rounded-md border p-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
                      m.id === model?.id ? "border-accent/50 bg-accent/5" : "border-neutral-800"
                    } ${active ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-neutral-600"}`}
                  >
                    <input
                      type="radio"
                      name="model"
                      value={m.id}
                      checked={m.id === model?.id}
                      onChange={() => select(m.id)}
                      className="mt-1 accent-accent"
                    />
                    <span className="space-y-0.5">
                      <span className="flex flex-wrap items-center gap-2 font-medium text-neutral-100">
                        {m.id}
                        {m.id === recommendedId && (
                          <span className="rounded-full border border-accent/40 px-2 py-0.5 text-xs font-normal text-accent">
                            Recommended
                          </span>
                        )}
                      </span>
                      <span className="block text-neutral-400">
                        context {formatNumber(m.contextWindow)} tokens
                        {vram !== undefined && ` · needs about ${(vram / 1000).toFixed(1)} GB GPU memory`}
                        {m.priceMultiplier > 1 && ` · pays x${m.priceMultiplier} credits per token`}
                        {` · ${m.workersOnline} online now`}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <p className="text-xs text-neutral-400">
              The first start downloads about as much as the model needs in GPU memory; it is cached in your browser
              afterwards. You cannot change the model while sharing: press Stop first.
            </p>
          </>
        ) : (
          <p className="text-sm text-neutral-400">Loading...</p>
        )}
      </section>

      <section className={`${card} space-y-3 border-amber-500/30`} aria-labelledby="notice-heading">
        <h2 id="notice-heading" className="font-semibold">
          Before you start: what passes through your browser
        </h2>
        <p className="text-sm text-neutral-300">
          While you share, other people&apos;s prompts and the model&apos;s replies pass through your browser. You must
          not inspect, store, copy or misuse them. This page never shows them to you, but a technical user could read
          them in the browser&apos;s developer tools; doing so breaks the{" "}
          <Link href="/docs/terms" className="text-accent">
            Terms
          </Link>
          . See the{" "}
          <Link href="/docs/privacy" className="text-accent">
            Privacy policy
          </Link>{" "}
          for what we handle.
        </p>
        <label className="flex items-start gap-2 text-sm text-neutral-200">
          <input
            type="checkbox"
            checked={understood}
            onChange={(e) => acknowledge(e.target.checked)}
            disabled={active}
            className="mt-0.5 accent-green-500"
          />
          <span>I understand</span>
        </label>
      </section>

      <section className={`${card}`} aria-labelledby="usage-heading">
        <h2 id="usage-heading" className="mb-3 font-semibold">
          Usage this session
        </h2>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <Stat label="Requests served" value={formatNumber(stats.jobsServed)} />
          <Stat label="Prompt tokens" value={formatNumber(stats.promptTokens)} />
          <Stat label="Completion tokens" value={formatNumber(stats.completionTokens)} />
          <Stat
            label="Last speed"
            value={stats.lastJob ? `${stats.lastJob.decodeTokensPerS.toFixed(1)} tokens/s` : "-"}
          />
          <Stat label="Credits earned" value={formatNumber(stats.creditsEarned)} />
        </dl>
      </section>
    </main>
  );
}

function PowerIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className={className}
    >
      <path d="M12 3v9" />
      <path d="M6.3 7.2a8 8 0 1 0 11.4 0" />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-neutral-400">{label}</dt>
      <dd className="text-lg font-semibold text-neutral-100">{value}</dd>
    </div>
  );
}
