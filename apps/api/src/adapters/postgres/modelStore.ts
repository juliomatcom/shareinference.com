import { contextWindowFor, type Model } from "../../core/models.js";
import type { ModelStore } from "../../core/ports.js";
import type { Db } from "./db.js";
import type { Row } from "./rows.js";

const toModel = (r: Row): Model => ({
  id: r.id as string,
  webllmId: r.webllm_id as string,
  contextWindow: contextWindowFor(r.id as string),
  vramMb: r.vram_mb as number,
  priceMultiplier: r.price_multiplier as number,
  enabled: r.enabled as boolean,
});

export class PostgresModelStore implements ModelStore {
  constructor(private readonly db: Db) {}

  async listEnabled(): Promise<Model[]> {
    return (await this.db("models").where({ enabled: true }).orderBy("id")).map(toModel);
  }

  async findEnabledById(id: string): Promise<Model | undefined> {
    const row = await this.db("models").where({ id, enabled: true }).first();
    return row && toModel(row);
  }

  async findEnabledByWebllmId(webllmId: string): Promise<Model | undefined> {
    const row = await this.db("models").where({ webllm_id: webllmId, enabled: true }).first();
    return row && toModel(row);
  }
}
