import type { Metadata } from "next";
import Link from "next/link";
import { NO_INDEX } from "./lib/site";

// Next adds `noindex` to 404 responses itself; stating it here also replaces the site-wide `index, follow`.
export const metadata: Metadata = { title: "Page not found", robots: NO_INDEX };

export default function NotFound() {
  return (
    <main className="mx-auto max-w-3xl space-y-3 px-4 py-16 text-center">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="text-neutral-400">That page does not exist.</p>
      <Link href="/" className="text-accent">
        Back to the home page
      </Link>
    </main>
  );
}
