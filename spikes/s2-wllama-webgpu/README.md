# S2: wllama + llama.cpp WebGPU (throwaway spike)

Goal: prove llama.cpp WebGPU via `@wllama/wllama` 3.13.0 can replace WebLLM in the provider worker (`apps/web/public/share-worker.js`), and measure it.

## 1. How to run

```
npm ci && npm start
```

Open http://localhost:8788 in Chrome (`PORT` env overrides). Recommended model field: `unsloth/Qwen3.5-9B-GGUF:Q4_K_M`.

Model field accepts a full `.gguf` URL, `owner/repo`, `owner/repo:QUANT`, or `owner/repo/path/file.gguf`. Blank `n_gpu_layers` = library default (all layers), `0` = CPU.

This Mac has unified memory, so a pass proves the runtime, not that the model fits in 12 GB of discrete VRAM.

Automation: `window.__spike = { load, generate, stop, d27, unload, results, resultsJson, wllama }`. `load({model, nGpuLayers, nCtx})`; `generate`/`d27({prompt, maxTokens, temperature, seed, thinking: 'off'|'on'|'default', cachePrompt})`. "Copy results JSON" exports everything (generated text cut to 500 chars) plus the filtered log.

## 2. Engine mapping (`share-worker.js` -> wllama)

| share-worker.js | wllama | Status |
| --- | --- | --- |
| `CreateMLCEngine(model, {initProgressCallback}, {context_window_size})` | `modelManager.getModelOrDownload(source, {progressCallback})` + `loadModel(model, {n_ctx, ...})` | OK |
| warm-up generation | same `createChatCompletion` (`max_tokens: 4`, `cache_prompt: false`) | OK |
| `resetChat()` | no equivalent. Per-request `cache_prompt: false` with `n_parallel: 1`, verified by `timings.cache_n` (D27 button) | GAP (replacement) |
| streaming with `stream_options.include_usage` | `createChatCompletion({stream: true})`. `stream_options` is not in wllama's TS types but is passed through in the request JSON and the string exists in the wasm | undocumented |
| `usage.extra.decode_tokens_per_s` | `timings.predicted_per_second` (`timings` is typed on chunks) | OK |
| `extra_body.enable_thinking` | `chat_template_kwargs.enable_thinking`; raw tags in content need load param `reasoning_format: 'none'` | OK |
| `interruptGenerate()` | `AbortController` via `abortSignal`; throws `WllamaAbortError`. Final usage is lost on abort, while our protocol bills `done` usage after a consumer cancel, so the worker must count tokens itself | GAP |
| `engine.unload()` | `wllama.exit()` (terminates the worker); a new instance is needed for the next load | OK |
| `recover()` device-lost detection | not documented | to test |

## 3. Results

Measured 2026-11-21 on an Apple M5 Pro (48 GB unified memory), Chrome 157, wllama 3.13.0, Q4_K_M GGUF, 16K context. "Patched" is the shader patch in `libs/wllama-webgpu/src/shader-patch.js`. Numbers from stock Chrome unless noted.

| Model       | Engine             | Prefill, 2.5K prompt | Decode   | First token, 14.8K prompt |
| ----------- | ------------------ | -------------------- | -------- | ------------------------- |
| Qwen3.5-2B  | wllama stock       | 512 tok/s            | 75 tok/s | 49.6 s                    |
| Qwen3.5-2B  | **wllama patched** | **615 tok/s**        | 75 tok/s | **44.7 s**                |
| Qwen3.5-2B  | WebLLM             | 1,067 tok/s          | 42 tok/s | not measured              |
| Qwen3.5-9B  | wllama stock       | 121 tok/s            | 33 tok/s | 172 s                     |
| Qwen3.5-9B  | **wllama patched** | **150 tok/s**        | 32 tok/s | **147 s**                 |
| Qwen3.5-9B  | WebLLM             | 350 tok/s            | 20 tok/s | not measured              |
| Qwen3.5-27B | wllama stock       | 34 tok/s             | 12 tok/s | 731 s (17.8K prompt)      |

Verified:

- Patched output is identical to stock at temperature 0 on 2B and 9B, at 2.5K and 14.8K prompts.
- The patch applies inside a dedicated module Worker that hosts wllama (same shape as `share-worker.js`): 4 shaders patched, 0 skipped.
- `COEP: credentialless` + `COOP: same-origin` gives `crossOriginIsolated === true`, 9 wasm threads, working GitHub avatars and working Hugging Face fetches.
- `cache_prompt: false` with `n_parallel: 1` gives `timings.cache_n === 0` on repeat prompts. With `cache_prompt: true` the same prompt shows `cache_n > 0`, so the check can detect reuse (D27).
- Abort during decode returns in about 13 ms and the engine stays usable. Final usage is lost on abort.
- A single unsplit GGUF of 16.7 GB loads. Qwen3.5-27B offloads 65/65 layers, and 32K and 65K contexts load.
- Q2_K, Q3_K_M, Q4_0, Q4_K_M, Q5_K_M, Q6_K, Q8_0, IQ3_XS, IQ4_XS and F16 all run on WebGPU with output matching CPU (SmolLM2-135M).
- With a template that disables thinking, wllama emits `<think>\n\n</think>\n\n` as content before prefill finishes.
- The runtime GDN shader patch (`?patch=gdn`) made prefill about 5% slower and was removed.

Not verified: NVIDIA/AMD/Intel GPUs, abort during a long prefill, two long jobs in a row, `stop` and penalty pass-through, device-lost recovery.

Source-read facts that still hold:

- Default `n_parallel` is 4; we force 1.
- Wasm heap max is 4 GiB (`-sMAXIMUM_MEMORY=4096MB`, Memory64 build), so CPU-side tensors in partial offload must fit that even when the GPU buffers are larger.
- Downloads go to OPFS by whole-file fetch with no range resume, so an interrupted shard restarts.
- COOP/COEP are needed for threads (`server.mjs` sets them).
