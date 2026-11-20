import type { Knex } from "knex";

// Catalog growth (WebLLM 0.2.89 prebuilt records, q4f16_1, context capped at 4096 like the first model).
// gemma-4-e2b was loaded and answered on a real GPU (2026-11-20), so all three are enabled.
const ADDED = [
  { id: "qwen3.5-2b", webllm_id: "Qwen3.5-2B-q4f16_1-MLC", vram_mb: 2245, price_multiplier: 1, enabled: true },
  { id: "qwen3.5-9b", webllm_id: "Qwen3.5-9B-q4f16_1-MLC", vram_mb: 6433, price_multiplier: 2, enabled: true },
  { id: "gemma-4-e2b", webllm_id: "gemma-4-E2B-it-q4f16_1-MLC", vram_mb: 3387, price_multiplier: 1, enabled: true },
].map((m) => ({ ...m, context_window: 4096 }));

export async function up(db: Knex): Promise<void> {
  await db("models").insert(ADDED).onConflict("id").ignore();
}

export async function down(db: Knex): Promise<void> {
  await db("models")
    .whereIn(
      "id",
      ADDED.map((m) => m.id),
    )
    .delete();
}
