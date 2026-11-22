# S3: Inkling-2-Mini on WebGPU via a self-built wllama (throwaway spike)

Goal: find out whether `thinkingmachines/Inkling-2-Mini` (released 2026-11-17) can run in a provider tab, and what it takes.
Status: done. Outcome: decisions D47 (self-built engine from our wllama fork) and D48 (Inkling-2-Mini in the catalog) in `specs/mvp-plan.md`.

## 1. The model

- 26.4B total parameters, 3.4B active (MoE: 128 routed experts, 8 per token). The middle layers run three times
  ("looped"), so it computes about 5.4B effective active parameters per token. Apache-2.0. Vision is ignored (text only).
- GGUF architecture: `inkling2_loop` (mainline llama.cpp layout). Some early files use the older `inkling2` layout,
  which mainline does not load.
- llama.cpp support: ggml-org/llama.cpp #32217 (merged 2026-11-14), #32694 (`inkling2_loop`) and #32704 (loop-scale
  fix, merged 2026-11-21). Release b12613 (2026-11-21) contains all three.

## 2. Our pinned engine cannot load it

`@wllama/wllama@3.13.0` (the newest npm release, published 2026-11-08) bundles llama.cpp b12211, which predates the
support. `wllama.wasm` has no `inkling` string; loading fails with `unknown model architecture: 'inkling2'`.

## 3. Building wllama ourselves works

- wllama tag `3.13.0` (commit 6647c1e) with its `llama.cpp` submodule moved to `b12613` (362ac92).
- Toolchain: emsdk 4.0.20 (the version wllama's Docker build uses). Homebrew emscripten 7.0.0 fails at link
  (`gl.o wasm32 can't be linked in wasm64`).
- Flags: wllama's default build: `-DGGML_WEBGPU=ON -DGGML_WEBGPU_JSPI=ON` with the Dawn `emdawnwebgpu` package
  (memory64, JSPI, wasm exceptions). The wasm is 10.96 MB (stock 10.24 MB). The wasm build takes about 36 s on 12 cores.
- Four glue patches on the wllama side for llama.cpp API drift (llama.cpp untouched):
  1. `cpp/wllama-context.h`: `server_realtime_deps` now takes `common_params`; add a `params` member, set `params.sampling`.
  2. `cpp/wllama-context.h`: `parse_questions(body, false)`.
  3. `cpp/wllama-context.h`: the `common_fit_params` stub takes `const std::vector<std::string>&` first.
  4. `CMakeLists.txt`: add `server-slot-sched.cpp` and `vendor/cpp-httplib/httplib.cpp` to the sources.
- No regression on the current catalog with this build (cases A, B, T): qwen3.5-2b 75 tok/s decode, qwen3.5-9b
  33 tok/s, both coherent; the 9B (> 4 GB file) loads, so the > 4 GB crash seen on wllama `master` does not occur.

## 4. Results

Mac (Apple M5 Pro, 48 GB), headless Chrome 157, custom build, ctx 8192.

**unsloth `Mainline_Support/Inkling-2-Mini-UD-IQ3_XXS.gguf_file` (11.66 GB):**

- Loads: 49/49 layers on WebGPU, `crossOriginIsolated`, shader patch applied=7 skipped=0. Load from OPFS cache 6 s.
- GPU memory: WebGPU model 10,863 MiB + KV 256 + 240 + RS 3.7 + compute 980 = about 12.3 GB.
- Speed: decode 17.2-17.4 tok/s (native Metal: 18.3-19.3), prefill 89 tok/s on a 4.8K prompt.
- **Output is wrong:** the final hidden state is NaN, so the logits are uniform (`-12.206 = -ln(201024)`) and greedy
  decoding emits token 0 (`!`) forever. Our engine forwards nothing, so it looked like empty output.
- Same file on native llama.cpp b12613 (Metal) is correct ("The capital of France is" -> "Paris. ...").
- Ruled out: our shader patch (stock shaders give the same NaN), the output layer (on CPU, same), the attention
  variants. llama.cpp's `test-backend-ops` on WebGPU passed everything that ran (MUL_MAT_ID 1116 cases incl. nvfp4,
  SOFT_MAX, FLASH_ATTN_EXT, SSM_CONV, unary ops); the plain MUL_MAT run never finished.
- Partial offload is not a bisect tool here: the 4 GB wasm heap cannot hold the CPU part.

**Cause found: NVFP4.** Every unsloth Inkling file stores 20-40 `ffn_down_exps` tensors in NVFP4 (the newest ggml
type); no other publisher's file does. The same custom build gives correct text with bartowski's files (revision
`76d57028717ed7c63f5e90de75234cae0bc9b360`), which contain no NVFP4. This is a llama.cpp WebGPU NVFP4 bug at model scale
(draft in `upstream-issue.md`: native Metal correct, WebGPU NaN, file and build above).

**bartowski files, ctx 8192, all layers on WebGPU (49/49):**

| | Q4_0 | IQ3_XXS | IQ4_XS |
| --- | --- | --- | --- |
| File | 15.06 GB | 13.31 GB | 15.09 GB |
| WebGPU model buffer | 14,107 MiB | 12,209 MiB | 13,906 MiB |
| GPU total (+ KV 496, RS 4, compute 980 MiB) | ~15.6 GiB | ~13.7 GiB | ~15.3 GiB |
| Decode | 18 tok/s | 17.2-17.5 tok/s | 17.4-17.7 tok/s |
| Prefill (~4.8K prompt) | not measured | 84.3 tok/s | 85.0 tok/s |
| Stop in decode (case F) | not run | 56 ms, next job OK | 95 ms, next job OK |
| First load (download + GPU) / cached | | 184 s / ~8 s | 212 s / |
| Shader patch applied / skipped | 5 / 0 | 4 / 0 | 3 / 0 |

Three temperature-0 prompts (sky + octopus fact, iterative Fibonacci, 14:35 to 17:10 duration) were answered correctly by
both IQ3_XXS and IQ4_XS; neither was clearly better. IQ3_XXS was chosen: same speed, 1.7 GiB less GPU memory, fits a 16
GB GPU.

**Chat template behaviour:** reasoning is wrapped as `<|content_thinking|>…<|end_message|>` before the answer.
`enable_thinking=false` has no effect; only `chat_template_kwargs.reasoning_effort` `minimal` or `none` shortens it
(190-280 tokens of reasoning on short prompts). Reasoning cannot be fully disabled (as the model card says).

## 5. Available files (survey 2026-11-21)

113 quantizations on Hugging Face: 45 GGUF, the rest MLX or other runtimes. Most GGUFs are finetunes (uncensored,
abliterated) or one-runtime formats (NVFP4/MXFP4-only, ROCm, NInfer, APEX). Credible general-purpose sources, headers
read:

| File | Size | Arch | NVFP4 | Main weight types |
| --- | --- | --- | --- | --- |
| unsloth Mainline UD-IQ3_XXS | 11.66 GB | inkling2_loop | 20 | IQ3_XXS, IQ2, Q5/Q6_K, Q8_0, BF16 |
| unsloth Mainline UD-IQ4_XS / UD-Q4_K_M | 15.7 / 16.6 GB | inkling2_loop | 40 | Q8_0, BF16 |
| bartowski IQ3_XXS | 13.31 GB | inkling2_loop | 0 | IQ3_XXS, IQ3_S, IQ4_NL, Q5_0, Q6_K, Q8_0 |
| bartowski Q4_0 | 15.06 GB | inkling2_loop | 0 | Q4_0, Q8_0, Q6_K, Q4_1 |
| bartowski IQ4_XS | 15.09 GB | inkling2_loop | 0 | IQ4_XS, IQ4_NL, Q8_0 |
| AtomicChat AD-IQ3_XXS | 12.58 GB | inkling2_loop | 0 | IQ3_XXS, IQ4_NL, Q8_0 |
| ggml-org IQ4_NL | 17.63 GB | inkling2_loop | 0 | IQ4_NL, Q8_0 |
| lmstudio Q4_K_M | 17.48 GB | inkling2_loop | 0 | Q4_K, Q6_K, Q5_0, Q8_0 |
| AtomicChat Q4_K_M | 17.38 GB | inkling2 (old) | 0 | does not load on mainline |

unsloth's root-folder files use unsloth's own tensor naming; mainline fails with
`check_tensor_dims: tensor 'blk.24.attn_q.weight' not found`. Only its `Mainline_Support/*.gguf_file` copies load.

## 6. Outcome

- D48: Inkling-2-Mini added at x3 credits per token, as bartowski IQ3_XXS (13.31 GB, about 13.7 GiB GPU memory at 8K
  context: a 16 GB GPU or a 24 GB+ Mac), context window 8,192 (prefill about 84 tok/s keeps a full prompt inside the
  first-chunk cap).
- D47: the engine is built from a public fork of wllama (`juliomatcom/wllama`, branch `shareinference`) as a git submodule
  of `libs/wllama-webgpu`, llama.cpp pinned by commit, built output committed under `vendor/`, the npm package dropped.
  Shader fixes go in as patch files in the fork and upstream as pull requests.
- The NVFP4 NaN bug is drafted for llama.cpp in `upstream-issue.md` (not filed).

## 7. Also checked: Kintsugi-27B

`CaryPalmer/Kintsugi-27B` (Qwen3.8-27B at 2.47 bits) declares architecture `qwen35`, but 402 of its 2,069 tensors are
raw `I16` codes (`qwen35.escha.version = 1`, an EXL3-style trellis format) that only the authors' CUDA engine decodes.
llama.cpp cannot run it. A standard GGUF quant of Qwen3.8-27B (same `qwen35` architecture) should load on our current
engine.
