import type { WorkerStore } from "../../core/ports.js";
import type { Gpu } from "../../core/protocol.js";
import type { Db } from "./db.js";

/** Durable device rows kept per user; the least recently seen beyond this are deleted. */
export const MAX_WORKER_ROWS = 20;

export class PostgresWorkerStore implements WorkerStore {
  constructor(private readonly db: Db) {}

  async upsert(userId: string, deviceKey: string, at: Date): Promise<string> {
    return this.db.transaction(async (trx) => {
      // The user row is the lock, so parallel first connections of one user cannot overshoot the cap.
      await trx("users").where({ id: userId }).forUpdate().first("id");
      const [row] = await trx("workers")
        .insert({ user_id: userId, device_key: deviceKey, last_seen_at: at })
        .onConflict(["user_id", "device_key"])
        .merge({ last_seen_at: at })
        .returning("id");
      const id = row.id as string;
      // A new device beyond the cap replaces the user's least recently seen one (this row is the freshest).
      await trx("workers")
        .where({ user_id: userId })
        .whereNotIn(
          "id",
          trx("workers")
            .where({ user_id: userId })
            .orderByRaw("id = ? desc, last_seen_at desc", [id])
            .limit(MAX_WORKER_ROWS)
            .select("id"),
        )
        .delete();
      return id;
    });
  }

  async setReady(id: string, gpu: Gpu, model: string, at: Date): Promise<void> {
    await this.db("workers")
      .where({ id })
      .update({ gpu: JSON.stringify(gpu), last_model: model, last_seen_at: at });
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.db("workers").where({ id }).update({ last_seen_at: at });
  }
}
