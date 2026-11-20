import type { Clock } from "./ports.js";
import type { Lane, RateLimitOverride } from "./types.js";

// In-memory per-user limits (wiki-llm/api.md "Limits"): requests per minute and per day, and concurrent requests.
const LIMITS = {
  fair: { perMin: 10, perDay: 500, concurrent: 1 },
  priority: { perMin: 60, perDay: Number.POSITIVE_INFINITY, concurrent: 4 },
} as const;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Idle users are dropped from memory past this many entries. */
const SWEEP_ABOVE = 10_000;

interface UserWindow {
  minute: number[];
  day: number[];
  inflight: number;
}

export interface RateLimiter {
  /** A release function when the request may proceed (call it once the request ends), undefined when over a limit. */
  acquire(userId: string, lane: Lane, override: RateLimitOverride | null): (() => void) | undefined;
}

export function createRateLimiter(deps: { clock: Clock }): RateLimiter {
  const users = new Map<string, UserWindow>();

  const prune = (w: UserWindow, now: number) => {
    while (w.minute.length > 0 && now - w.minute[0]! >= MINUTE_MS) w.minute.shift();
    while (w.day.length > 0 && now - w.day[0]! >= DAY_MS) w.day.shift();
  };

  function sweep(now: number): void {
    for (const [id, w] of users) {
      prune(w, now);
      if (w.inflight === 0 && w.day.length === 0 && w.minute.length === 0) users.delete(id);
    }
  }

  return {
    acquire(userId, lane, override) {
      const now = deps.clock.now().getTime();
      if (users.size >= SWEEP_ABOVE) sweep(now);
      const base = LIMITS[lane];
      const perMin = override?.perMin ?? base.perMin;
      const perDay = override?.perDay ?? base.perDay;
      const w = users.get(userId) ?? { minute: [], day: [], inflight: 0 };
      prune(w, now);
      if (w.inflight >= base.concurrent || w.minute.length >= perMin || w.day.length >= perDay) {
        return undefined;
      }
      w.minute.push(now);
      // Only users with a finite daily limit keep a day list: it stays at most `perDay` long.
      if (Number.isFinite(perDay)) w.day.push(now);
      w.inflight++;
      users.set(userId, w);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        w.inflight--;
      };
    },
  };
}
