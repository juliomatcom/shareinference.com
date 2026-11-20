"use client";

import Link from "next/link";
import { useState } from "react";
import { formatNumber, type LeaderboardEntry } from "../lib/api";
import { usePolled } from "../lib/usePolled";
import { Pager } from "./Pager";
import { card } from "./ui";

const th = "px-3 py-2 text-left font-medium";
const td = "px-3 py-2.5";

function Status({ online }: { online: boolean }) {
  return online ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent">
      <span className="size-1.5 rounded-full bg-accent shadow-[0_0_6px_#22c55e]" />
      LIVE
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-500">
      <span className="size-1.5 rounded-full bg-neutral-600" />
      OFFLINE
    </span>
  );
}

/**
 * The "Top GPU providers" table; `limit` trims it for the landing page, `pageSize` pages it (the leaderboard page).
 * Polls every 10 s; the page number survives a refresh and is clamped if the list shrinks.
 */
export function ProvidersTable({
  limit,
  pageSize,
  showSpeed = false,
}: {
  limit?: number;
  pageSize?: number;
  showSpeed?: boolean;
}) {
  const { data, failed } = usePolled<{ providers: LeaderboardEntry[] }>("/public/leaderboard");
  const [requested, setPage] = useState(0);
  const [liveOnly, setLiveOnly] = useState(false);
  const shown = data && liveOnly ? data.providers.filter((p) => p.online) : data?.providers;
  const all = shown ? (limit ? shown.slice(0, limit) : shown) : null;
  const pages = all && pageSize ? Math.max(1, Math.ceil(all.length / pageSize)) : 1;
  const page = Math.min(requested, pages - 1);
  const rows = all && pageSize ? all.slice(page * pageSize, (page + 1) * pageSize) : all;

  return (
    <div className={`${card} p-0`}>
      <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-2">
        <h2 className="text-xs font-semibold tracking-wide text-neutral-300 uppercase">Top GPU providers</h2>
        <label className="flex shrink-0 items-center gap-2 py-1 text-sm whitespace-nowrap text-neutral-300">
          <input
            type="checkbox"
            checked={liveOnly}
            onChange={(e) => {
              setLiveOnly(e.target.checked);
              setPage(0);
            }}
            className="size-4 accent-accent"
          />
          Live only
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-0 text-sm">
          <caption className="sr-only">Top GPU providers</caption>
          <thead className="text-xs text-neutral-400">
            <tr className="border-b border-neutral-800">
              <th scope="col" className={th}>
                Rank
              </th>
              <th scope="col" className={th}>
                Contributor
              </th>
              <th scope="col" className={`${th} hidden sm:table-cell`}>
                Device
              </th>
              <th scope="col" className={`${th} hidden md:table-cell`}>
                Model hosted
              </th>
              <th scope="col" className={`${th} text-right`}>
                Tokens served
              </th>
              <th scope="col" className={`${th} hidden text-right md:table-cell`}>
                Credits earned
              </th>
              {showSpeed && (
                <th scope="col" className={`${th} hidden text-right lg:table-cell`}>
                  Tokens/s
                </th>
              )}
              <th scope="col" className={th}>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((p) => (
              <tr key={p.rank} className="border-b border-neutral-800/60 last:border-0">
                <td className={`${td} text-neutral-400`}>#{p.rank}</td>
                <td className={`${td} max-w-36 truncate font-medium text-neutral-100`}>{p.name}</td>
                <td className={`${td} hidden max-w-48 sm:table-cell`}>
                  <div className="truncate text-neutral-200">{p.deviceLabel ?? p.gpu ?? "-"}</div>
                  {p.deviceLabel && p.gpu && <div className="truncate text-xs text-neutral-500">{p.gpu}</div>}
                </td>
                <td className={`${td} hidden text-neutral-300 md:table-cell`}>{p.model ?? "-"}</td>
                <td className={`${td} text-right tabular-nums`}>{formatNumber(p.tokensServed)}</td>
                <td className={`${td} hidden text-right tabular-nums md:table-cell`}>
                  {formatNumber(p.creditsEarned)}
                </td>
                {showSpeed && (
                  <td className={`${td} hidden text-right tabular-nums lg:table-cell`}>
                    {p.tokensPerS === null ? "-" : p.tokensPerS.toFixed(1)}
                  </td>
                )}
                <td className={td}>
                  <Status online={p.online} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows === null && (
        <p role="status" className="px-4 py-6 text-center text-sm text-neutral-400">
          {failed ? "Could not load the leaderboard." : "Loading..."}
        </p>
      )}
      {rows?.length === 0 && (
        <p className="px-4 py-6 text-center text-sm text-neutral-400">
          {liveOnly ? "No provider is live right now." : "No provider has served a request yet."}{" "}
          <Link href="/share" className="text-accent">
            Be the first
          </Link>
          .
        </p>
      )}
      {pageSize && (
        <Pager
          page={page}
          pages={pages}
          onPage={setPage}
          label="Leaderboard pages"
          className="border-t border-neutral-800 px-4 py-3"
        />
      )}
    </div>
  );
}
