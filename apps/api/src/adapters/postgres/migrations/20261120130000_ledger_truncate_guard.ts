import type { Knex } from "knex";

// 0002 blocks UPDATE and DELETE row by row; TRUNCATE skips row triggers, so it gets its own statement-level guard.
export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_append_only()
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw("DROP TRIGGER ledger_entries_no_truncate ON ledger_entries");
}
