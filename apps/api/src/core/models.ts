/**
 * Context window per public model id, in tokens: the one place this number lives (wiki-llm/architecture.md). The api
 * admits requests against it and the Share page loads WebLLM with it as `context_window_size`. WebLLM's prebuilt
 * records ship 4096; raise an entry after measuring GPU memory and speed on a real device, then redeploy.
 */
// 16k for the Qwen3.5 family and gemma-4-e2b. The KV cache at 16k is small for all of them: Qwen3.5 is hybrid (1 in 4
// layers use full attention: 192 MiB for the 2B, 512 MiB for the 4B and 9B) and gemma-4-e2b stores KV in only 15 of its
// 35 layers with one KV head (about 0.3 to 0.5 GiB, worst case). Estimates from the configs; raise further only after
// measuring on a real device.
export const CONTEXT_WINDOWS: Record<string, number> = {
  "qwen3.5-2b": 16384,
  "qwen3.5-4b": 16384,
  "qwen3.5-9b": 16384,
  "gemma-4-e2b": 16384,
};
export const DEFAULT_CONTEXT_WINDOW = 4096;
export const contextWindowFor = (modelId: string): number => CONTEXT_WINDOWS[modelId] ?? DEFAULT_CONTEXT_WINDOW;

/** A model in the catalog: the public id consumers use, mapped to the WebLLM id providers load. */
export interface Model {
  id: string;
  webllmId: string;
  contextWindow: number;
  vramMb: number;
  priceMultiplier: number;
  enabled: boolean;
}
