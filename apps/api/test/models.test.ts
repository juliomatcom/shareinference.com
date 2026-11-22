import { describe, expect, it } from "vitest";
import { JOB_TIMEOUT_MS, PLAYGROUND_JOB_TIMEOUT_MS } from "../src/core/dispatcher.js";
import {
  CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  MIN_PREFILL_TPS,
  contextWindowFor,
  firstChunkTimeoutMs,
} from "../src/core/models.js";

const SEEDED_IDS = ["qwen3.5-2b", "qwen3.5-4b", "qwen3.5-9b", "gemma-4-e2b", "inkling-2-mini"];

describe("contextWindowFor", () => {
  it("defaults to 4096 and uses an entry when one exists", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(4096);
    expect(contextWindowFor("not-a-model")).toBe(4096);
    for (const [id, tokens] of Object.entries(CONTEXT_WINDOWS)) expect(contextWindowFor(id)).toBe(tokens);
  });

  it("has an entry for every seeded model, so none silently falls back to 4096", () => {
    for (const id of SEEDED_IDS) expect(CONTEXT_WINDOWS[id], id).toBeGreaterThanOrEqual(8192);
    expect(contextWindowFor("inkling-2-mini")).toBe(8192);
  });

  it("only has entries for seeded models and sane sizes", () => {
    for (const [id, tokens] of Object.entries(CONTEXT_WINDOWS)) {
      expect(SEEDED_IDS, id).toContain(id);
      expect(Number.isInteger(tokens) && tokens >= 2048, id).toBe(true);
    }
  });
});

describe("firstChunkTimeoutMs", () => {
  it("never goes below 90 s", () => {
    expect(firstChunkTimeoutMs("qwen3.5-9b", 0, JOB_TIMEOUT_MS)).toBe(90_000);
    expect(firstChunkTimeoutMs("qwen3.5-9b", 1_000, JOB_TIMEOUT_MS)).toBe(90_000);
  });

  it("grows with the prompt: 30 s plus the prompt at the model's slowest prefill", () => {
    // 9B at 50 tok/s: 16K tokens = 327.68 s + 30 s.
    expect(firstChunkTimeoutMs("qwen3.5-9b", 16_384, JOB_TIMEOUT_MS)).toBe(357_680);
    expect(firstChunkTimeoutMs("qwen3.5-9b", 8_000, JOB_TIMEOUT_MS)).toBe(190_000);
    expect(firstChunkTimeoutMs("qwen3.5-2b", 16_384, JOB_TIMEOUT_MS)).toBe(139_227);
    // 4B at 72 tok/s: 227.56 s + 30 s. Gemma at 190 tok/s: 86.23 s + 30 s.
    expect(firstChunkTimeoutMs("qwen3.5-4b", 16_384, JOB_TIMEOUT_MS)).toBe(257_556);
    expect(firstChunkTimeoutMs("gemma-4-e2b", 16_384, JOB_TIMEOUT_MS)).toBe(116_232);
    expect(firstChunkTimeoutMs("qwen3.5-9b", 16_384, JOB_TIMEOUT_MS)).toBeGreaterThan(
      firstChunkTimeoutMs("qwen3.5-9b", 8_000, JOB_TIMEOUT_MS),
    );
  });

  it("is capped at 80% of the job's total time, for API and Playground", () => {
    expect(firstChunkTimeoutMs("qwen3.5-9b", 1_000_000, JOB_TIMEOUT_MS)).toBe(JOB_TIMEOUT_MS * 0.8);
    expect(firstChunkTimeoutMs("qwen3.5-9b", 1_000_000, PLAYGROUND_JOB_TIMEOUT_MS)).toBe(
      PLAYGROUND_JOB_TIMEOUT_MS * 0.8,
    );
    // A full 16K prompt on 9B (357.7 s) does not fit a Playground job's 240 s.
    expect(firstChunkTimeoutMs("qwen3.5-9b", 16_384, PLAYGROUND_JOB_TIMEOUT_MS)).toBe(240_000);
  });

  it("lets a full Inkling prompt reach its first chunk inside a Playground job", () => {
    // 8K at 42 tok/s: 195.05 s + 30 s = 225 s, under the Playground's 80% cap (240 s): not clipped.
    const timeout = firstChunkTimeoutMs(
      "inkling-2-mini",
      contextWindowFor("inkling-2-mini"),
      PLAYGROUND_JOB_TIMEOUT_MS,
    );
    expect(timeout).toBe(225_048);
    expect(timeout).toBeLessThan(PLAYGROUND_JOB_TIMEOUT_MS * 0.8);
  });

  it("uses 50 tok/s for an unknown id", () => {
    expect(firstChunkTimeoutMs("not-a-model", 8_000, JOB_TIMEOUT_MS)).toBe(
      firstChunkTimeoutMs("qwen3.5-9b", 8_000, JOB_TIMEOUT_MS),
    );
  });

  it("has an entry for every seeded model", () => {
    for (const id of SEEDED_IDS) expect(MIN_PREFILL_TPS[id], id).toBeGreaterThan(0);
    expect(Object.keys(MIN_PREFILL_TPS).sort()).toEqual([...SEEDED_IDS].sort());
  });
});
