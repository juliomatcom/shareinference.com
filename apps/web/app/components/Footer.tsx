import Link from "next/link";
import { REPO_URL } from "../lib/api";

export function Footer() {
  return (
    <footer className="border-t border-neutral-800 bg-neutral-950">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-6 text-center text-xs text-neutral-400 sm:flex-row sm:flex-wrap sm:justify-center sm:gap-x-4 sm:text-sm">
        <span>Free users enter a fair queue</span>
        <span className="hidden text-neutral-700 sm:inline">|</span>
        <span>Credit holders jump to the front of the queue</span>
        <span className="hidden text-neutral-700 sm:inline">|</span>
        <span>
          100% open source (
          <a href={`${REPO_URL}/blob/main/LICENSE`} className=" hover:text-white" rel="noopener noreferrer">
            AGPL-3.0
          </a>
          )
        </span>
        <span className="hidden text-neutral-700 sm:inline">|</span>
        <span>
          <a href={REPO_URL} className=" hover:text-white" rel="noopener noreferrer">
            Repository
          </a>
          {" · "}
          <Link href="/docs/privacy" className=" hover:text-white">
            Privacy
          </Link>
          {" · "}
          <Link href="/docs/terms" className=" hover:text-white">
            Terms
          </Link>
        </span>
      </div>
    </footer>
  );
}
