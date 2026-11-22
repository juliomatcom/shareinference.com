import type { Model } from "./models.js";
import type { Gpu } from "./protocol.js";
import type {
  ApiKeyInfo,
  BalanceSum,
  GithubProfile,
  JobHistoryRow,
  JobSource,
  JobStatus,
  Lane,
  LedgerEntry,
  NewEntry,
  NewUser,
  ProviderTotals,
  RateLimitOverride,
  Session,
  SettleInput,
  SettleResult,
  User,
} from "./types.js";

/** Delayed callbacks, so core needs no timer API. `after` returns a function that cancels the call. */
export interface Scheduler {
  after(ms: number, fn: () => void): () => void;
}

export type Fields = Record<string, unknown>;

/** Structured logging: one event per call, ids/counts/timings only (never prompt or completion text). */
export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

export interface Clock {
  now(): Date;
}

/** Randomness and hashing, so core needs no crypto module. */
export interface Secrets {
  /** 32 random bytes, base64url. */
  token(): string;
  /** `bytes` random bytes as lowercase hex. */
  hex(bytes: number): string;
  /** SHA-256, hex. */
  hash(value: string): string;
  /** Uniform random integer in [0, max). */
  int(max: number): number;
}

export type CreateUserResult =
  /** `displaced`: users whose display name was reset because it equals the new user's GitHub login. */
  { status: "created"; user: User; displaced: string[] } | { status: "display_name_taken" } | { status: "exists" };

export interface UserStore {
  /**
   * Creates the user, its zero `balances` row and, when `grant` > 0, a `grant` entry, all in one transaction. When the
   * new display name is the user's own GitHub login, another user holding that display name gets their default back
   * in the same transaction (a GitHub login is an identity; a display name must not squat on it).
   */
  create(input: NewUser, grant: number): Promise<CreateUserResult>;
  findById(id: string): Promise<User | undefined>;
  findByGithubId(githubId: number): Promise<User | undefined>;
  /** Users whose GitHub login or display name equals `handle`, case-insensitively. */
  findByHandle(handle: string): Promise<User[]>;
  /** Oldest first, at most `limit`. */
  list(limit: number): Promise<User[]>;
  /** Refreshes login and avatar; like `create`, resets another user's display name equal to the new login. Returns their ids. */
  updateGithub(id: string, fields: { githubLogin: string; avatarUrl: string | null }): Promise<string[]>;
  setProfile(
    id: string,
    patch: { displayName?: string; deviceLabel?: string | null },
  ): Promise<"ok" | "display_name_taken" | "not_found">;
  /** True when another user (not `exceptId`) has this GitHub login, case-insensitively. */
  githubLoginExists(login: string, exceptId?: string): Promise<boolean>;
  setSuspended(id: string, at: Date | null): Promise<void>;
  setRateLimit(id: string, override: RateLimitOverride): Promise<void>;
}

export interface SessionStore {
  create(tokenHash: string, userId: string, expiresAt: Date): Promise<void>;
  find(tokenHash: string): Promise<Session | undefined>;
  delete(tokenHash: string): Promise<void>;
  /** Drops sessions expired at `now`. */
  purgeExpired(now: Date): Promise<void>;
}

export interface NewApiKey {
  userId: string;
  name: string;
  prefix: string;
  keyHash: string;
}

export interface ApiKeyStore {
  /**
   * Inserts the key unless the user already has `maxActive` live ones (counted with the user's row locked, so parallel
   * creations cannot overshoot); undefined when refused.
   */
  create(input: NewApiKey, maxActive: number): Promise<ApiKeyInfo | undefined>;
  /** The user's live keys, then the most recently revoked ones, both newest first and bounded. */
  listByUser(userId: string): Promise<ApiKeyInfo[]>;
  /** Revokes the user's own live key; false when there is none (unknown, someone else's, or already revoked). */
  revoke(id: string, userId: string, at: Date): Promise<boolean>;
  findByHash(keyHash: string): Promise<ApiKeyInfo | undefined>;
  /** Records a use; may skip the write when the last one is recent. */
  touch(id: string, at: Date): Promise<void>;
}

export type PostResult =
  { status: "posted"; entry: LedgerEntry; balance: number } | { status: "duplicate" } | { status: "no_user" };

export interface LedgerStore {
  /** One transaction: lock the balance row, insert the entry (idempotent by key), update the balance. */
  post(entry: NewEntry): Promise<PostResult>;
  balance(userId: string): Promise<number | undefined>;
  /** Newest first; `offset` rows are skipped. */
  entries(userId: string, limit: number, offset?: number): Promise<LedgerEntry[]>;
  /** How many entries the user has. */
  countEntries(userId: string): Promise<number>;
  /** Every user's cached balance and entry sum (for `ledger:check`). */
  balanceSums(): Promise<BalanceSum[]>;
}

export interface GithubOAuth {
  authorizeUrl(state: string): string;
  /** Exchanges the callback code and reads the account; throws when GitHub refuses or is unreachable. */
  exchangeCode(code: string): Promise<GithubProfile>;
}

export interface ModelStore {
  /** Enabled catalog rows, by public id. */
  listEnabled(): Promise<Model[]>;
  /** The enabled row for a public id (what consumers send as `model`). */
  findEnabledById(id: string): Promise<Model | undefined>;
  /** The enabled row for a `ggufRef`; undefined when unknown or disabled. */
  findEnabledByGgufRef(ggufRef: string): Promise<Model | undefined>;
}

export interface WorkerStore {
  /** The durable row of this device (created on first sight, `last_seen_at` refreshed); returns its id. */
  upsert(userId: string, deviceKey: string, at: Date): Promise<string>;
  setReady(id: string, gpu: Gpu, model: string, at: Date): Promise<void>;
  touch(id: string, at: Date): Promise<void>;
}

export interface JobStore {
  /** A new `queued` job; returns its id. */
  create(input: { consumerId: string; modelId: string; lane: Lane; source: JobSource }): Promise<string>;
  /** A worker was picked (again, after a requeue). Ignored once the job has ended. */
  markRunning(jobId: string, providerId: string, workerId: string, at: Date): Promise<void>;
  /** Ends a job that moved no credits. Ignored once the job has ended. */
  finish(jobId: string, status: Extract<JobStatus, "failed" | "cancelled">, errorCode: string, at: Date): Promise<void>;
  /**
   * One transaction: lock both balance rows (in id order), write the `spend` and `earn` entries (keys
   * `job:<id>:spend` / `job:<id>:earn`), update both balances, mark the job succeeded. A second call is a no-op.
   */
  settle(input: SettleInput): Promise<SettleResult>;
  /** Newest first; `offset` rows are skipped. `servedBy` and `vote` are filled only for finished jobs. */
  listByConsumer(userId: string, limit: number, offset?: number): Promise<JobHistoryRow[]>;
  /** How many requests the user has made as consumer. */
  countByConsumer(userId: string): Promise<number>;
  /** Succeeded jobs served by this user. */
  providerTotals(userId: string): Promise<ProviderTotals>;
  /** Latest vote per (voter, provider) wins. False unless the job is the voter's own, succeeded and has a provider. */
  vote(voterId: string, jobId: string, value: 1 | -1): Promise<boolean>;
  /** Marks every queued or running job failed (`api_restart`): called at startup, when nothing can be in flight. */
  abandonUnfinished(at: Date): Promise<number>;
}

/** One row of the public leaderboard before the live "online" flag is added. `userId` never leaves core. */
export interface ProviderRank {
  userId: string;
  displayName: string;
  deviceLabel: string | null;
  /** The GPU of the user's most recently seen device that announced one. */
  gpu: Gpu | null;
  /** Public id of the model that device last loaded. */
  model: string | null;
  tokensServed: number;
  creditsEarned: number;
  /** Average decode tokens/s of the last 50 succeeded jobs; null without any. */
  tokensPerS: number | null;
}

/** Read-only aggregates behind the public pages. */
export interface PublicStore {
  /** Prompt + completion tokens and the count of succeeded jobs. */
  totals(): Promise<{ tokensServed: number; jobsServed: number }>;
  /** Providers by tokens served (succeeded jobs), most first. */
  topProviders(limit: number): Promise<ProviderRank[]>;
}
