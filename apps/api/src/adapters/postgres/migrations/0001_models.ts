import type { Knex } from "knex";

export async function up(db: Knex): Promise<void> {
  await db.schema.createTable("models", (t) => {
    t.text("id").primary(); // public id, e.g. qwen3.5-4b
    t.text("webllm_id").notNullable().unique();
    t.integer("context_window").notNullable();
    t.integer("vram_mb").notNullable();
    t.integer("price_multiplier").notNullable().defaultTo(1).checkPositive("models_price_multiplier_check");
    t.boolean("enabled").notNullable().defaultTo(true);
  });
  await db("models").insert({
    id: "qwen3.5-4b",
    webllm_id: "Qwen3.5-4B-q4f16_1-MLC",
    context_window: 4096,
    vram_mb: 3868,
    price_multiplier: 1,
    enabled: true,
  });
}

export async function down(db: Knex): Promise<void> {
  await db.schema.dropTable("models");
}
