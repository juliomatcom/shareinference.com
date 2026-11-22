"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRequireMe } from "../components/MeProvider";
import { STATUS_LABEL, useSharing } from "../components/SharingProvider";
import { card, gateMessage } from "../components/ui";
import { MODEL_VRAM_MB, formatNumber, pickDefaultModel } from "../lib/api";
import { ModelScores } from "../components/ModelScores";
import { ProviderIcon } from "../components/ProviderIcon";
import { modelLabel, providerForModel } from "../lib/providers";

// Provider mode (wiki-llm/web.md): the Web Worker lives in `SharingProvider` (root layout), so sharing keeps running
// while you navigate. This page only starts and stops it and shows status and usage.

const MAX_VRAM_MB = Math.max(...Object.values(MODEL_VRAM_MB));

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
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start lg:gap-8">
        {/* Below lg the wrapper dissolves so the model picker (order-3) sits right after the status card. */}
        <div className="contents lg:flex lg:flex-col lg:gap-6">
          <div className="order-1 space-y-2">
            <h1 className="text-2xl font-bold">Share your GPU</h1>
            <p className="text-sm text-neutral-400">
              Keep this browser tab open and your GPU generates AI answers for other people. You can browse the site
              meanwhile: sharing continues until you press Stop or close the tab. You earn credits for every token
              served. Requests are processed in your browser; this page never shows who asked or what was asked.
            </p>
          </div>
          <section
            className={`order-2 ${card} space-y-3 ${active ? "border-accent/40 shadow-[0_0_32px_-12px_rgba(34,197,94,0.6)]" : ""}`}
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
          <section className={`order-4 ${card} space-y-3`} aria-labelledby="gpu-heading">
            <h2 id="gpu-heading" className="font-semibold">
              Your hardware
            </h2>
            {gpu.status === "checking" && <p className="text-sm text-neutral-400">Checking WebGPU...</p>}
            {gpu.status === "unsupported" && (
              <p role="alert" className="text-sm text-red-400">
                {gpu.reason}
              </p>
            )}
            {gpu.status === "ok" && (
              <div className="flex items-center gap-3">
                <ProviderIcon size={44} />
                <div className="min-w-0 text-sm">
                  <p className="truncate font-medium text-neutral-100">{gpuLabel}</p>
                  <p className="text-xs text-neutral-400">
                    16-bit shaders supported · max buffer {Math.round(gpu.info.maxBufferSize / 2 ** 20)} MiB
                  </p>
                </div>
              </div>
            )}
          </section>
          <section className={`order-5 ${card} space-y-3 border-amber-500/30`} aria-labelledby="notice-heading">
            <h2 id="notice-heading" className="font-semibold">
              Before you start: what passes through your browser
            </h2>
            <p className="text-sm text-neutral-300">
              While you share, other people&apos;s prompts and the model&apos;s replies pass through your browser. You
              must not inspect, store, copy or misuse them. This page never shows them to you, but a technical user
              could read them in the browser&apos;s developer tools; doing so breaks the{" "}
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
          <section className={`order-6 ${card}`} aria-labelledby="usage-heading">
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
              <Stat label="Credits earned (session)" value={formatNumber(stats.creditsEarned)} />
            </dl>
          </section>
        </div>
        <section className="order-3 space-y-4 lg:order-none" aria-labelledby="model-heading">
          <div>
            <h2 id="model-heading" className="text-xl font-semibold">
              Choose a model to serve
            </h2>
            <p className="text-sm text-neutral-400">Pick the AI model your GPU will run for other people.</p>
          </div>
          {models.length > 0 ? (
            <>
              <fieldset disabled={active} className="min-w-0">
                <legend className="sr-only">Choose the model your GPU will serve</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {models.map((m) => {
                    const vram = MODEL_VRAM_MB[m.id];
                    const label = modelLabel(m.id);
                    const provider = providerForModel(m.id);
                    const selected = m.id === model?.id;
                    return (
                      <label
                        key={m.id}
                        className={`group relative flex flex-col gap-3 rounded-xl border p-4 text-sm transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${
                          selected
                            ? "border-accent/60 bg-accent/[0.06] shadow-[0_0_32px_-14px_rgba(34,197,94,0.7)]"
                            : "border-neutral-800 bg-neutral-900/60"
                        } ${active ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:border-neutral-600"}`}
                      >
                        <input
                          type="radio"
                          name="model"
                          value={m.id}
                          checked={selected}
                          onChange={() => select(m.id)}
                          className="peer sr-only"
                        />
                        <span className="flex items-start gap-3">
                          <ProviderIcon provider={provider?.id} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold text-neutral-100" title={m.id}>
                              {label.name}
                            </span>
                            <span className="block text-xs text-neutral-400">
                              {provider ? `${provider.name} · ` : ""}
                              {label.size}
                            </span>
                          </span>
                          {m.id === recommendedId && (
                            <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                              Recommended
                            </span>
                          )}
                        </span>
                        <span className="flex flex-wrap gap-1.5 text-xs text-neutral-300">
                          <span className="rounded-md bg-neutral-800/80 px-2 py-0.5">
                            {formatNumber(m.contextWindow)} token context
                          </span>
                          {m.priceMultiplier > 1 && (
                            <span className="rounded-md bg-accent/10 px-2 py-0.5 text-accent">
                              earns x{m.priceMultiplier} credits per token
                            </span>
                          )}
                        </span>
                        {vram !== undefined && (
                          <span className="block">
                            <span className="mb-1 flex justify-between text-xs text-neutral-400">
                              <span>GPU memory needed</span>
                              <span className="text-neutral-200">about {(vram / 1000).toFixed(1)} GB</span>
                            </span>
                            <span
                              className="block h-1.5 overflow-hidden rounded-full bg-neutral-800"
                              aria-hidden="true"
                            >
                              <span
                                className="block h-full rounded-full bg-gradient-to-r from-green-600 to-accent"
                                style={{ width: `${Math.max(6, Math.round((vram / MAX_VRAM_MB) * 100))}%` }}
                              />
                            </span>
                          </span>
                        )}
                        <ModelScores modelId={m.id} />
                        <span className="mt-auto flex items-center justify-between gap-2 border-t border-neutral-800 pt-3 text-xs">
                          <span className="flex items-center gap-1.5 text-neutral-400">
                            <span
                              aria-hidden="true"
                              className={`size-1.5 rounded-full ${m.workersOnline > 0 ? "bg-accent" : "bg-neutral-600"}`}
                            />
                            {active && selected ? "Serving now · " : ""}
                            {m.workersOnline} online now
                          </span>
                          <span
                            aria-hidden="true"
                            className={`flex size-4 items-center justify-center rounded-full border ${
                              selected ? "border-accent" : "border-neutral-600"
                            }`}
                          >
                            {selected && <span className="size-2 rounded-full bg-accent" />}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <p className="text-xs text-neutral-400">
                The first start downloads the model file (about 1.3 to 13.3 GB depending on the model); it is cached in
                your browser afterwards. You cannot change the model while sharing: press Stop first.
              </p>
            </>
          ) : (
            <p className="text-sm text-neutral-400">Loading...</p>
          )}
        </section>
      </div>
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
