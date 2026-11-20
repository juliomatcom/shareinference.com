import type { Metadata } from "next";
import Link from "next/link";
import { card } from "../components/ui";

export const metadata: Metadata = { title: "How It Works" };

const steps = [
  {
    title: "Providers share a GPU",
    body: "A contributor opens the Share page in Chrome or Edge. The browser downloads an open model once (about 2.4 GB, then cached) and runs it on the GPU through WebGPU, inside a Web Worker. The worker keeps a WebSocket open to the ShareInference server and waits for work.",
  },
  {
    title: "Consumers call an API",
    body: "A consumer creates an API key and sends OpenAI-style requests to /v1/chat/completions. Streaming and non-streaming both work, so existing OpenAI clients only need a new base URL.",
  },
  {
    title: "The server routes, it does not compute",
    body: "The server is CPU-only. It authenticates the request, queues it, picks one random idle provider that has the requested model loaded, streams the tokens back and settles credits. Consumers choose a model, never a provider.",
  },
  {
    title: "Credits keep it fair",
    body: "Every request costs credits (1 per input token, 5 per output token) and the provider who served it earns the same amount, so credits are only moved, never created or burned. Holders of credits are served first (priority lane); everyone else waits in a fair queue, which needs a GitHub account of at least 30 days.",
  },
];

export default function HowItWorksPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">How it works</h1>
        <p className="text-neutral-400">
          ShareInference is an open-source inference network: people lend GPU time from a browser tab and earn credits,
          and credits pay for an OpenAI-compatible API.
        </p>
      </div>

      <ol className="space-y-4">
        {steps.map((s, i) => (
          <li key={s.title} className={`${card} flex gap-4`}>
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent">
              {i + 1}
            </span>
            <div>
              <h2 className="font-semibold">{s.title}</h2>
              <p className="mt-1 text-sm text-neutral-400">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <section aria-labelledby="privacy" className={`${card} space-y-3 border-amber-500/30`}>
        <h2 id="privacy" className="font-semibold">
          Privacy, honestly
        </h2>
        <ul className="list-disc space-y-2 pl-5 text-sm text-neutral-300">
          <li>
            Prompts are processed <strong>inside a contributor&apos;s browser</strong>. A technically skilled
            contributor could read them with the browser&apos;s developer tools. The interface never shows them, but the
            text does pass through that machine. Do not send secrets.
          </li>
          <li>
            Providers never see who you are: no account, API key or IP address is ever sent to them. Routing is blind,
            and the provider&apos;s public name is revealed to you only after the request has finished.
          </li>
          <li>ShareInference does not store or log prompt or answer text, only ids, token counts and timings.</li>
          <li>
            Contributors see their own usage live, such as tokens, speed and credits, never the content or the asker.
          </li>
        </ul>
        <p className="text-sm text-neutral-400">
          More detail on{" "}
          <Link href="/docs/privacy" className="text-accent">
            what is visible to whom
          </Link>
          .
        </p>
      </section>

      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/share" className="text-accent">
          Share your GPU
        </Link>
        <Link href="/docs/api" className="text-accent">
          Use the API
        </Link>
        <Link href="/models" className="text-accent">
          Model catalog
        </Link>
      </div>
    </main>
  );
}
