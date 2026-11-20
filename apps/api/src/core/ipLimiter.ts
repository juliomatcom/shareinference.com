import type { Clock } from "./ports.js";

// Per-IP sliding-window limiter, in memory (wiki-llm/api.md "Limits"). It guards the anonymous surface: public routes,
// sign-in, failed authentication and provider WebSocket upgrades. Consumer inference limits are per user (rateLimiter).
export const IP_LIMITS = {
  /** Unauthenticated requests on public routes (the site polls every 10 s per open tab; shared addresses add up). */
  publicPerMin: 600,
  /** `/auth/*` requests. */
  authPerMin: 20,
  /** Provider WebSocket upgrades. */
  upgradePerMin: 30,
  /** Bad Bearer keys or session cookies; past it the 401 becomes a 429. Valid credentials are never limited here. */
  failedAuthPerMin: 60,
} as const;

const WINDOW_MS = 60_000;
/** Distinct IPs tracked per limiter; past it expired entries go first, then the oldest-seen IP. */
const MAX_KEYS = 10_000;

export interface IpLimiter {
  /** Counts a hit and returns true, or returns false (counting nothing) when the IP already used its allowance. */
  hit(ip: string): boolean;
}

export function createIpLimiter(deps: { clock: Clock }, maxPerWindow: number, windowMs = WINDOW_MS): IpLimiter {
  // Map iteration order is insertion order: an IP is re-inserted on every hit, so the first key is the stalest.
  const hits = new Map<string, number[]>();

  const live = (ip: string, now: number): number[] => {
    const list = hits.get(ip);
    if (!list) return [];
    let drop = 0;
    while (drop < list.length && now - list[drop]! >= windowMs) drop++;
    if (drop > 0) list.splice(0, drop);
    return list;
  };

  return {
    hit(ip) {
      const now = deps.clock.now().getTime();
      const list = live(ip, now);
      if (list.length >= maxPerWindow) return false;
      list.push(now);
      hits.delete(ip);
      if (hits.size >= MAX_KEYS) {
        for (const key of hits.keys()) if (live(key, now).length === 0) hits.delete(key);
        // Still full: every tracked IP is active; make room for the new one.
        if (hits.size >= MAX_KEYS) hits.delete(hits.keys().next().value!);
      }
      hits.set(ip, list);
      return true;
    },
  };
}
