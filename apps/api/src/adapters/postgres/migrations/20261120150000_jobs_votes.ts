import type { Knex } from "knex";

// One row per consumer request. No prompt or completion text is ever stored here (wiki-llm/data-model.md).
export async function up(db: Knex): Promise<void> {
  await db.schema.createTable("jobs", (t) => {
    t.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
    t.uuid("consumer_id").notNullable().references("id").inTable("users").onDelete("RESTRICT");
    // Null until a worker is picked.
    t.uuid("provider_id").references("id").inTable("users").onDelete("RESTRICT");
    // A device row may be pruned later (20 per user); the job keeps its provider.
    t.uuid("worker_id").references("id").inTable("workers").onDelete("SET NULL");
    t.text("model_id").notNullable().references("id").inTable("models").onDelete("RESTRICT");
    t.text("lane").notNullable();
    t.text("status").notNullable().defaultTo("queued");
    t.integer("prompt_tokens");
    t.integer("completion_tokens");
    t.bigInteger("credits");
    t.double("decode_tps");
    t.text("error_code");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.timestamp("started_at", { useTz: true });
    t.timestamp("finished_at", { useTz: true });
  });
  await db.raw(`ALTER TABLE jobs ADD CONSTRAINT jobs_lane_check CHECK (lane IN ('priority', 'fair'))`);
  await db.raw(
    `ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))`,
  );
  // Consumer history (newest first) and provider totals.
  await db.raw(`CREATE INDEX jobs_consumer_created_idx ON jobs (consumer_id, created_at DESC)`);
  await db.raw(`CREATE INDEX jobs_provider_status_idx ON jobs (provider_id, status)`);

  await db.schema.createTable("votes", (t) => {
    t.uuid("voter_id").notNullable().references("id").inTable("users").onDelete("CASCADE");
    t.uuid("provider_id").notNullable().references("id").inTable("users").onDelete("CASCADE");
    t.smallint("value").notNullable();
    t.uuid("job_id").references("id").inTable("jobs").onDelete("SET NULL");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.primary(["voter_id", "provider_id"]);
  });
  await db.raw(`ALTER TABLE votes ADD CONSTRAINT votes_value_check CHECK (value IN (-1, 1))`);
}

export async function down(db: Knex): Promise<void> {
  await db.schema.dropTable("votes");
  await db.schema.dropTable("jobs");
}
