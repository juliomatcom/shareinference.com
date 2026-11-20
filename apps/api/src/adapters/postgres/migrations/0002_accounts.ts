import type { Knex } from "knex";

export async function up(db: Knex): Promise<void> {
  await db.schema.createTable("users", (t) => {
    t.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
    // Negative ids are local test users made by `users dev-session`; GitHub ids are positive.
    t.bigInteger("github_id").notNullable().unique("users_github_id_key");
    t.text("github_login").notNullable();
    t.timestamp("github_created_at", { useTz: true }).notNullable();
    t.text("avatar_url");
    t.text("display_name").notNullable();
    t.text("device_label");
    t.timestamp("suspended_at", { useTz: true });
    t.jsonb("rate_limit_override");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(db.fn.now());
  });
  await db.raw(
    `ALTER TABLE users ADD CONSTRAINT users_display_name_check CHECK (display_name ~ '^[A-Za-z0-9_-]{3,32}$')`,
  );
  await db.raw(`CREATE UNIQUE INDEX users_display_name_lower_key ON users (lower(display_name))`);
  await db.raw(`CREATE INDEX users_github_login_lower_idx ON users (lower(github_login))`);

  await db.schema.createTable("sessions", (t) => {
    t.text("token_hash").primary();
    t.uuid("user_id").notNullable().references("id").inTable("users").onDelete("CASCADE");
    t.timestamp("expires_at", { useTz: true }).notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.index("user_id");
    t.index("expires_at");
  });

  await db.schema.createTable("api_keys", (t) => {
    t.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
    t.uuid("user_id").notNullable().references("id").inTable("users").onDelete("CASCADE");
    t.text("name").notNullable();
    t.text("prefix").notNullable();
    t.text("key_hash").notNullable().unique("api_keys_key_hash_key");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.timestamp("last_used_at", { useTz: true });
    t.timestamp("revoked_at", { useTz: true });
    t.index("user_id");
  });

  await db.schema.createTable("balances", (t) => {
    t.uuid("user_id").primary().references("id").inTable("users").onDelete("CASCADE");
    t.bigInteger("balance").notNullable().defaultTo(0);
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(db.fn.now());
  });

  await db.schema.createTable("ledger_entries", (t) => {
    t.bigIncrements("id");
    // RESTRICT: a user with entries cannot be deleted; the ledger is append-only.
    t.uuid("user_id").notNullable().references("id").inTable("users").onDelete("RESTRICT");
    t.bigInteger("amount").notNullable();
    t.text("kind").notNullable();
    // References `jobs` once that table exists (Phase 4).
    t.uuid("job_id");
    t.text("note");
    t.text("idempotency_key").notNullable().unique("ledger_entries_idempotency_key_key");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.index(["user_id", "id"]);
  });
  await db.raw(
    `ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_kind_check CHECK (kind IN ('grant', 'spend', 'earn', 'adjust'))`,
  );
  await db.raw(`ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_amount_check CHECK (amount <> 0)`);
  // Append-only, enforced where it cannot be bypassed by a bug in the api.
  await db.raw(`
    CREATE FUNCTION ledger_entries_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'ledger_entries is append-only';
    END $$
  `);
  await db.raw(`
    CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only()
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.schema.dropTable("ledger_entries");
  await db.raw("DROP FUNCTION ledger_entries_append_only()");
  await db.schema.dropTable("balances");
  await db.schema.dropTable("api_keys");
  await db.schema.dropTable("sessions");
  await db.schema.dropTable("users");
}
