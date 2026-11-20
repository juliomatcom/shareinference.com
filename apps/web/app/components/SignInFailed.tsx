"use client";

import { useSearchParams } from "next/navigation";

/** The notice after a failed GitHub sign-in (`/?signin=failed`). Read on the client so the landing page stays static. */
export function SignInFailed() {
  if (useSearchParams().get("signin") !== "failed") return null;
  return (
    <p role="alert" className="rounded-md border border-red-500/50 bg-red-950/40 px-4 py-2 text-sm text-red-300">
      Sign-in failed. Please try again.
    </p>
  );
}
