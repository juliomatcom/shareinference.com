import type { Dispatcher } from "./dispatcher.js";
import type { RateLimiter } from "./rateLimiter.js";
import type {
  ApiKeyStore,
  Clock,
  JobStore,
  LedgerStore,
  Logger,
  ModelStore,
  Scheduler,
  Secrets,
  SessionStore,
  UserStore,
  WorkerStore,
} from "./ports.js";
import type { PublicStats } from "./publicStats.js";
import type { Registry } from "./registry.js";
import type { WorkerTokens } from "./workerTokens.js";

/** Everything the account logic needs; wired in main.ts. */
export interface Deps {
  users: UserStore;
  sessions: SessionStore;
  apiKeys: ApiKeyStore;
  ledger: LedgerStore;
  models: ModelStore;
  workers: WorkerStore;
  jobs: JobStore;
  /** The cached public aggregates (`/public/stats`, `/public/leaderboard`). */
  publicStats: PublicStats;
  /** In-memory live state: one registry and one token table per process. */
  registry: Registry;
  workerTokens: WorkerTokens;
  /** Per-model queues and routing, and the per-user request limits (also in-memory). */
  dispatcher: Dispatcher;
  limiter: RateLimiter;
  scheduler: Scheduler;
  /** Logger of module `inference`: dispatch, settlement. */
  log: Logger;
  secrets: Secrets;
  clock: Clock;
  /** Credits written as a `grant` entry for each new user (0: none). */
  signupGrant: number;
}
