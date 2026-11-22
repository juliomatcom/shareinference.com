/**
 * Context window per public model id, in tokens: the one place this number lives (wiki-llm/architecture.md). The api
 * admits requests against it and the Share page loads the model with it as the engine's context size. 4096 is the
 * fallback; raise an entry after measuring GPU memory and speed on a real device, then redeploy.
 */
// 16k for the Qwen3.5 family and gemma-4-e2b. The KV cache at 16k is small for all of them: Qwen3.5 is hybrid (1 in 4
// layers use full attention: 192 MiB for the 2B, 512 MiB for the 4B and 9B) and gemma-4-e2b stores KV in only 15 of its
// 35 layers with one KV head (about 0.3 to 0.5 GiB, worst case). Estimates from the configs; raise further only after
// measuring on a real device.
// inkling-2-mini stays at 8k: its 13.7 GiB at that window (12.2 GiB of weights) fits a 16 GB GPU, and its prefill
// (84 tok/s) lets a full 8K prompt reach the first chunk inside the Playground's job time (see MIN_PREFILL_TPS).
export const CONTEXT_WINDOWS: Record<string, number> = {
  "qwen3.5-2b": 16384,
  "qwen3.5-4b": 16384,
  "qwen3.5-9b": 16384,
  "gemma-4-e2b": 16384,
  "inkling-2-mini": 8192,
};
export const DEFAULT_CONTEXT_WINDOW = 4096;
export const contextWindowFor = (modelId: string): number => CONTEXT_WINDOWS[modelId] ?? DEFAULT_CONTEXT_WINDOW;

/**
 * Slowest prefill (tokens/s) we still wait for, per public id: about half of what an M5 Pro measured near a full 16K
 * prompt with the patched engine (4B: 144 tok/s, gemma: 380 tok/s, both at about 12 to 14K tokens). Inkling: 84 tok/s
 * measured at a 4.8K prompt on the same machine (spikes/s3-inkling-webgpu), so 42; a full 8K prompt then waits
 * 30 s + 195 s = 225 s, just under the Playground's 240 s cap.
 */
export const MIN_PREFILL_TPS: Record<string, number> = {
  "qwen3.5-2b": 150,
  "qwen3.5-4b": 72,
  "qwen3.5-9b": 50,
  "gemma-4-e2b": 190,
  "inkling-2-mini": 42,
};
const DEFAULT_MIN_PREFILL_TPS = 50;
const FIRST_CHUNK_BASE_MS = 30_000;
const FIRST_CHUNK_MIN_MS = 90_000;

/** Time to first chunk for this prompt: at least 90 s, and always leaves a fifth of the job's total time to generate. */
export function firstChunkTimeoutMs(modelId: string, promptTokens: number, jobTimeoutMs: number): number {
  const tps = MIN_PREFILL_TPS[modelId] ?? DEFAULT_MIN_PREFILL_TPS;
  const wanted = FIRST_CHUNK_BASE_MS + (promptTokens / tps) * 1000;
  return Math.round(Math.min(Math.max(wanted, FIRST_CHUNK_MIN_MS), jobTimeoutMs * 0.8));
}

/** A model in the catalog: the public id consumers use, mapped to the `ggufRef` (`owner/repo@<revision>/file.gguf`) providers load. */
export interface Model {
  id: string;
  ggufRef: string;
  contextWindow: number;
  vramMb: number;
  priceMultiplier: number;
  enabled: boolean;
}
