import { loadConfig } from "./adapters/config.js";
import { createLogger } from "./adapters/logger.js";
import { createDb, makeMigration, migrate, migrationStatus, rollback } from "./adapters/postgres/db.js";

// Schema migrations by hand: `latest` | `rollback` | `status` | `make <name>`.
// The api also applies pending migrations itself on start.
const [command = "latest", name] = process.argv.slice(2);
const usage = "usage: migrate latest | rollback | status | make <name>";
// Default level until config is loaded (`make` never loads it).
const bootLog = createLogger("migrate");

async function main(): Promise<void> {
  if (command === "make") {
    if (!name) throw new Error(usage);
    bootLog.info("migration created", { file: await makeMigration(name) });
    return;
  }
  const config = loadConfig();
  const log = createLogger("migrate", config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, config.DB_POOL_MAX, { log: createLogger("db", config.LOG_LEVEL) });
  try {
    if (command === "latest") await migrate(db, log);
    else if (command === "rollback") await rollback(db, log);
    else if (command === "status") log.info("migrations", await migrationStatus(db));
    else throw new Error(usage);
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  bootLog.error("migration command failed", { error: String(error.message ?? error) });
  process.exit(1);
});
