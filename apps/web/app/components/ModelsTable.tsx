"use client";

import { formatNumber, type PublicModel } from "../lib/api";
import { usePolled } from "../lib/usePolled";
import { card } from "./ui";

/** Model catalog with live worker and queue counts; polls every 10 s. */
export function ModelsTable() {
  const { data, failed } = usePolled<{ models: PublicModel[] }>("/public/models");
  return (
    <div className={`${card} p-0`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-neutral-400">
            <tr className="border-b border-neutral-800">
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Model
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Context
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Workers online
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Queue depth
              </th>
            </tr>
          </thead>
          <tbody>
            {data?.models.map((m) => (
              <tr key={m.id} className="border-b border-neutral-800/60 last:border-0">
                <td className="px-3 py-2.5">
                  <code className="font-mono text-neutral-100">{m.id}</code>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(m.contextWindow)} tokens</td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  <span className={m.workersOnline > 0 ? "text-accent" : "text-neutral-500"}>
                    {formatNumber(m.workersOnline)}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(m.queueDepth)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data === null && (
        <p role="status" className="px-4 py-6 text-center text-sm text-neutral-400">
          {failed ? "Could not load the catalog." : "Loading..."}
        </p>
      )}
      {data?.models.length === 0 && (
        <p className="px-4 py-6 text-center text-sm text-neutral-400">No model is enabled yet.</p>
      )}
    </div>
  );
}
