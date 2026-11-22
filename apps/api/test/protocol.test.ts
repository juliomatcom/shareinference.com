import { describe, expect, it } from "vitest";
import { MAX_FRAME_BYTES, inboundFrame, outboundFrame } from "../src/core/protocol.js";

const gpu = { vendor: "apple", architecture: "metal-3", shaderF16: true, maxBufferSize: 4294967296 };
const valid = [
  { type: "auth", token: "t", protocol: 1, deviceKey: "abcdefgh-1234" },
  {
    type: "ready",
    model: "unsloth/Qwen3.5-4B-GGUF@e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf",
    gpu,
    loadMs: 1700,
  },
  { type: "heartbeat" },
  { type: "chunk", id: "j1", delta: "<think>\n\n</think>\n\n" },
  {
    type: "done",
    id: "j1",
    finishReason: "stop",
    usage: { promptTokens: 5, completionTokens: 9, decodeTokensPerS: 40.5 },
  },
  { type: "error", id: "j1", code: "engine_error", message: "boom" },
  // Inkling's ref is 132 characters: the cap on `model` must leave room for the catalog's longest ref.
  {
    type: "ready",
    model:
      "bartowski/thinkingmachines_Inkling-2-Mini-GGUF@76d57028717ed7c63f5e90de75234cae0bc9b360/thinkingmachines_Inkling-2-Mini-IQ3_XXS.gguf",
    gpu,
    loadMs: 8000,
  },
];

describe("inbound frames", () => {
  it.each(valid)("accepts a valid $type frame", (frame) => {
    expect(inboundFrame.safeParse(frame).success).toBe(true);
  });

  it.each([
    ["wrong protocol version", { ...valid[0], protocol: 2 }],
    ["short device key", { ...valid[0], deviceKey: "short" }],
    ["device key with spaces", { ...valid[0], deviceKey: "has space in it" }],
    ["extra key", { ...valid[2], extra: 1 }],
    ["unknown type", { type: "hello" }],
    ["no type", { token: "t" }],
    ["negative loadMs", { ...valid[1], loadMs: -1 }],
    [
      "non-integer token count",
      { ...valid[4], usage: { promptTokens: 1.5, completionTokens: 1, decodeTokensPerS: 1 } },
    ],
    ["huge token count", { ...valid[4], usage: { promptTokens: 1, completionTokens: 1e12, decodeTokensPerS: 1 } }],
    ["unknown finish reason", { ...valid[4], finishReason: "tool_calls" }],
    ["oversized delta", { ...valid[3], delta: "x".repeat(16_385) }],
    ["gpu missing a field", { ...valid[1], gpu: { vendor: "apple" } }],
    ["non-string id", { ...valid[3], id: 7 }],
    ["array", []],
    ["null", null],
  ])("rejects %s", (_name, frame) => {
    expect(inboundFrame.safeParse(frame).success).toBe(false);
  });

  it("frames fit the 64 KiB socket limit", () => {
    expect(MAX_FRAME_BYTES).toBe(65_536);
    // The largest legal delta (16k chars, up to 3 bytes each: 48 KiB as UTF-8) stays under the limit.
    expect(Buffer.byteLength(JSON.stringify({ ...valid[3], delta: "€".repeat(16_384) }))).toBeLessThan(MAX_FRAME_BYTES);
  });
});

describe("outbound frames", () => {
  it("covers welcome, job, cancel and stats", () => {
    for (const frame of [
      { type: "welcome", workerId: "w" },
      {
        type: "job",
        id: "j",
        messages: [{ role: "user", content: "hi" }],
        params: { temperature: 0, enable_thinking: false },
      },
      { type: "cancel", id: "j" },
      { type: "stats", jobsServed: 0, promptTokens: 0, completionTokens: 0, creditsEarned: 0, lastJob: null },
      {
        type: "stats",
        jobsServed: 3,
        promptTokens: 30,
        completionTokens: 90,
        creditsEarned: 480,
        lastJob: { promptTokens: 10, completionTokens: 30, decodeTokensPerS: 25.5, credits: 160 },
      },
    ]) {
      expect(outboundFrame.safeParse(frame).success).toBe(true);
    }
  });
});
