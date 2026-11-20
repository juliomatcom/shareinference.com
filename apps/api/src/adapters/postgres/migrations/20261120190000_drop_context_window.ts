import type { Knex } from "knex";

// The context window moved into code (`CONTEXT_WINDOWS` in core/models.ts): changing it is a redeploy, not a row edit.
export async function up(db: Knex): Promise<void> {
  await db.schema.alterTable("models", (t) => t.dropColumn("context_window"));
}

export async function down(db: Knex): Promise<void> {
  await db.schema.alterTable("models", (t) => t.integer("context_window").notNullable().defaultTo(4096));
}
