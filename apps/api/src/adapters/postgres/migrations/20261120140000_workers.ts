import type { Knex } from "knex";

// Durable identity of a provider device; live state (ready/busy) stays in memory.
export async function up(db: Knex): Promise<void> {
  await db.schema.createTable("workers", (t) => {
    t.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
    t.uuid("user_id").notNullable().references("id").inTable("users").onDelete("CASCADE");
    t.text("device_key").notNullable();
    t.jsonb("gpu");
    t.text("last_model");
    t.timestamp("last_seen_at", { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.unique(["user_id", "device_key"], { indexName: "workers_user_device_key" });
  });
  await db.raw(
    `ALTER TABLE workers ADD CONSTRAINT workers_device_key_check CHECK (device_key ~ '^[A-Za-z0-9_-]{8,64}$')`,
  );
}

export async function down(db: Knex): Promise<void> {
  await db.schema.dropTable("workers");
}
