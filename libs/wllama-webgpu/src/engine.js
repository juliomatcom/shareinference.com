// The inference engine behind share-worker.js. Prompts and completions pass through here only: nothing is logged.
import { Wllama, WllamaAbortError } from "./wllama/index.js";
import { installShaderPatch } from "./shader-patch.js";
import { streamCompletion } from "./completion.js";
import { selectProfile } from "./profiles.js";

const WASM_URL = new URL("./wllama/wasm/wllama.wasm", import.meta.url).href;
const REF = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40})\/([\w.-]+\.gguf)$/;
const SILENT = { debug() {}, log() {}, warn() {}, error() {} };

let shaderCounts = null;

export function ggufUrl(ref) {
  const match = REF.exec(ref);
  if (!match) throw new Error("Invalid model reference.");
  const [, repo, revision, file] = match;
  return `https://huggingface.co/${repo}/resolve/${revision}/${file}`;
}

// forceProfile is for diagnosis (the check script): an unknown id selects the default adapter, which passes text through.
export async function createEngine({
  ref,
  contextWindow,
  onProgress,
  logger = SILENT,
  stockShaders = false,
  forceProfile,
}) {
  if (!stockShaders) shaderCounts ??= installShaderPatch();
  const wllama = new Wllama(
    { default: WASM_URL },
    { parallelDownloads: 3, logger, suppressNativeLog: logger === SILENT },
  );
  let profile;
  try {
    const model = await wllama.modelManager.getModelOrDownload(
      { url: ggufUrl(ref) },
      {
        progressCallback: ({ loaded, total }) =>
          onProgress?.(total > 0 ? Math.min(loaded / total, 1) : 0, "Downloading model"),
      },
    );
    onProgress?.(1, "Loading model onto the GPU");
    await wllama.loadModel(model, {
      n_ctx: contextWindow,
      n_parallel: 1, // one job at a time; the library default of 4 keeps other slots' state
      ctx_shift: false,
      cache_idle_slots: false,
      n_cache_reuse: 0,
      // An abort is only seen between batches, so the batch size bounds stop latency: the default 2048 took ~11 s on 9B.
      n_batch: 512,
      jinja: true,
      reasoning_format: "none", // the reasoning markup stays in content: profiles.js turns it into <think> for the api (D31)
    });
    // The family decides how reasoning is marked and which template variable switches it off.
    profile = selectProfile(forceProfile ?? wllama.getModelMetadata().meta["general.architecture"]);
    // One tiny generation so the first real job does not pay the kernel warm-up (D36).
    await wllama.createChatCompletion({
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 4,
      temperature: 0,
      cache_prompt: false,
    });
  } catch (error) {
    await wllama.exit().catch(() => {});
    throw error;
  }

  return {
    contextWindow: wllama.getLoadedContextInfo().n_ctx,
    profile: profile.id,
    shaderPatch: () => ({ ...(shaderCounts ?? { applied: 0, skipped: 0 }) }),
    unload: () => wllama.exit(),

    /** Streams one job. An abort resolves with finishReason "abort"; any other failure rejects. */
    complete: (job) =>
      streamCompletion({ wllama, profile, isAbort: (error) => error instanceof WllamaAbortError, ...job }),
  };
}
