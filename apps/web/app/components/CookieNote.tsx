"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const KEY = "si_cookie_note";

/**
 * First-visit notice: we set only strictly necessary cookies (session, OAuth state), so this informs and does not
 * ask. Non-blocking: sticky at the bottom of the viewport, but in normal flow above the footer, so at the end of the page it never covers footer links. Renders nothing until
 * mounted: localStorage is unknown on the server.
 */
export function CookieNote() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === null) setVisible(true);
    } catch {
      // Storage blocked: show the note; dismissing then lasts for this page view only.
      setVisible(true);
    }
  }, []);
  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      // not remembered
    }
  };
  return (
    <section
      role="region"
      aria-label="Cookie notice"
      className="sticky bottom-0 z-10 border-t border-neutral-800 bg-neutral-900 px-4 py-3 text-sm text-neutral-300"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p>
          We only use strictly necessary cookies to keep you signed in. No tracking or analytics.{" "}
          <Link href="/docs/privacy" className="text-accent">
            Privacy
          </Link>
        </p>
        <button
          type="button"
          onClick={dismiss}
          className="self-start rounded-md bg-accent px-4 py-1.5 font-semibold text-neutral-950 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:self-auto"
        >
          OK
        </button>
      </div>
    </section>
  );
}
