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
    // Only the first call site is rewritten below; a second one would keep reading the removed `acc` array and fail WGSL
    // validation asynchronously, so anything but exactly one site stays stock.
    code.split("store_val(acc, tn, tm)").length !== 2 ||
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
  // The VEC variant (vec4 destination) stores four rows at once; the SCALAR one stores a single value.
  const vector = /fn store_val\([^)]*\)\s*->\s*vec4<f32>/.test(code);
  const vectorStore = "vec4<f32>(acc[tn][tm], acc[tn][tm + 1u], acc[tn][tm + 2u], acc[tn][tm + 3u])";
  const next = code
    .replace(inner, loop)
    .replace(/shmem\[([^\]]+)\]\s*=\s*([^;]+);/g, "shm_set($1, $2);")
    .replace(shared, storage)
    .replace(accumulator, "var a0 = vec4<f32>(); var a1 = vec4<f32>(); var a2 = vec4<f32>(); var a3 = vec4<f32>();")
    .replace("let dst_batch_offset =", "var acc = array<vec4<f32>, 4u>(a0, a1, a2, a3);\n    let dst_batch_offset =")
    .replace("store_val(acc, tn, tm)", vector ? vectorStore : "acc[tn][tm]");
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
