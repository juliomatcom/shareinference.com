import type { Knex } from "knex";

// Where a request came from: the API (key) or the web Playground (session). Existing rows are all API requests.
export async function up(db: Knex): Promise<void> {
  await db.raw(`ALTER TABLE jobs ADD COLUMN source text NOT NULL DEFAULT 'api'`);
  await db.raw(`ALTER TABLE jobs ADD CONSTRAINT jobs_source_check CHECK (source IN ('api', 'playground'))`);
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`ALTER TABLE jobs DROP CONSTRAINT jobs_source_check`);
  await db.raw(`ALTER TABLE jobs DROP COLUMN source`);
}
