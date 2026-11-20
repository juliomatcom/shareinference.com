import { gpuLabel } from "./gpu.js";
import type { Clock, ModelStore, PublicStore } from "./ports.js";
import type { Registry } from "./registry.js";

/** Public aggregates are recomputed at most this often (wiki-llm/api.md). */
export const PUBLIC_CACHE_MS = 5_000;
export const LEADERBOARD_SIZE = 100;

export interface PublicStatsView {
  tokensServed: number;
  activeWorkers: number;
  modelsOnline: number;
  jobsServed: number;
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  gpu: string | null;
  deviceLabel: string | null;
  model: string | null;
  tokensServed: number;
  creditsEarned: number;
  tokensPerS: number | null;
  online: boolean;
}

export interface PublicStats {
  stats(): Promise<PublicStatsView>;
  leaderboard(): Promise<{ providers: LeaderboardEntry[] }>;
}

/**
 * Memoizes an async loader for `ttlMs`; concurrent callers share one load. When a reload fails the last good value is
 * served (a public page should not break because the database blinked); with none, the failure propagates. A clock
 * that moved backwards counts as stale.
 */
export function cached<T>(clock: Clock, ttlMs: number, load: () => Promise<T>): () => Promise<T> {
  let value: { at: number; data: T } | undefined;
  let inflight: Promise<T> | undefined;
  return async () => {
    const age = value ? clock.now().getTime() - value.at : Number.POSITIVE_INFINITY;
    if (value && age >= 0 && age < ttlMs) return value.data;
    inflight ??= load()
      .then((data) => {
        // Stamped when the load finishes: a slow query must not shorten the window it buys.
        value = { at: clock.now().getTime(), data };
        return data;
      })
      .catch((error: unknown) => {
        if (value) return value.data;
        throw error;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function createPublicStats(deps: {
  store: PublicStore;
  models: ModelStore;
  registry: Registry;
  clock: Clock;
}): PublicStats {
  const { store, models, registry, clock } = deps;
  return {
    stats: cached(clock, PUBLIC_CACHE_MS, async () => {
      const [totals, enabled] = await Promise.all([store.totals(), models.listEnabled()]);
      return {
        tokensServed: totals.tokensServed,
        activeWorkers: registry.readyCount(),
        modelsOnline: enabled.filter((m) => registry.onlineCount(m.webllmId) > 0).length,
        jobsServed: totals.jobsServed,
      };
    }),
    leaderboard: cached(clock, PUBLIC_CACHE_MS, async () => {
      const rows = await store.topProviders(LEADERBOARD_SIZE);
      return {
        // Only opt-in fields: the user id stays here, it is needed just for the live "online" lookup.
        providers: rows.map((r, i) => ({
          rank: i + 1,
          name: r.displayName,
          gpu: gpuLabel(r.gpu),
          deviceLabel: r.deviceLabel,
          model: r.model,
          tokensServed: r.tokensServed,
          creditsEarned: r.creditsEarned,
          tokensPerS: r.tokensPerS === null ? null : round1(r.tokensPerS),
          online: registry.byUser(r.userId).some((w) => w.state !== "connected"),
        })),
      };
    }),
  };
}
