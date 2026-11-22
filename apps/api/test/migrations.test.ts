import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as gguf from "../src/adapters/postgres/migrations/20261121120000_gguf_catalog.js";
import * as inkling from "../src/adapters/postgres/migrations/20261122120000_inkling_2_mini.js";
import { readyFrame } from "../src/core/protocol.js";
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

  it("latest creates models with the seed rows, rollback drops them", async () => {
    await migrate(db);
    expect((await migrationStatus(db)).applied).toEqual(
      expect.arrayContaining(["0001_models", "20261120180000_more_models", "20261120190000_drop_context_window"]),
    );
    expect(await db("models").select("id", "gguf_ref", "vram_mb", "price_multiplier", "enabled").orderBy("id")).toEqual(
      [
        {
          id: "gemma-4-e2b",
          gguf_ref: "unsloth/gemma-4-E2B-it-GGUF@0314792d7f1f7e229411f620751375812bb9faf2/gemma-4-E2B-it-Q4_K_M.gguf",
          vram_mb: 1615,
          price_multiplier: 1,
          enabled: true,
        },
        {
          id: "inkling-2-mini",
          gguf_ref:
            "bartowski/thinkingmachines_Inkling-2-Mini-GGUF@76d57028717ed7c63f5e90de75234cae0bc9b360/thinkingmachines_Inkling-2-Mini-IQ3_XXS.gguf",
          vram_mb: 13689,
          price_multiplier: 3,
          enabled: true,
        },
        {
          id: "qwen3.5-2b",
          gguf_ref: "unsloth/Qwen3.5-2B-GGUF@f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf",
          vram_mb: 1491,
          price_multiplier: 1,
          enabled: true,
        },
        {
          id: "qwen3.5-4b",
          gguf_ref: "unsloth/Qwen3.5-4B-GGUF@e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf",
          vram_mb: 3256,
          price_multiplier: 1,
          enabled: true,
        },
        {
          id: "qwen3.5-9b",
          gguf_ref: "unsloth/Qwen3.5-9B-GGUF@3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf",
          vram_mb: 5544,
          price_multiplier: 2,
          enabled: true,
        },
      ],
    );
    await rollback(db);
    expect(await db.schema.hasTable("models")).toBe(false);
  });

  it("every seeded gguf_ref is one the engine accepts and one a ready frame can carry", async () => {
    // Source of truth: REF in libs/wllama-webgpu/src/engine.js (it imports the wllama bundle, so it cannot be imported here).
    // The first assertion fails if the engine's copy drifts from this one.
    const REF = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40})\/([\w.-]+\.gguf)$/;
    const engine = readFileSync(new URL("../../../libs/wllama-webgpu/src/engine.js", import.meta.url), "utf8");
    expect(engine).toContain(`const REF = ${REF};`);

    await migrate(db);
    const refs = (await db("models").select("gguf_ref")).map((r) => r.gguf_ref as string);
    expect(refs.length).toBeGreaterThanOrEqual(5);
    for (const ref of refs) {
      expect(ref, ref).toMatch(REF);
      const gpu = { vendor: "v", architecture: "a", shaderF16: true, maxBufferSize: 1 };
      expect(readyFrame.safeParse({ type: "ready", model: ref, gpu, loadMs: 1 }).success, ref).toBe(true);
      expect(ref.length, ref).toBeLessThanOrEqual(256);
    }
    await rollback(db);
  });

  it("gguf_catalog remaps workers.last_model both ways and renames the unique constraint", async () => {
    await migrate(db);
    const old4b = "Qwen3.5-4B-q4f16_1-MLC";
    const ref4b = "unsloth/Qwen3.5-4B-GGUF@e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf";
    const [user] = await db("users")
      .insert({ github_id: 1, github_login: "mig", github_created_at: new Date(), display_name: "mig" })
      .returning("id");
    const worker = (device: string, last_model: string | null) => ({
      user_id: user.id,
      device_key: device,
      last_model,
    });
    await db("workers").insert([
      worker("device-aaaa", ref4b),
      worker("device-bbbb", "something-else"),
      worker("device-cccc", null),
    ]);
    const lastModels = async () =>
      (await db("workers").select("device_key", "last_model").orderBy("device_key")).map((r) => r.last_model);
    const uniques = async () =>
      (
        await db.raw(`SELECT conname FROM pg_constraint WHERE conrelid = 'models'::regclass AND contype = 'u'`)
      ).rows.map((r: { conname: string }) => r.conname);

    expect(await uniques()).toEqual(["models_gguf_ref_unique"]);
    await gguf.down(db);
    expect(await lastModels()).toEqual([old4b, "something-else", null]);
    expect((await db("models").where({ id: "qwen3.5-4b" }).first()).webllm_id).toBe(old4b);
    expect(await uniques()).toEqual(["models_webllm_id_unique"]);
    expect((await db("models").where({ id: "qwen3.5-4b" }).first()).vram_mb).toBe(3868);
    await gguf.up(db);
    expect(await lastModels()).toEqual([ref4b, "something-else", null]);
    expect((await db("models").where({ id: "qwen3.5-4b" }).first()).gguf_ref).toBe(ref4b);
    expect(await uniques()).toEqual(["models_gguf_ref_unique"]);
    expect((await db("models").where({ id: "qwen3.5-4b" }).first()).vram_mb).toBe(3256);
    await rollback(db);
  });

  it("inkling_2_mini adds one row, is idempotent, and down removes only it", async () => {
    await migrate(db);
    const ids = async () => (await db("models").select("id").orderBy("id")).map((r) => r.id);
    expect(await ids()).toContain("inkling-2-mini");
    await inkling.up(db); // a second run changes nothing (onConflict ignore)
    expect(await db("models").where({ id: "inkling-2-mini" })).toHaveLength(1);
    await inkling.down(db);
    expect(await ids()).toEqual(["gemma-4-e2b", "qwen3.5-2b", "qwen3.5-4b", "qwen3.5-9b"]);
    await inkling.up(db);
    expect(await ids()).toContain("inkling-2-mini");
    await rollback(db);
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
