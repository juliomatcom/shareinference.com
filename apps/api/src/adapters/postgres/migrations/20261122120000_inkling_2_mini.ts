import type { Knex } from "knex";

// Inkling-2-Mini (26B MoE, 3.4B active), bartowski IQ3_XXS pinned to a revision. Not unsloth's file: every unsloth
// Inkling GGUF stores NVFP4 tensors, which produce NaN logits on llama.cpp's WebGPU backend (spikes/s3-inkling-webgpu).
// `vram_mb` is measured at its 8192 context (see `CONTEXT_WINDOWS`): WebGPU model 12209.17 + KV 256 + 240 + recurrent
// state 3.66 + compute 980.23 MiB, rounded up. x3 credits per token because a token costs about 5 times a Qwen 4B's
// compute and the file needs a 16 GB GPU or better.
const INKLING = {
  id: "inkling-2-mini",
  gguf_ref:
    "bartowski/thinkingmachines_Inkling-2-Mini-GGUF@76d57028717ed7c63f5e90de75234cae0bc9b360/thinkingmachines_Inkling-2-Mini-IQ3_XXS.gguf",
  vram_mb: 13689,
  price_multiplier: 3,
  enabled: true,
};

export async function up(db: Knex): Promise<void> {
  await db("models").insert(INKLING).onConflict("id").ignore();
}

// `jobs.model_id` references models with ON DELETE RESTRICT, so once the ledger holds jobs for this model the rollback
// fails loudly instead of orphaning or erasing billed history. Disable the row (`enabled = false`) to retire it live.
export async function down(db: Knex): Promise<void> {
  await db("models").where({ id: INKLING.id }).delete();
}
