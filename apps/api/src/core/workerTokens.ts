import type { Clock, Secrets } from "./ports.js";

export const WORKER_TOKEN_TTL_MS = 60_000;
export const MAX_WORKER_TOKENS = 10_000;
/** One user cannot push everybody else's pending tokens out of the table. */
export const MAX_TOKENS_PER_USER = 10;

export interface WorkerTokens {
  /** A fresh token tied to the user; only its hash is kept. */
  issue(userId: string): { token: string; expiresInS: number };
  /** Single use: the user the token was issued to, or undefined when unknown, used or expired. */
  redeem(token: string): string | undefined;
}

interface Entry {
  userId: string;
  expiresAt: number;
}

/** In-memory, bounded (oldest evicted first), so a restart only invalidates tokens that live 60 s anyway. */
export function createWorkerTokens(deps: { secrets: Secrets; clock: Clock }): WorkerTokens {
  const { secrets, clock } = deps;
  // Map keeps insertion order: the first key is the oldest.
  const entries = new Map<string, Entry>();

  const purgeExpired = (now: number) => {
    for (const [key, e] of entries) {
      if (e.expiresAt > now) break; // later entries were issued later, so they expire later
      entries.delete(key);
    }
  };

  return {
    issue(userId) {
      const now = clock.now().getTime();
      purgeExpired(now);
      const mine = [...entries].filter(([, e]) => e.userId === userId);
      if (mine.length >= MAX_TOKENS_PER_USER) entries.delete(mine[0]![0]);
      if (entries.size >= MAX_WORKER_TOKENS) entries.delete(entries.keys().next().value!);
      const token = secrets.token();
      entries.set(secrets.hash(token), { userId, expiresAt: now + WORKER_TOKEN_TTL_MS });
      return { token, expiresInS: WORKER_TOKEN_TTL_MS / 1000 };
    },
    redeem(token) {
      const key = secrets.hash(token);
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      return entry.expiresAt > clock.now().getTime() ? entry.userId : undefined;
    },
  };
}
