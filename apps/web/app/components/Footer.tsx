import Link from "next/link";
import { REPO_URL } from "../lib/api";

// Stroke icons on a shared 24x24 grid, drawn in the claim's tint; decorative (the text beside each says it all).
function ClaimIcon({ tint, children }: { tint: string; children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`size-4 shrink-0 ${tint}`}
    >
      {children}
    </svg>
  );
}

const claim = "inline-flex items-center justify-center gap-1.5";

export function Footer() {
  return (
    <footer className="border-t border-neutral-800 bg-neutral-950">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-6 text-center text-xs text-neutral-400 sm:flex-row sm:flex-wrap sm:justify-center sm:gap-x-4 sm:text-sm">
        <span className={claim}>
          <ClaimIcon tint="text-sky-400">
            <path d="M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20" />
            <circle cx="10" cy="8" r="3.5" />
            <path d="M20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.6a3.5 3.5 0 0 1 0 6.8" />
          </ClaimIcon>
          Not sharing a GPU? Join the fair queue
        </span>
        <span className="hidden text-neutral-700 sm:inline">|</span>
        <span className={claim}>
          <ClaimIcon tint="text-amber-400">
            <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z" />
          </ClaimIcon>
          Share your GPU, earn credits, skip the queue
        </span>
        <span className="hidden text-neutral-700 sm:inline">|</span>
        <span className={claim}>
          <ClaimIcon tint="text-accent">
            <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14" />
          </ClaimIcon>
          <span>
            100% open source (
            <a href={`${REPO_URL}/blob/main/LICENSE`} className=" hover:text-white" rel="noopener noreferrer">
              AGPL-3.0
            </a>
            )
          </span>
        </span>
        <span className="hidden text-neutral-700 sm:inline">|</span>
        <span>
          <a href={REPO_URL} className=" hover:text-white" rel="noopener noreferrer">
            Repository
          </a>
          {" · "}
          <Link href="/docs/faq" className=" hover:text-white">
            FAQ
          </Link>
          {" · "}
          <Link href="/docs/privacy" className=" hover:text-white">
            Privacy
          </Link>
          {" · "}
          <Link href="/docs/terms" className=" hover:text-white">
            Terms
          </Link>
        </span>
        <p className="basis-full text-xs text-neutral-500">
          &copy; {new Date().getFullYear()} ShareInference. All rights reserved, except the source code, which is
          licensed under the AGPL-3.0.
        </p>
      </div>
    </footer>
  );
}
