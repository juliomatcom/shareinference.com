"use client";

import { useEffect, useState } from "react";

// Show the button once the reader is within this many pixels of the end of a page that actually scrolls.
const NEAR_BOTTOM_PX = 480;

/** "Back to top": fades in near the bottom of a long page; honours reduced motion. */
export function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight > window.innerHeight * 1.5;
      const nearBottom = window.scrollY + window.innerHeight >= doc.scrollHeight - NEAR_BOTTOM_PX;
      setVisible(scrollable && nearBottom);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // Opening or closing an answer changes the page height without a scroll event.
    const resize = new ResizeObserver(schedule);
    resize.observe(document.body);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <button
      type="button"
      aria-label="Back to top"
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      onClick={(e) => {
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
        e.currentTarget.blur();
      }}
      className={`fixed right-4 bottom-20 z-30 inline-flex size-11 items-center justify-center rounded-full border border-neutral-700 bg-neutral-900/90 text-neutral-200 shadow-lg backdrop-blur transition-opacity duration-200 hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none ${
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 16V4M5 9l5-5 5 5" />
      </svg>
    </button>
  );
}
