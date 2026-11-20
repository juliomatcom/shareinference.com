import type { ReactNode } from "react";
import type { MeState } from "./MeProvider";
import { SignInPanel } from "./SignIn";

export const card = "rounded-lg border border-neutral-800 bg-neutral-900/60 p-5";
export const input =
  "w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm placeholder:text-neutral-500 focus-visible:outline-2 focus-visible:outline-accent user-invalid:border-red-500";
export const primaryButton =
  "rounded-md bg-accent px-4 py-2 text-sm font-semibold text-neutral-950 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50";

/** What a gated page shows until `/api/me` has answered with a profile; null once it is ready. */
export function gateMessage(state: MeState): ReactNode {
  switch (state.status) {
    case "ready":
      return null;
    case "suspended":
      return <Notice>This account is suspended.</Notice>;
    case "error":
      return <Notice>Could not load your account. Reload the page to try again.</Notice>;
    case "anonymous":
      return <SignInPanel />;
    default:
      return <Notice>Loading...</Notice>;
  }
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <p role="status" className="text-neutral-400">
        {children}
      </p>
    </main>
  );
}
