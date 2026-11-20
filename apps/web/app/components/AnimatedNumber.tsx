"use client";

import { useEffect, useRef, useState } from "react";
import { formatNumber } from "../lib/api";

const DURATION_MS = 1500;
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));

/** Counts from its last shown value to `value` (from 0 on first mount); jumps straight there under reduced motion. */
export function AnimatedNumber({ value }: { value: number }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);

  useEffect(() => {
    const start = from.current;
    if (start === value || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = value;
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min((now - t0) / DURATION_MS, 1);
      const v = Math.round(start + (value - start) * easeOutExpo(t));
      from.current = v;
      setShown(v);
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);

  // Screen readers get the settled number once, not every frame of the count.
  return (
    <>
      <span aria-hidden="true">{formatNumber(shown)}</span>
      <span className="sr-only">{formatNumber(value)}</span>
    </>
  );
}
