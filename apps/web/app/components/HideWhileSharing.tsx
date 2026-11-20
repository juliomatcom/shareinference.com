"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { card } from "./ui";
import { useSharing } from "./SharingProvider";

/**
 * Landing page: someone who is already sharing their GPU does not need the "start sharing / get an API key" cards,
 * so while sharing they are replaced by a short thank-you with a link to the live details.
 */
export function HideWhileSharing({ children }: { children: ReactNode }) {
  const { active } = useSharing();
  if (!active) return <>{children}</>;
  return (
    <section className={`${card} flex flex-wrap items-center justify-between gap-3`} aria-label="You are sharing">
      <p className="text-sm text-neutral-200">
        <span className="font-semibold text-accent">Your GPU is shared.</span> Thank you! You can keep browsing; sharing
        continues until you press Stop.
      </p>
      <Link href="/share" className="text-sm text-accent">
        See live details
      </Link>
    </section>
  );
}
