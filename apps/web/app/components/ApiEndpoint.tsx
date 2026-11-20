"use client";

import { usePolled } from "../lib/usePolled";

/** The OpenAI-compatible base URL, learned at runtime from `/public/config` (D39). */
export function ApiEndpoint() {
  // One answer is enough: the config never changes while the page is open.
  const { data } = usePolled<{ apiPublicUrl: string }>("/public/config", 3_600_000);
  return (
    <p className="text-center text-xs text-neutral-500">
      Endpoint: <code className="text-neutral-400">{data ? `${data.apiPublicUrl.replace(/\/$/, "")}/v1` : "..."}</code>
    </p>
  );
}
