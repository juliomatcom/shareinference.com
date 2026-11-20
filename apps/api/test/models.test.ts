import { describe, expect, it } from "vitest";
import { CONTEXT_WINDOWS, DEFAULT_CONTEXT_WINDOW, contextWindowFor } from "../src/core/models.js";

const SEEDED_IDS = ["qwen3.5-2b", "qwen3.5-4b", "qwen3.5-9b", "gemma-4-e2b"];

describe("contextWindowFor", () => {
  it("defaults to WebLLM's prebuilt 4096 and uses an entry when one exists", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(4096);
    expect(contextWindowFor("not-a-model")).toBe(4096);
    for (const [id, tokens] of Object.entries(CONTEXT_WINDOWS)) expect(contextWindowFor(id)).toBe(tokens);
  });

  it("has an entry for every seeded model, so none silently falls back to 4096", () => {
    for (const id of SEEDED_IDS) expect(CONTEXT_WINDOWS[id], id).toBeGreaterThanOrEqual(8192);
  });

  it("only has entries for seeded models and sane sizes", () => {
    for (const [id, tokens] of Object.entries(CONTEXT_WINDOWS)) {
      expect(SEEDED_IDS, id).toContain(id);
      expect(Number.isInteger(tokens) && tokens >= 2048, id).toBe(true);
    }
  });
});
