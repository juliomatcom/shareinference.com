import assert from "node:assert/strict";
import { test } from "node:test";
import { patchMulMatShader } from "../src/shader-patch.js";

const SHARED = "var<workgroup> shmem: array<f16, TILE_SRC0_SHMEM + TILE_SRC1_SHMEM>;";

// Smallest WGSL that contains every string the patch matches.
const fixture = (src0Stride = "32u", src1Stride = "32u") => `
const TILE_SRC0_SHMEM = 32u * 8u * 4u;
const TILE_SRC1_SHMEM = 32u * 8u * 4u;
${SHARED}
fn store_val(acc: array<array<f32, 4u>, 4u>, tn: u32, tm: u32) -> f32 { return acc[tn][tm]; }
@compute @workgroup_size(64)
fn main() {
    var acc: array<array<f32, 4u>, 4u>;
    for (var i = 0u; i < 8u; i++) {
        shmem[elem_idx] = f16(src0[i]);
        shmem[TILE_SRC0_SHMEM + elem_idx] = f16(src1[i]);
    }
    for (var k_inner = 0u; k_inner < 32u; k_inner++) {
        let src0_idx = k_inner + src0_m * ${src0Stride};
        let src1_idx = src1_n * ${src1Stride} + k_inner;
        var src0_tile: array<f16, 4u>;
        for (var tm = 0u; tm < 4u; tm++) {
            let src1_val = shmem[src1_idx];
            for (var tn = 0u; tn < 4u; tn++) {
                acc[tm][tn] += f32(src0_tile[tm]) * f32(src1_val);
            }
        }
    }
    let dst_batch_offset = 0u;
    let v = store_val(acc, tn, tm);
}
`;

test("patches the recognised shader shape", () => {
  const out = patchMulMatShader(fixture());
  assert.ok(out);
  assert.ok(!/\bshmem\[/.test(out));
  // store_val keeps its f32 signature (it is the match target); only the accumulator declaration must be gone.
  assert.ok(!out.includes("var acc: array<array<f32"));
  assert.ok(out.includes("shm_set"));
});

test("leaves unrecognised shaders stock (null)", () => {
  assert.equal(patchMulMatShader(""), null);
  assert.equal(patchMulMatShader(fixture().replace(SHARED, "")), null);
  assert.equal(patchMulMatShader(fixture("32u", "16u")), null);
});

test("does not mutate or depend on the input string", () => {
  const input = fixture();
  const copy = String(input);
  patchMulMatShader(input);
  assert.equal(input, copy);
});

test("patches the vec4 destination variant with a vec4 store", () => {
  const vec = fixture().replace("-> f32 { return acc[tn][tm]; }", "-> vec4<f32> { return vec4<f32>(acc[tm][tn]); }");
  const out = patchMulMatShader(vec);
  assert.ok(out);
  assert.ok(out.includes("vec4<f32>(acc[tn][tm], acc[tn][tm + 1u], acc[tn][tm + 2u], acc[tn][tm + 3u])"));
  assert.ok(!patchMulMatShader(fixture()).includes("acc[tn][tm + 1u]"));
});

test("stays stock (null) when store_val is called more than once", () => {
  const two = fixture().replace(
    "let v = store_val(acc, tn, tm);",
    "let v = store_val(acc, tn, tm);\n    let w = store_val(acc, tn, tm);",
  );
  assert.equal(patchMulMatShader(two), null);
});
