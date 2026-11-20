import type { Knex } from "knex";

// The leaderboard reads each provider's latest succeeded jobs (average decode speed): newest first per provider.
export async function up(db: Knex): Promise<void> {
  await db.raw(
    `CREATE INDEX jobs_provider_finished_idx ON jobs (provider_id, finished_at DESC) WHERE status = 'succeeded'`,
  );
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`DROP INDEX jobs_provider_finished_idx`);
}
