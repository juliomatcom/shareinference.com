"use client";

import { useEffect, useState } from "react";
import { api } from "./api";

/** GET `/api<path>` now and every `intervalMs` while the tab is visible. Keeps the last good answer on failures. */
export function usePolled<T>(path: string, intervalMs = 10_000): { data: T | null; failed: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const res = await api<T>(path);
      if (!live) return;
      if (res.ok && res.data) {
        setData(res.data);
        setFailed(false);
      } else {
        setFailed(true);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, intervalMs);
    // A tab coming back to the front refreshes at once instead of waiting for the next tick.
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, intervalMs]);

  return { data, failed };
}
