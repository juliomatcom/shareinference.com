# Migration plan: WebLLM to wllama (llama.cpp WebGPU)

Status: executed 2026-11-21 (Phases 0 to 7; Phase 8 review and release pending). Written from the `spikes/s2-wllama-webgpu` results. Where this text differs from the shipped code, the code and `wiki-llm/` win. Later change: the engine is no longer the npm package but a build of our own fork (D47), so the npm pins and the "no fork or rebuild" non-goal below are history.

**Executor:** Sonnet 5.5, working without the conversation that produced this plan. Everything you need is here or in the files it names. Work through the phases in order. **Test only at the two milestones** (Milestone 1 after Phase 2, Milestone 2 after Phase 6) and run the final checks in Phase 8. Between them, implement without stopping to test, apart from what you need to keep the code compiling.

## 1. Goal and scope

Providers share GPU from a Chrome tab. Replace the engine inside `apps/web/public/share-worker.js`, today WebLLM `@mlc-ai/web-llm@0.2.89`, with **wllama 3.13.0** (llama.cpp's WebGPU backend, GGUF models). One runtime only: WebLLM is removed, never run beside it.

Why: WebLLM needs a per-model compile and its catalog stops near 9B. wllama loads standard GGUF files, and Qwen3.5-27B has been proven to run in a tab.

**In scope:** engine swap, catalog identity (GGUF instead of WebLLM id), COOP/COEP headers, per-model first-chunk timeout, wiki and docs.

**Test target: Macs (Apple GPU, Chrome), start to finish.** The milestones and final checks run on a Mac. Do not add steps that need other hardware, and do not report the plan as blocked for lack of it. Non-Apple providers are not blocked by this migration: they run the stock shader, untested by this project.

**Out of scope (do not do these):**

- CPU spill / partial GPU offload for models larger than VRAM. Parked by the user: wllama's CPU side is capped at 4 GB. Always load with all layers on GPU.
- Forking or rebuilding wllama, or adding a clone to the repo.
- Upgrading wllama past 3.13.0. Current `master` crashes on models over 4 GB and is no faster here.
- Firefox and Safari support.
- More prefill tuning beyond the shader patch in section 5.
- Changing worker protocol v1 beyond what `ready.model` contains.
- Adding Qwen3.5-27B to the catalog without the user's answer (Phase 9).

## 2. Rules for the executor

- Follow `AGENTS.md`. Start at `wiki-llm/index.md` and read `wiki-llm/conventions.md`.
- **Do not commit or push unless the user asks.** When asked: Conventional Commits, one commit per phase. Review the staged diff first; the repository is public.
- Never read or print `.env` values. Use `.env.example` for names.
- Pin exact versions. Adding `@wllama/wllama@3.13.0` is approved. Any other added, swapped or upgraded dependency needs the user's approval.
- `apps/web` runs a Next.js with breaking changes. Before editing it, read the relevant guide in `apps/web/node_modules/next/dist/docs/` (run `pnpm install` first if that folder is missing).
- Comments explain why, not what. Prettier width is 120. No `console.*` outside the logger, except in the check script of Phase 2.
- Never log, store or print prompt or completion text in product code.
- If a milestone fails, fix it if the cause is clear. Otherwise stop and report the failing output to the user. Do not weaken a check to pass it.
- All phases ship together. Phases 3 to 6 are not deployable on their own, because tabs and the catalog must change at the same time.

## 3. Verified facts

Measured 2026-11-21 on an Apple M5 Pro (48 GB unified memory), Chrome 157, wllama 3.13.0, Q4_K_M GGUF, 16K context. "Patched" is the shader patch in section 5. Numbers from stock Chrome unless noted.

| Model       | Engine             | Prefill, 2.5K prompt | Decode   | First token, 14.8K prompt |
| ----------- | ------------------ | -------------------- | -------- | ------------------------- |
| Qwen3.5-2B  | wllama stock       | 512 tok/s            | 75 tok/s | 49.6 s                    |
| Qwen3.5-2B  | **wllama patched** | **615 tok/s**        | 75 tok/s | **44.7 s**                |
| Qwen3.5-2B  | WebLLM             | 1,067 tok/s          | 42 tok/s | not measured              |
| Qwen3.5-9B  | wllama stock       | 121 tok/s            | 33 tok/s | 172 s                     |
| Qwen3.5-9B  | **wllama patched** | **150 tok/s**        | 32 tok/s | **147 s**                 |
| Qwen3.5-9B  | WebLLM             | 350 tok/s            | 20 tok/s | not measured              |
| Qwen3.5-27B | wllama stock       | 34 tok/s             | 12 tok/s | 731 s (17.8K prompt)      |

Also verified:

- Patched output is identical to stock at temperature 0 on 2B and 9B, at 2.5K and 14.8K prompts.
- The patch applies inside a dedicated module Worker that hosts wllama (same shape as `share-worker.js`): 4 shaders patched, 0 skipped.
- `COEP: credentialless` + `COOP: same-origin` gives `crossOriginIsolated === true`, 9 wasm threads, working GitHub avatars and working Hugging Face fetches.
- `cache_prompt: false` with `n_parallel: 1` gives `timings.cache_n === 0` on repeat prompts. With `cache_prompt: true` the same prompt shows `cache_n > 0`, so the check can detect reuse (D27).
- Abort during decode returns in about 13 ms and the engine stays usable. **Final usage is lost on abort.**
- A single unsplit GGUF of 16.7 GB loads. Qwen3.5-27B offloads 65/65 layers, and 32K and 65K contexts load.
- Q2_K, Q3_K_M, Q4_0, Q4_K_M, Q5_K_M, Q6_K, Q8_0, IQ3_XS, IQ4_XS and F16 all run on WebGPU with output matching CPU (SmolLM2-135M).
- With a template that disables thinking, wllama emits `<think>\n\n</think>\n\n` as content **before prefill finishes**. Forwarded as is, it would satisfy the api's first-chunk timer. The engine must hold it back (section 6).

**Not verified. Milestone 1 covers these unless noted:**

- NVIDIA, AMD or Intel GPUs on Windows or Linux. The project has no such hardware, so no gate may depend on it. The shader patch is therefore enabled on Apple GPUs only (Phases 3 and 8).
- Abort during a long prefill.
- Two long jobs in a row. wllama saves the previous slot's state into the 4 GB wasm heap between jobs, and this crashed with `memory access out of bounds` in `server_slot::prompt_save` in a partial-offload run.
- `stop`, `presence_penalty` and `frequency_penalty` pass-through. They are not in wllama's types.
- Device-lost recovery.
- Names of WebLLM's browser caches (Phase 3, step 6).

## 4. Architecture after migration

```text
apps/web/public/share-worker.js        protocol, socket, job lifecycle (mostly unchanged)
        | imports
/engine/wllama-3.13.0/engine.js        createEngine(): load, complete, unload
        | imports
/engine/wllama-3.13.0/shader-patch.js  rewrites one WGSL shader at compile time
/engine/wllama-3.13.0/wllama/...       untouched npm files (index.js, wasm/wllama.wasm)

libs/wllama-webgpu/                    source of engine.js and shader-patch.js, sync script, browser check
apps/web/public/engine/                generated by the sync script, git-ignored
```

**Model identity (`ggufRef`).** Format: `owner/repo@<40-hex-revision>/file.gguf`. It replaces the WebLLM id everywhere, including `ready.model` (max 128 characters, unchanged). The revision is pinned so a repo update can never change what providers run.

| Public id     | `ggufRef`                                                                                         | File bytes    |
| ------------- | ------------------------------------------------------------------------------------------------- | ------------- |
| `qwen3.5-2b`  | `unsloth/Qwen3.5-2B-GGUF@f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf`         | 1,280,835,840 |
| `qwen3.5-4b`  | `unsloth/Qwen3.5-4B-GGUF@e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf`         | 2,740,937,888 |
| `qwen3.5-9b`  | `unsloth/Qwen3.5-9B-GGUF@3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf`         | 5,680,522,464 |
| `gemma-4-e2b` | `unsloth/gemma-4-E2B-it-GGUF@0314792d7f1f7e229411f620751375812bb9faf2/gemma-4-E2B-it-Q4_K_M.gguf` | 3,106,738,272 |

## 5. Phase 0 and Phase 1: package and shader patch

### Phase 0: preflight

1. Confirm the branch with `git status -sb` and ask the user which branch to work on if it is not obvious. Leave `spikes/s1-browser-worker/package-lock.json` alone.
2. In `spikes/s2-wllama-webgpu/app.js`, remove the failed experiment: the section `optional runtime shader patch (?patch=gdn)`, including `installGdnPatchInWorker`, `gdnPatch` and `window.__gdnPatch`. It made prefill about 5% slower.
3. Add a `Results` section to `spikes/s2-wllama-webgpu/README.md` with the table from section 3. Replace its "source-read, not yet run" claims with the verified facts above.
4. Run `pnpm install`, `pnpm lint`, `pnpm test`. Record any failure that already exists before you start.

### Phase 1: `libs/wllama-webgpu`

1. Add `libs/wllama-webgpu` to `pnpm-workspace.yaml`.
2. Create `libs/wllama-webgpu/package.json`:

```json
{
  "name": "@shareinference/wllama-webgpu",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { "./engine": "./src/engine.js", "./shader-patch": "./src/shader-patch.js" },
  "scripts": {
    "sync": "node scripts/sync-assets.mjs",
    "test": "node --test test/*.test.mjs",
    "check:browser": "node scripts/check-browser.mjs"
  },
  "dependencies": { "@wllama/wllama": "3.13.0" }
}
```

3. Create `libs/wllama-webgpu/src/shader-patch.js` with **exactly** this code. It has been tested as written.

```js
// Rewrites llama.cpp's WebGPU register-tiled matmul shader so each bounds check covers four values. The math and its
// order stay the same. Any shader text this does not recognise is left stock (slower, still correct).
const TARGET = "fn store_val(acc: array<array<f32";
const CHANNEL = "si-shader-patch";

/** Returns the patched WGSL, or null when `code` is not the exact shape this patch was written for. */
export function patchMulMatShader(code) {
  const shared = "var<workgroup> shmem: array<f16, TILE_SRC0_SHMEM + TILE_SRC1_SHMEM>;";
  const accumulator = "var acc: array<array<f32, 4u>, 4u>;";
  const inner = /var src0_tile:[\s\S]*?acc\[tm\]\[tn\] \+= f32\(src0_tile\[tm\]\) \* f32\(src1_val\);\s*\}\s*\}/;
  const k = code.match(/let src0_idx = k_inner \+ src0_m \* (\d+u);/)?.[1];
  const n = code.match(/let src1_idx = src1_n \* (\d+u) \+ k_inner;/)?.[1];
  if (
    !k ||
    k !== n ||
    !code.includes(shared) ||
    !code.includes(accumulator) ||
    !code.includes("store_val(acc, tn, tm)") ||
    !code.includes("let dst_batch_offset =") ||
    !code.includes(`const TILE_SRC0_SHMEM = ${k} * 8u * 4u;`) ||
    !code.includes(`const TILE_SRC1_SHMEM = ${k} * 8u * 4u;`) ||
    !inner.test(code)
  ) {
    return null;
  }
  // One array<f16, 4> per k and per group of four rows. Elements are separate memory locations, so two invocations can
  // write neighbours safely. A vec4 here races: writing one lane can rewrite the whole vector (the output changed).
  const storage = `var<workgroup> shmem_v: array<array<f16, 4u>, (TILE_SRC0_SHMEM + TILE_SRC1_SHMEM) / 4u>;
fn shm_set(i: u32, v: f16) {
    let second = i >= TILE_SRC0_SHMEM;
    let j = select(i, i - TILE_SRC0_SHMEM, second);
    let p = (j % ${k}) * 32u + j / ${k} + select(0u, TILE_SRC0_SHMEM, second);
    shmem_v[p / 4u][p % 4u] = v;
}`;
  const loop = `let r0 = shmem_v[k_inner * 8u + local_m];
            let r1 = shmem_v[TILE_SRC0_SHMEM / 4u + k_inner * 8u + local_n];
            let s0 = vec4<f32>(f32(r0[0]), f32(r0[1]), f32(r0[2]), f32(r0[3]));
            let s1 = vec4<f32>(f32(r1[0]), f32(r1[1]), f32(r1[2]), f32(r1[3]));
            a0 += s0 * s1.x;
            a1 += s0 * s1.y;
            a2 += s0 * s1.z;
            a3 += s0 * s1.w;`;
  const next = code
    .replace(inner, loop)
    .replace(/shmem\[([^\]]+)\]\s*=\s*([^;]+);/g, "shm_set($1, $2);")
    .replace(shared, storage)
    .replace(accumulator, "var a0 = vec4<f32>(); var a1 = vec4<f32>(); var a2 = vec4<f32>(); var a3 = vec4<f32>();")
    .replace("let dst_batch_offset =", "var acc = array<vec4<f32>, 4u>(a0, a1, a2, a3);\n    let dst_batch_offset =")
    .replace("store_val(acc, tn, tm)", "acc[tn][tm]");
  return /\bshmem\[/.test(next) ? null : next;
}

// Runs inside wllama's nested worker, so it is serialized with toString and must not use anything from module scope.
function workerHook(patch, target, channelName) {
  if (typeof GPUDevice === "undefined" || self.__siShaderPatch) return;
  self.__siShaderPatch = true;
  const channel = new BroadcastChannel(channelName);
  const original = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (descriptor) {
    if (!descriptor.code?.includes(target)) return original.call(this, descriptor);
    const code = patch(descriptor.code);
    channel.postMessage(code ? "applied" : "skipped");
    return original.call(this, code ? { ...descriptor, code } : descriptor);
  };
}

/** Call once before the first `loadModel`. Returns live counters of shaders patched and left stock. */
export function installShaderPatch() {
  const counts = { applied: 0, skipped: 0 };
  new BroadcastChannel(CHANNEL).onmessage = ({ data }) => {
    if (data === "applied" || data === "skipped") counts[data]++;
  };
  const prefix = `(${workerHook})(${patchMulMatShader}, ${JSON.stringify(TARGET)}, ${JSON.stringify(CHANNEL)});\n`;
  const createObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) =>
    createObjectURL(
      blob instanceof Blob && blob.type.includes("javascript") ? new Blob([prefix, blob], { type: blob.type }) : blob,
    );
  return counts;
}
```

These files are served as plain ES modules. **Never bundle or minify `shader-patch.js`**, because `workerHook` and `patchMulMatShader` are serialized with `toString()`.

4. Create `libs/wllama-webgpu/src/engine.js` from section 6.
5. Create `libs/wllama-webgpu/scripts/sync-assets.mjs`. It must:
   - Read the installed version from `@wllama/wllama/package.json` and fail unless it is exactly `3.13.0`.
   - Recreate `apps/web/public/engine/wllama-3.13.0/`.
   - Copy `esm/index.js` to `wllama/index.js` and `esm/wasm/wllama.wasm` to `wllama/wasm/wllama.wasm`.
   - Copy `src/engine.js` and `src/shader-patch.js` next to the `wllama/` folder.
   - Fail if `wllama/index.js` has a relative `import` or `from "./` (it must be one self-contained file).
6. Add `apps/web/public/engine/` to `.gitignore` and `.prettierignore`.
7. Create `libs/wllama-webgpu/test/shader-patch.test.mjs` (node:test). Build a small synthetic WGSL fixture containing every string the patch matches. Assert:
   - The fixture is patched, has no `shmem[`, no `array<array<f32`, and contains `shm_set`.
   - Each of these returns `null`: empty string, the fixture without the `shared` line, a fixture with `src0_m * 32u` but `src1_n * 16u`.
   - Patching leaves the input string unchanged.

## 6. Phase 2: engine and browser gate

### `libs/wllama-webgpu/src/engine.js`

Use this code. Adjust it only if a gate proves it wrong, and report any change.

```js
// The inference engine behind share-worker.js. Prompts and completions pass through here only: nothing is logged.
import { Wllama, WllamaAbortError } from "./wllama/index.js";
import { installShaderPatch } from "./shader-patch.js";

const WASM_URL = new URL("./wllama/wasm/wllama.wasm", import.meta.url).href;
const REF = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40})\/([\w.-]+\.gguf)$/;
const SILENT = { debug() {}, log() {}, warn() {}, error() {} };
// A template with thinking off emits this before prefill ends; it is not a generated token.
const EMPTY_THINK = "<think></think>";

let shaderCounts = null;

export function ggufUrl(ref) {
  const match = REF.exec(ref);
  if (!match) throw new Error("Invalid model reference.");
  const [, repo, revision, file] = match;
  return `https://huggingface.co/${repo}/resolve/${revision}/${file}`;
}

const isHeldBack = (text) => EMPTY_THINK.startsWith(text.replace(/\s+/g, ""));
const count = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

export async function createEngine({ ref, contextWindow, onProgress, logger = SILENT, stockShaders = false }) {
  if (!stockShaders) shaderCounts ??= installShaderPatch();
  const wllama = new Wllama(
    { default: WASM_URL },
    { parallelDownloads: 3, logger, suppressNativeLog: logger === SILENT },
  );
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
      reasoning_format: "none", // raw <think> tags in content: the api parses them (D31)
    });
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
    shaderPatch: () => ({ ...(shaderCounts ?? { applied: 0, skipped: 0 }) }),
    unload: () => wllama.exit(),

    /** Streams one job. An abort resolves with finishReason "abort"; any other failure rejects. */
    async complete({ messages, params, signal, onDelta }) {
      const { enable_thinking, ...rest } = params ?? {};
      let held = "";
      let released = false;
      let generated = 0;
      let promptTotal = 0;
      let finish = null;
      let usage = null;
      let timings = null;
      let aborted = false;
      try {
        const stream = await wllama.createChatCompletion({
          ...rest,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          cache_prompt: false, // D27: no KV reuse between jobs
          return_progress: true,
          abortSignal: signal,
          ...(enable_thinking === undefined ? {} : { chat_template_kwargs: { enable_thinking } }),
        });
        for await (const chunk of stream) {
          if (chunk.prompt_progress) promptTotal = chunk.prompt_progress.total;
          if (chunk.usage) usage = chunk.usage;
          if (chunk.timings) timings = chunk.timings;
          const choice = chunk.choices?.[0];
          if (choice?.finish_reason) finish = choice.finish_reason;
          const delta = choice?.delta?.content;
          if (!delta) continue;
          if (released) {
            generated++;
            onDelta(delta);
            continue;
          }
          held += delta;
          if (!isHeldBack(held)) {
            released = true;
            generated++;
            onDelta(held);
            held = "";
          }
        }
      } catch (error) {
        if (!(error instanceof WllamaAbortError)) throw error;
        aborted = true;
      }
      if (!released && held && !aborted) onDelta(held);
      return {
        finishReason: aborted ? "abort" : finish === "length" ? "length" : "stop",
        usage: {
          // wllama drops the final usage on abort: fall back to what this job saw.
          promptTokens: count(usage?.prompt_tokens ?? promptTotal),
          completionTokens: count(usage?.completion_tokens ?? generated),
          decodeTokensPerS: Math.max(0, Number(timings?.predicted_per_second) || 0),
        },
        cachedTokens: count(timings?.cache_n), // D27 check only, never sent to the api
      };
    },
  };
}
```

### Browser check

Create `libs/wllama-webgpu/scripts/check-browser.mjs`. No new dependencies: start a local Node static server, launch the system Chrome headless with a throwaway `--user-data-dir` under `os.tmpdir()`, and drive it over the DevTools Protocol with Node's global `WebSocket`. Do not pass WebGPU flags (real providers run stock Chrome). It must:

- Serve `apps/web/public/engine/` plus a tiny test page and a module Worker that imports `engine.js`, with `COOP: same-origin` and `COEP: credentialless`.
- Run the engine **inside the Worker**, as production does.
- Take the model from env `CHECK_MODEL`, default the `qwen3.5-2b` ref.
- Accept env `CHECK_CASES` (for example `A,B,G,H`) to run only those cases.
- Print PASS or FAIL per case, exit non-zero on any FAIL, and delete the profile directory on exit (these are multi-GB downloads).
- Print the native log lines `WebGPU model buffer size`, `KV buffer size`, `RS buffer size`, `WebGPU compute buffer size` and `offloaded N/N`, using a logger passed only in this script. Phase 6 needs them.

| #   | Case                   | Pass condition                                                                                                                                                     |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | Environment            | `crossOriginIsolated`, all layers offloaded                                                                                                                        |
| B   | Patch active           | `shaderPatch().applied > 0` and `skipped === 0`                                                                                                                    |
| C   | Patch is safe          | With temperature 0 and seed 42, a 2.5K-token prompt and 64 tokens give identical text with `stockShaders: true` (separate page load)                               |
| D   | D27                    | The same prompt twice: `cachedTokens === 0` both times, same `promptTokens`                                                                                        |
| E   | Hold-back              | Thinking off: the first `onDelta` is not whitespace or an empty think block, and arrives after prefill. Thinking on: reasoning is delivered with its `<think>` tag |
| F   | Stop in decode         | Returns `abort` within 10 s, `completionTokens > 0`, next job works                                                                                                |
| G   | **Stop in prefill**    | With a 14K-token prompt, abort 2 s after start. Returns `abort` within 10 s, next job works                                                                        |
| H   | **Long jobs in a row** | Two 14K-token jobs, then one short job, all succeed with no runtime error                                                                                          |
| I   | Params                 | `stop` ends output at the stop string. `presence_penalty` and `frequency_penalty` are accepted without error                                                       |
| J   | Over context           | A prompt above `n_ctx` rejects with a message matching `/context window                                                                                            | prompt tokens | too long | exceed/i`, next job works |
| K   | Reload                 | `unload()`, then `createEngine()` again, then a job works                                                                                                          |

### Milestone 1: the engine works

All cases pass on `qwen3.5-2b`, then cases A, B, G and H pass with `CHECK_MODEL` set to the `qwen3.5-9b` ref. Also run the unit test and sync from Phase 1 here.

Case G on 9B needed `n_batch: 512` (now in `loadModel`): the default 2048 batch took about 11 s to abort during prefill, 512 gives about 4 s. A smaller step (`n_ubatch: 256`) is the next lever; it cost about 4% prefill in the sweep. If case H fails, stop and report to the user: it would limit the usable context per model, and that is the user's call.

## 7. Phase 3: replace the engine in the worker and web app

Read the Next.js headers guide first (see section 2).

1. **Dependency and build.** In `apps/web/package.json`:
   - Add `"@shareinference/wllama-webgpu": "workspace:*"` to `dependencies`.
   - Add the script `"sync:engine": "pnpm --filter @shareinference/wllama-webgpu sync"`.
   - Change `"dev"` to `pnpm sync:engine && next dev --port 4400` and `"build"` to `pnpm sync:engine && next build`.

2. **`apps/web/Dockerfile`** (build stage):
   - Add `COPY libs/wllama-webgpu/package.json libs/wllama-webgpu/` next to the other manifest copy, before `pnpm install`.
   - Add `COPY libs/wllama-webgpu libs/wllama-webgpu` before the build.
   - The runtime stage already copies `apps/web/public`. Confirm the engine files are in the image.
   - Check `apps/api/Dockerfile` still builds with the new workspace member.

3. **`apps/web/next.config.ts`.** Add to the `/:path*` header block:

```ts
// Needed for wasm threads. Set on every page because sharing survives client-side navigation from the root layout.
// `credentialless` keeps third-party images such as GitHub avatars working.
{ key: "Cross-Origin-Opener-Policy", value: "same-origin" },
{ key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
```

Add a separate rule for the npm-owned files only, whose path contains the version:

```ts
{
  source: "/engine/:version/wllama/:path*",
  headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
},
```

Do not mark `engine.js` or `shader-patch.js` immutable, because they can change without a version bump. Update the CSP comment that mentions WebLLM and the CDN.

4. **`apps/web/public/share-worker.js`.** Keep the socket, heartbeat, reconnect and recovery logic. Change only:

```js
// Line 1: "owns the wllama engine". Replace the WebLLM import:
import { createEngine } from "/engine/wllama-3.13.0/engine.js";

// Replace the two error patterns. A wasm abort leaves the engine unusable, so it counts as a device fault.
const DEVICE_ERROR = /device|gpu|lost|destroyed|out of memory|invalid state|memory access|unreachable|abort/i;
const PROMPT_ERROR = /context|prompt tokens|too long|exceed/i;

async function loadEngine() {
  loaded = false;
  status("loading");
  const t0 = performance.now();
  const contextWindow = Number.isInteger(cfg.contextWindow) && cfg.contextWindow > 0 ? cfg.contextWindow : 4096;
  engine = await createEngine({
    ref: cfg.model,
    contextWindow,
    // The patch's identical-output check has only run on Apple GPUs; every other vendor gets the stock shader.
    stockShaders: cfg.gpu?.vendor !== "apple",
    onProgress: (progress, text) => post({ type: "progress", progress, text }),
  });
  loadedWindow = engine.contextWindow;
  loadMs = Math.round(performance.now() - t0);
  loaded = true;
}

function interrupt() {
  if (!current) return;
  current.interrupted = true;
  current.controller.abort();
}

async function runJob({ id, messages, params }) {
  current = { id, interrupted: false, controller: new AbortController() };
  status("busy");
  try {
    const result = await engine.complete({
      messages,
      params,
      signal: current.controller.signal,
      onDelta: (delta) => send({ type: "chunk", id, delta }),
    });
    engineFailures = 0;
    send({ type: "done", id, finishReason: result.finishReason, usage: result.usage });
  } catch (e) {
    // keep the existing catch and finally blocks unchanged
  }
}
```

In `recover()` and `stop()`, replace `engine.unload()` semantics as needed: `unload()` terminates wllama's worker and an engine object is not reused afterwards. Guard `stop()` and `recover()` against a null engine.

A chunk larger than the protocol's 16,384 characters cannot occur from single token deltas, but the released first chunk is held text plus one token, which stays far below it.

5. **`SharingProvider.tsx`.** Change the worker error text from "model CDN" to "model download". In `checkGpu`, after the `shader-f16` check, add the runtime check, because wllama's WebGPU path requires both:

```ts
const hasJspi = "Suspending" in WebAssembly;
let hasMemory64 = false;
try {
  new WebAssembly.Memory({ address: "i64", initial: 1n } as unknown as WebAssembly.MemoryDescriptor);
  hasMemory64 = true;
} catch {
  // not supported
}
if (!hasJspi || !hasMemory64 || !window.crossOriginIsolated) {
  return { status: "unsupported", reason: "Sharing needs a recent desktop Chrome or Edge." };
}
```

6. **Remove old WebLLM downloads from providers' browsers.** Otherwise each provider keeps several GB of dead cache. In Chrome with a profile that has run the current production site, list `await caches.keys()` to confirm WebLLM's cache names (expected prefix `webllm`; this is unverified). After a successful `loadEngine()`, delete only the confirmed names, best effort, inside try/catch, without blocking `ready`. If WebLLM also stored models in IndexedDB, report it to the user rather than guessing.

## 8. Phase 4: catalog and API rename

Rename across `apps/api` and `apps/web`:

| Old                                                            | New                    |
| -------------------------------------------------------------- | ---------------------- |
| `webllm_id` (column)                                           | `gguf_ref`             |
| `webllmId` (field, including the public `/public/models` JSON) | `ggufRef`              |
| `findEnabledByWebllmId`                                        | `findEnabledByGgufRef` |

Files: `core/models.ts`, `core/dispatcher.ts`, `core/inference.ts`, `core/ports.ts`, `core/protocol.ts` (comment), `core/publicStats.ts`, `core/registry.ts`, `core/workers.ts`, `adapters/postgres/modelStore.ts`, `adapters/postgres/publicStore.ts`, `devFakeWorker.ts`, all tests that use these names, `apps/web/app/lib/api.ts`, `apps/web/app/components/SharingProvider.tsx`. Find them with `git grep -n -i webllm -- apps`.

**Never edit an existing migration.** Create `apps/api/src/adapters/postgres/migrations/20261121120000_gguf_catalog.ts`:

- `up`, in one transaction:
  1. Rename `models.webllm_id` to `gguf_ref`. Rename its unique constraint to `models_gguf_ref_unique` (check the current name in Postgres).
  2. Update the four rows to the refs in section 4, matching on public `id`.
  3. Update `workers.last_model` from each old WebLLM id to its new ref, because the leaderboard joins on it. Other values stay.
- `down`: the exact reverse, with these old ids:
  - `qwen3.5-2b` = `Qwen3.5-2B-q4f16_1-MLC`
  - `qwen3.5-4b` = `Qwen3.5-4B-q4f16_1-MLC`
  - `qwen3.5-9b` = `Qwen3.5-9B-q4f16_1-MLC`
  - `gemma-4-e2b` = `gemma-4-E2B-it-q4f16_1-MLC`

Update `test/migrations.test.ts` to the new refs, and add a check that `workers.last_model` was remapped and that `down` restores it. In tests, replace `Qwen3.5-4B-q4f16_1-MLC` with the 4B ref. In `models.ts`, update the comments that mention WebLLM. `DEFAULT_CONTEXT_WINDOW` stays 4096.

## 9. Phase 5: per-model first-chunk timeout

The fixed 90 s assumes 300-500 tok/s prefill. A full 16K prompt on 9B takes about 147 s here, and slower GPUs take longer.

In `apps/api/src/core/models.ts`:

```ts
/**
 * Slowest prefill (tokens/s) we still wait for, per public id: about half of what an M5 Pro measured near a full 16K
 * prompt with the patched engine. Entries for 4B and gemma are estimates until measured.
 */
export const MIN_PREFILL_TPS: Record<string, number> = {
  "qwen3.5-2b": 150,
  "qwen3.5-4b": 100,
  "qwen3.5-9b": 50,
  "gemma-4-e2b": 100,
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
```

In `dispatcher.ts`:

- Add optional `firstChunkTimeoutMs?: number` to `JobRequest`.
- In `start()`, use `req.firstChunkTimeoutMs ?? FIRST_CHUNK_TIMEOUT_MS`.

In `inference.ts`, pass `firstChunkTimeoutMs: firstChunkTimeoutMs(model.id, promptEstimateTokens, source === "playground" ? PLAYGROUND_JOB_TIMEOUT_MS : JOB_TIMEOUT_MS)`.

Tests:

- `models.test.ts`: the 90 s floor, growth with prompt size, the 80% cap for both job timeouts, the default for an unknown id, and every seeded model having an entry.
- `dispatcher.test.ts`: a custom timeout fires at its value, not at 90 s, and the default stays 90 s.

## 10. Phase 6: catalog sizes and UI

1. Run `check:browser` with `CHECK_CASES=A` for `qwen3.5-2b`, `qwen3.5-4b`, `qwen3.5-9b` and `gemma-4-e2b` to get their memory lines. For the prefill numbers in step 4, also time one long prompt on 4B and gemma.
2. For each, GPU memory (MB) = WebGPU model buffer + KV + RS (if present) + WebGPU compute, rounded up. Reference: 9B at 16K is 4,861 + 512 + 50 + 120 = **5,543 MB**.
3. Update `MODEL_VRAM_MB` in `apps/web/app/lib/api.ts` (include `gemma-4-e2b`, missing today) and the `vram_mb` values in the Phase 4 migration, with their reverse in `down`: 2245, 3868, 6433, 3387.
4. Update `MIN_PREFILL_TPS` for 4B and gemma to half of their measured prefill at the longest prompt, and remove "estimates" from the comment.
5. Search the Share page and docs pages for copy that names WebLLM or the old download sizes. The Share page says the first start downloads about the model's memory need, so confirm it remains true.

### Milestone 2: the product works end to end on the Mac

Run `pnpm db:migrate`, roll back once, migrate again, then start `pnpm dev` and check:

- Sign in, open `/share`, pick `qwen3.5-2b`, Turn ON, reach `ready`.
- In the Playground, send a message and get a streamed answer with usage and credits.
- Stop a reply mid-stream. The worker returns to ready and the job settles per D43.
- Run with thinking on and off.
- Reload the page. The model loads from cache with no download.
- Turn OFF. GPU memory is released.
- Navigate between pages while sharing. Sharing keeps running.
- `/`, `/models`, `/leaderboard`, `/signin` and `/share` load with `crossOriginIsolated === true`, and a signed-in GitHub avatar renders.

## 11. Phase 7: wiki, decisions and docs

Update in the same commit as the behavior they describe. One fact on one page.

| File                                    | Change                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `specs/mvp-plan.md`                     | Add **D46** (below). Mark D24 and D25 superseded by D46. Reword D27: `cache_prompt: false` + `n_parallel: 1` instead of `resetChat()`. Add a Log line. |
| `wiki-llm/index.md`                     | "WebLLM runs a model" becomes wllama / llama.cpp WebGPU                                                                                                |
| `wiki-llm/architecture.md`              | Components row, first-chunk timeout rule (per model, formula, floor and cap), catalog section (`gguf_ref` format)                                      |
| `wiki-llm/worker-protocol.md`           | `ready.model` is the `ggufRef`; `cancel` aborts through the engine; no `resetChat`; param mapping; held-back empty think block; usage on abort         |
| `wiki-llm/data-model.md`                | `gguf_ref` column                                                                                                                                      |
| `wiki-llm/api.md`                       | `/public/models` returns `ggufRef`                                                                                                                     |
| `wiki-llm/web.md`                       | Worker loading, engine path, sizes, browser requirements, COOP/COEP on every page                                                                      |
| `wiki-llm/conventions.md`               | CSP note: self-hosted engine, wasm, Hugging Face; no jsDelivr                                                                                          |
| `wiki-llm/setup.md`                     | `libs/wllama-webgpu`, sync step, how to run `check:browser`                                                                                            |
| `docs/contribute.md`, `docs/privacy.md` | The engine is now served from our own origin; model files come from Hugging Face                                                                       |
| `README.md`                             | Line 31: WebLLM becomes wllama                                                                                                                         |

D46 text:

> **Browser runtime: wllama `@wllama/wllama@3.13.0`** (llama.cpp WebGPU, GGUF), replacing WebLLM (supersedes D24, D25). Pinned from npm and self-hosted from our origin. Models are identified by a `gguf_ref` pinned to a Hugging Face revision. A small runtime patch in `libs/wllama-webgpu` rewrites one matmul shader on Apple GPUs only (+20-24% prefill, identical output); other vendors use the stock shader because the project has no such hardware to verify it, and it also falls back to stock if the shader text changes. No fork. All layers stay on GPU: CPU spill is parked because wllama's CPU side is capped at 4 GB. Verified 2026-11-21 in `spikes/s2-wllama-webgpu`.

Add this upgrade procedure to `wiki-llm/setup.md`:

1. Bump the pin in `libs/wllama-webgpu/package.json` and the path `wllama-<version>` in the sync script and `share-worker.js`.
2. Run `check:browser` on 2B and 9B.
3. If `applied` is 0 or `skipped` is above 0, the shader changed: update the patch or remove it if upstream fixed this.
4. Ship only if all cases pass.

## 12. Phase 8: review and release

1. Run:

```sh
pnpm lint
pnpm format:check
pnpm test
pnpm test:scripts
pnpm --filter @shareinference/wllama-webgpu test
pnpm --filter @shareinference/web build
docker compose up -d --build
gitleaks git .
gitleaks dir .
git grep -n -i -E 'webllm|web-llm|jsdelivr|resetChat|interruptGenerate'
```

The last command must match only historical entries in `specs/`, old migrations and spike folders. Run `pnpm test` with `TEST_DATABASE_URL` set so the migration tests run.

2. **Contrarian review (required by `AGENTS.md`):** dispatch a `model: sonnet` subagent over the full diff. Focus on billing on abort, D27, timeouts, migration reversibility, untrusted worker input, COEP side effects and shader patch failure modes. Fix every valid finding.

3. **No NVIDIA/AMD gate.** The project has no such cards, so do not wait for or ask for a hardware test. Confirm instead that `share-worker.js` passes `stockShaders: true` for every `gpu.vendor` other than `apple`. Before deploying, tell the user that wllama itself is untested by this project on those GPUs, so the first real NVIDIA or AMD providers are its first test here. To enable the patch for another vendor later, that vendor must first pass case C of `check:browser`.

4. **Deploy only when the user says so** (`pnpm deploy`). Web, api and the migration go together. Tabs still running WebLLM get close `4404` when they reconnect and show "The server does not serve this model", until they are reloaded. Tell the user this before deploying.

5. **Rollback:** redeploy the previous image, then run `pnpm db:rollback` once. Providers must reload their tab.

## 13. Phase 9: Qwen3.5-27B (only after the user decides)

Do not start without answers to both questions:

1. **Price multiplier** for `qwen3.5-27b` (economy decision).
2. **Context window.** Recommendation: **8192**. At the measured prefill, 17.8K tokens took 731 s, which exceeds the 600 s job limit. An 8K prompt should fit, but measure it first.

Then, in a new migration, add `qwen3.5-27b` with:

- `gguf_ref`: `unsloth/Qwen3.5-27B-GGUF@3221f178a6b842d04f1fb42f1c413534adcc0a6a/Qwen3.5-27B-Q4_K_M.gguf` (16,740,812,704 bytes)
- A `CONTEXT_WINDOWS` entry.
- `MIN_PREFILL_TPS` of 15.
- A measured `vram_mb`. About 16.6 GB at 16K, so providers need a 16 GB+ card or a large unified-memory machine.

Run cases A, B, G and H of the browser check on 27B first. Case G is the likely failure, because one 512-token step takes about 15 s at this speed, so try `n_ubatch: 256` if needed.

## 14. Definition of done

- WebLLM is gone from product code. Providers run wllama from our origin.
- Milestones 1 and 2 and the Phase 8 checks pass on a Mac.
- `check:browser` shows the patch active with identical output on Apple, and non-Apple vendors are configured to use stock shaders.
- Wiki, D46 and docs are updated.
- Contrarian review findings are fixed.
- Nothing was committed, pushed or deployed without the user asking.

## 15. Open after execution (rough edges, 2026-11-21)

Verified end to end on a Mac (Milestones 1 and 2, contrarian review fixed). Left for later iterations:

- Long-jobs case H flaked once on Inkling-2-Mini (under investigation; not seen on the Qwen models).
- The `ready.model` bound in the worker protocol went from 128 to 256 characters (longer `gguf_ref`s). Tabs and api must be
  deployed together: an older api closes a longer ref with 4400.
- Not run here: `docker compose up -d --build` (no Docker on the test Mac).
- Inkling hardware gate is advisory: an under-sized GPU can pick it and download 13.3 GB before load fails; verified only on
  Apple M5 Pro.
- The worker watchdog and failure-counter fixes (Phase 8 review) were not exercised in a browser.
- The legacy WebLLM cache name `webllm/` in `share-worker.js` is a guess; IndexedDB leftovers are not cleaned.
- The first-chunk timeout uses an ascii/4 token estimate and M5 Pro speeds; slower Macs may time out on long prompts.
- A long 9B prompt in the Playground can hit the 240 s first-chunk cap.
- The Share page picks the recommended model after a reload instead of the last choice; the speed metric shows silly
  values (for example 50,000 tok/s) on 2-token replies.
