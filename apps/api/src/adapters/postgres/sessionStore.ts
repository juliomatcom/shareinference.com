import type { SessionStore } from "../../core/ports.js";
import type { Session } from "../../core/types.js";
import type { Db } from "./db.js";

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly db: Db) {}

  async create(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
    await this.db("sessions").insert({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt });
  }

  async find(tokenHash: string): Promise<Session | undefined> {
    const row = await this.db("sessions").where({ token_hash: tokenHash }).first();
    return row && { userId: row.user_id as string, expiresAt: row.expires_at as Date };
  }

  async delete(tokenHash: string): Promise<void> {
    await this.db("sessions").where({ token_hash: tokenHash }).delete();
  }

  async purgeExpired(now: Date): Promise<void> {
    await this.db("sessions").where("expires_at", "<=", now).delete();
  }
}
