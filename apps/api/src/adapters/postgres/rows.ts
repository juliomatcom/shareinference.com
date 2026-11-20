import type { ApiKeyInfo, LedgerEntry, LedgerKind, RateLimitOverride, User } from "../../core/types.js";

// pg returns bigint columns as strings. Ours must fit a safe integer (credits are capped, GitHub ids are small);
// anything else is corruption and fails loudly instead of silently losing precision.
export type Row = Record<string, unknown>;

export function safeInt(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n)) throw new Error("database integer outside the safe range");
  return n;
}

export function toUser(r: Row): User {
  return {
    id: r.id as string,
    githubId: safeInt(r.github_id),
    githubLogin: r.github_login as string,
    githubCreatedAt: r.github_created_at as Date,
    avatarUrl: (r.avatar_url as string | null) ?? null,
    displayName: r.display_name as string,
    deviceLabel: (r.device_label as string | null) ?? null,
    suspendedAt: (r.suspended_at as Date | null) ?? null,
    rateLimitOverride: (r.rate_limit_override as RateLimitOverride | null) ?? null,
    createdAt: r.created_at as Date,
  };
}

export function toApiKey(r: Row): ApiKeyInfo {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    name: r.name as string,
    prefix: r.prefix as string,
    createdAt: r.created_at as Date,
    lastUsedAt: (r.last_used_at as Date | null) ?? null,
    revokedAt: (r.revoked_at as Date | null) ?? null,
  };
}

export function toEntry(r: Row): LedgerEntry {
  return {
    id: safeInt(r.id),
    userId: r.user_id as string,
    amount: safeInt(r.amount),
    kind: r.kind as LedgerKind,
    jobId: (r.job_id as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    createdAt: r.created_at as Date,
  };
}

/** Postgres unique violation on the named constraint or index. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === "23505" && e.constraint === constraint;
}
