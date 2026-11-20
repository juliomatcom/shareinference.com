import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import knex, { type Knex } from "knex";
import type { Logger } from "../../core/ports.js";

export type Db = Knex;

const MIGRATE_LOCK_KEY = 240_731;

/** `.ts` when run from source (tests), `.js` once built. */
const EXT = extname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

// Names are recorded without extension, so a database migrated from source and from the build agrees.
const migrationSource: Knex.MigrationSource<string> = {
  async getMigrations() {
    return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(EXT) && !f.endsWith(`.d${EXT}`)).sort();
  },
  getMigrationName: (file) => basename(file, EXT),
  getMigration: (file) => import(pathToFileURL(join(MIGRATIONS_DIR, file)).href),
};

const migratorConfig: Knex.MigratorConfig = { migrationSource };

/** `searchPath` isolates tests in their own schema; `log` (module `db`) receives knex's own messages (it prints nothing itself). */
export function createDb(url: string, poolMax: number, opts: { searchPath?: string; log?: Logger } = {}): Db {
  const { log } = opts;
  return knex({
    client: "pg",
    connection: url,
    pool: { min: 0, max: poolMax },
    log: {
      warn: (m) => log?.warn("knex warning", { message: String(m) }),
      error: (m) => log?.error("knex error", { message: String(m) }),
      deprecate: (m) => log?.warn("knex deprecated", { message: String(m) }),
      debug: (m) => log?.debug("knex debug", { message: String(m) }),
    },
    ...(opts.searchPath && { searchPath: [opts.searchPath] }),
  });
}

/** Holds a Postgres advisory lock while `fn` runs, so concurrent starts take turns. */
function withMigrateLock<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (lock) => {
    await lock.raw("SELECT pg_advisory_xact_lock(?)", [MIGRATE_LOCK_KEY]);
    return fn();
  });
}

export async function migrate(db: Db, log?: Logger): Promise<void> {
  await withMigrateLock(db, async () => {
    const [, applied] = (await db.migrate.latest(migratorConfig)) as [number, string[]];
    for (const name of applied) log?.info("migration applied", { name });
  });
}

export async function rollback(db: Db, log?: Logger): Promise<void> {
  await withMigrateLock(db, async () => {
    const [, reverted] = (await db.migrate.rollback(migratorConfig)) as [number, string[]];
    for (const name of reverted) log?.info("migration rolled back", { name });
  });
}

export async function migrationStatus(db: Db): Promise<{ applied: string[]; pending: string[] }> {
  const [done, pending] = (await db.migrate.list(migratorConfig)) as [{ name: string }[], string[]];
  return { applied: done.map((m) => m.name), pending: pending.map((f) => basename(f, EXT)) };
}

const SOURCE_DIR = join(process.cwd(), "src", "adapters", "postgres");

/** Creates an empty migration in the source tree (run from apps/api via `pnpm db:make`); returns its path. */
export function makeMigration(name: string): Promise<string> {
  return knex({ client: "pg" }).migrate.make(name, {
    directory: join(SOURCE_DIR, "migrations"),
    extension: "ts",
    stub: join(SOURCE_DIR, "migration.stub.ts"),
  });
}
