export type LedgerKind = "grant" | "spend" | "earn" | "adjust";

export interface RateLimitOverride {
  perMin: number;
  perDay: number;
}

export interface User {
  id: string;
  githubId: number;
  githubLogin: string;
  githubCreatedAt: Date;
  avatarUrl: string | null;
  displayName: string;
  deviceLabel: string | null;
  suspendedAt: Date | null;
  rateLimitOverride: RateLimitOverride | null;
  createdAt: Date;
}

/** What a user row needs at creation; the rest (device label, suspension, override) starts empty. */
export type NewUser = Pick<User, "githubId" | "githubLogin" | "githubCreatedAt" | "avatarUrl" | "displayName">;

/** The GitHub account behind a sign-in. */
export interface GithubProfile {
  githubId: number;
  login: string;
  createdAt: Date;
  avatarUrl: string | null;
}

export interface Session {
  userId: string;
  expiresAt: Date;
}

/** An API key as listed: never the secret, only its display prefix. */
export interface ApiKeyInfo {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface NewEntry {
  userId: string;
  /** Signed integer credits. */
  amount: number;
  kind: LedgerKind;
  note: string | null;
  jobId?: string | null;
  /** Posting twice with one key changes nothing. */
  idempotencyKey: string;
}

export interface LedgerEntry {
  id: number;
  userId: string;
  amount: number;
  kind: LedgerKind;
  jobId: string | null;
  note: string | null;
  createdAt: Date;
}

/** One user's cached balance next to the sum of their entries (`null`: no balances row). */
export interface BalanceSum {
  userId: string;
  balance: number | null;
  entriesSum: number;
}

export type Lane = "priority" | "fair";
/** Where a job came from: an API key (`/v1`) or a signed-in browser session (the Playground). */
export type JobSource = "api" | "playground";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** The consumer's own view of one request (wiki-llm/api.md `GET /jobs`). */
export interface JobHistoryRow {
  id: string;
  /** Public model id. */
  modelId: string;
  status: JobStatus;
  source: JobSource;
  promptTokens: number | null;
  completionTokens: number | null;
  credits: number | null;
  createdAt: Date;
  finishedAt: Date | null;
  /** The provider's display name; null while the job is unfinished or was never dispatched. */
  servedBy: string | null;
  /** The consumer's own vote for that provider. */
  vote: 1 | -1 | null;
}

export interface ProviderTotals {
  jobsServed: number;
  promptTokens: number;
  completionTokens: number;
  creditsEarned: number;
}

export interface SettleInput {
  jobId: string;
  consumerId: string;
  providerId: string;
  /** Integer credits; 0 writes no ledger entries. */
  credits: number;
  promptTokens: number;
  completionTokens: number;
  decodeTps: number;
  at: Date;
}

/** `closed`: the job already ended as failed or cancelled (or does not exist); nothing moved. */
export type SettleResult = "settled" | "duplicate" | "closed";
