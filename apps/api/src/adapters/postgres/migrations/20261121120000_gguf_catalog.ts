import type { Knex } from "knex";

// The browser runtime moved from WebLLM (MLC builds) to wllama (GGUF files), so a catalog row now names the file
// providers load: `owner/repo@<40-hex revision>/file.gguf`. The revision is pinned so a repo update never changes what
// providers run. `vram_mb` is re-measured with the wllama engine at a 16K context: WebGPU model + KV + recurrent state +
// compute buffers (MiB, rounded up). `vram` holds [old (WebLLM), next] for each model.
const MODELS = [
  {
    id: "qwen3.5-2b",
    vram: [2245, 1491] as const,
    old: "Qwen3.5-2B-q4f16_1-MLC",
    next: "unsloth/Qwen3.5-2B-GGUF@f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf",
  },
  {
    id: "qwen3.5-4b",
    vram: [3868, 3256] as const,
    old: "Qwen3.5-4B-q4f16_1-MLC",
    next: "unsloth/Qwen3.5-4B-GGUF@e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf",
  },
  {
    id: "qwen3.5-9b",
    vram: [6433, 5544] as const,
    old: "Qwen3.5-9B-q4f16_1-MLC",
    next: "unsloth/Qwen3.5-9B-GGUF@3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf",
  },
  {
    id: "gemma-4-e2b",
    vram: [3387, 1615] as const,
    old: "gemma-4-E2B-it-q4f16_1-MLC",
    next: "unsloth/gemma-4-E2B-it-GGUF@0314792d7f1f7e229411f620751375812bb9faf2/gemma-4-E2B-it-Q4_K_M.gguf",
  },
];

// `workers.last_model` holds the model id the worker announced and the leaderboard joins it to the catalog, so it moves
// with the catalog. Other values stay. `from`/`to` pick the direction; `column` is the model column's current name.
async function remap(db: Knex, from: "old" | "next", to: "old" | "next", column: string): Promise<void> {
  const vramAt = (m: (typeof MODELS)[number], side: "old" | "next") => m.vram[side === "old" ? 0 : 1];
  for (const m of MODELS) await db("workers").where({ last_model: m[from] }).update({ last_model: m[to] });
  for (const m of MODELS)
    await db("models")
      .where({ id: m.id })
      .update({ [column]: m[to], vram_mb: vramAt(m, to) });
}

async function renameUnique(db: Knex, to: string): Promise<void> {
  // Look the name up instead of assuming Knex's default, so a database created another way still migrates.
  const { rows } = await db.raw(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'models'::regclass AND contype = 'u'`,
  );
  const name = rows[0]?.conname as string | undefined;
  if (name && name !== to) await db.raw(`ALTER TABLE models RENAME CONSTRAINT ?? TO ??`, [name, to]);
}

export async function up(db: Knex): Promise<void> {
  await db.schema.alterTable("models", (t) => t.renameColumn("webllm_id", "gguf_ref"));
  await renameUnique(db, "models_gguf_ref_unique");
  await remap(db, "old", "next", "gguf_ref");
}

export async function down(db: Knex): Promise<void> {
  await db.schema.alterTable("models", (t) => t.renameColumn("gguf_ref", "webllm_id"));
  await remap(db, "next", "old", "webllm_id");
  await renameUnique(db, "models_webllm_id_unique");
}
