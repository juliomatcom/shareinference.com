import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, migrationStatus, rollback, type Db } from "../src/adapters/postgres/db.js";

const url = process.env.TEST_DATABASE_URL;

// Runs in its own schema so a shared test database stays clean.
describe.skipIf(!url)("migrations", () => {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  let admin: Db;
  let db: Db;

  beforeAll(async () => {
    admin = createDb(url!, 2);
    await admin.raw(`CREATE SCHEMA ${schema}`);
    db = createDb(url!, 2, { searchPath: schema });
  });
  afterAll(async () => {
    await db.destroy();
    await admin.raw(`DROP SCHEMA ${schema} CASCADE`);
    await admin.destroy();
  });

  it("latest creates models with the seed row, rollback drops it", async () => {
    await migrate(db);
    expect((await migrationStatus(db)).applied).toContain("0001_models");
    expect(
      await db("models").select("id", "webllm_id", "context_window", "vram_mb", "price_multiplier", "enabled"),
    ).toEqual([
      {
        id: "qwen3.5-4b",
        webllm_id: "Qwen3.5-4B-q4f16_1-MLC",
        context_window: 4096,
        vram_mb: 3868,
        price_multiplier: 1,
        enabled: true,
      },
    ]);
    await rollback(db);
    expect(await db.schema.hasTable("models")).toBe(false);
  });

  it("0002 creates the account tables and rollback removes them", async () => {
    await migrate(db);
    expect((await migrationStatus(db)).applied).toEqual(
      expect.arrayContaining(["0002_accounts", "20261120130000_ledger_truncate_guard"]),
    );
    for (const table of ["users", "sessions", "api_keys", "ledger_entries", "balances"]) {
      expect(await db.schema.hasTable(table), table).toBe(true);
    }
    await rollback(db);
    for (const table of ["users", "sessions", "api_keys", "ledger_entries", "balances"]) {
      expect(await db.schema.hasTable(table), table).toBe(false);
    }
  });
});
