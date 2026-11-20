import type { ApiKeyStore, NewApiKey } from "../../core/ports.js";
import type { ApiKeyInfo } from "../../core/types.js";
import type { Db } from "./db.js";
import { safeInt, toApiKey } from "./rows.js";

/** Writing `last_used_at` on every request would make each call a write; once a minute is enough for display. */
const TOUCH_INTERVAL_MS = 60_000;

/** Revoked keys listed after the live ones (the live ones are bounded by the per-user key limit). */
export const REVOKED_LISTED = 30;

export class PostgresApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: Db) {}

  async create(input: NewApiKey, maxActive: number): Promise<ApiKeyInfo | undefined> {
    return this.db.transaction(async (trx) => {
      // The user row is the lock: parallel creations for one user take turns, so the count below stays true.
      await trx("users").where({ id: input.userId }).forUpdate().first("id");
      const counted = await trx("api_keys").where({ user_id: input.userId }).whereNull("revoked_at").count({ n: "*" });
      if (safeInt(counted[0]?.n) >= maxActive) return undefined;
      const [row] = await trx("api_keys")
        .insert({ user_id: input.userId, name: input.name, prefix: input.prefix, key_hash: input.keyHash })
        .returning("*");
      return toApiKey(row);
    });
  }

  async listByUser(userId: string): Promise<ApiKeyInfo[]> {
    const live = await this.db("api_keys")
      .where({ user_id: userId })
      .whereNull("revoked_at")
      .orderBy("created_at", "desc");
    const revoked = await this.db("api_keys")
      .where({ user_id: userId })
      .whereNotNull("revoked_at")
      .orderBy("revoked_at", "desc")
      .orderBy("created_at", "desc")
      .limit(REVOKED_LISTED);
    return [...live, ...revoked].map(toApiKey);
  }

  async revoke(id: string, userId: string, at: Date): Promise<boolean> {
    const updated = await this.db("api_keys")
      .where({ id, user_id: userId })
      .whereNull("revoked_at")
      .update({ revoked_at: at });
    return updated === 1;
  }

  async findByHash(keyHash: string): Promise<ApiKeyInfo | undefined> {
    const row = await this.db("api_keys").where({ key_hash: keyHash }).first();
    return row && toApiKey(row);
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.db("api_keys")
      .where({ id })
      .andWhere((q) =>
        q.whereNull("last_used_at").orWhere("last_used_at", "<", new Date(at.getTime() - TOUCH_INTERVAL_MS)),
      )
      .update({ last_used_at: at });
  }
}
