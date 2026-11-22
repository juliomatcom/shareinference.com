# Draft: llama.cpp issue (not filed)

Ready to file at https://github.com/ggml-org/llama.cpp/issues. Before filing, re-run
the repro on the then-current release, because this was measured on b12613.

## Title

WebGPU backend: NaN logits for a model with NVFP4 `ffn_down_exps` tensors (Inkling-2-Mini); CPU-side checks and Metal are correct

## Summary

Loading an Inkling-2-Mini GGUF that stores some `ffn_down_exps` tensors in NVFP4 on the WebGPU backend (browser, wasm
build) gives a NaN final hidden state: every logit is `-ln(n_vocab)` (uniform), so greedy decoding emits token 0 forever.
The same file on native Metal (same release) answers correctly. A GGUF of the same model without any NVFP4 tensor
runs correctly on the same WebGPU build. `test-backend-ops` on WebGPU passes the NVFP4 cases at operator size, so the
failure appears only at model scale.

## Environment

- llama.cpp release b12613 (2026-11-21), commit `362ac929749d56e433878585a8506f24968698b4`, which contains #32217,
  #32694 (`inkling2_loop`) and #32704 (loop-scale fix).
- Built to wasm through wllama 3.13.0 (`juliomatcom/wllama` branch `shareinference`, commit
  `df2649c1fdffc16f6dcc65610158d6ad2d72db8b`, which only adds glue for llama.cpp API drift; llama.cpp is untouched).
  Flags: `-DGGML_WEBGPU=ON -DGGML_WEBGPU_JSPI=ON` with Dawn `emdawnwebgpu` v20260317.182325, emsdk 4.0.20,
  memory64, JSPI, wasm exceptions.
- Browser: headless Chrome 157 on macOS, Apple M5 Pro, 48 GB unified memory, `shader-f16` available.
- Native comparison: the same release, Metal backend, same machine.
- Context 8192, all 49 layers offloaded to WebGPU (model buffer 10,863 MiB, KV 256 + 240 MiB, compute 980 MiB).

## Reproduce

1. Model: `thinkingmachines/Inkling-2-Mini` as GGUF, architecture `inkling2_loop`.
   - Failing file: unsloth `Mainline_Support/Inkling-2-Mini-UD-IQ3_XXS.gguf_file` (11.66 GB), repo
     `unsloth/Inkling-2-Mini-GGUF`, revision `ae9327c5fbc7333116ba32eee78bb5d2bbefae4f`. It stores 20 `ffn_down_exps` tensors as NVFP4 (the UD-IQ4_XS and UD-Q4_K_M files store 40).
   - Working file: bartowski `thinkingmachines_Inkling-2-Mini-IQ3_XXS.gguf` (13.31 GB), repo
     `bartowski/thinkingmachines_Inkling-2-Mini-GGUF`, revision `76d57028717ed7c63f5e90de75234cae0bc9b360`. No NVFP4
     tensor (IQ3_XXS, IQ3_S, IQ4_NL, Q5_0, Q6_K, Q8_0).
2. Build llama.cpp b12613 with the WebGPU backend (browser) and load the failing file with all layers on the GPU.
3. Greedy decode (temperature 0) the prompt `The capital of France is`.
4. Result on WebGPU: the final hidden state is NaN; logits are uniform at `-12.206` (`-ln(201024)`); the output is token
   0 (`!`) repeated.
5. Result on native Metal with the same file: `Paris. ...`. Result on WebGPU with the bartowski file: correct text, 17.2
   to 17.5 tok/s decode.

The unsloth files use two layouts: only the `Mainline_Support/*.gguf_file` copies load on mainline (the root-folder
files use unsloth's own tensor names and fail with `check_tensor_dims: tensor 'blk.24.attn_q.weight' not found`).

## What was ruled out

- Our shader patch: stock llama.cpp shaders (patch disabled) give the same NaN.
- The output layer: running it on CPU gives the same NaN, so the NaN is already in the final hidden state.
- The attention variants: changing them does not change the result.
- Operator-level kernels: `test-backend-ops` on the WebGPU backend passed everything that ran (MUL_MAT_ID 1,116 cases
  including nvfp4, SOFT_MAX, FLASH_ATTN_EXT, SSM_CONV, the unary ops). The plain MUL_MAT run did not finish, so it is not
  covered.
- Model file integrity and graph support: native Metal on the same file is correct.
- A bisect by partial offload was not possible: the wasm heap is 4 GB and cannot hold the CPU part of this model.

## Suspect

The only thing the failing files share, and the working files lack, is NVFP4 on `ffn_down_exps` (the MoE down
projection, through `MUL_MAT_ID`). The operator test passes at test sizes, so the likely cause is something that depends
on size or values at model scale: an overflow or a bad scale decode (E4M3 block scales) in the WebGPU NVFP4 dequantisation
path, or a buffer binding limit. A per-layer comparison of the hidden state against the CPU backend (`llama-eval-callback`
or a graph dump) on the failing file would find the first layer that goes NaN; we could not run it in the browser.

## Expected

Same logits as the Metal and CPU backends (or a clear error when a tensor type is not supported on the backend, instead
of silent NaN).

## Impact

The model cannot be served from a browser tab with the NVFP4 quantisations; we ship a non-NVFP4 file instead.
