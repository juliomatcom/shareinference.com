import { describe, expect, it } from "vitest";
import { createThinkSplitter } from "../src/core/thinking.js";

/** Feeds the pieces and returns everything routed to content and reasoning. */
function run(pieces: string[]) {
  const s = createThinkSplitter();
  let content = "";
  let reasoning = "";
  for (const p of [...pieces.map((x) => s.push(x)), s.end()]) {
    content += p.content;
    reasoning += p.reasoning;
  }
  return { content, reasoning };
}

describe("thinking splitter", () => {
  it("routes a leading think block to reasoning and the rest to content", () => {
    expect(run(["<think>plan it</think>\n\nanswer"])).toEqual({ content: "answer", reasoning: "plan it" });
  });

  it("an empty think block (thinking off) yields no reasoning", () => {
    expect(run(["<think>\n\n</think>\n\n", "Hello", " world"])).toEqual({ content: "Hello world", reasoning: "" });
  });

  it("handles tags split across chunks at every position", () => {
    const text = "  <think>deep thought</think>\n\nthe answer";
    for (let at = 1; at < text.length; at++) {
      expect(run([text.slice(0, at), text.slice(at)]), `split at ${at}`).toEqual({
        content: "the answer",
        reasoning: "deep thought",
      });
    }
  });

  it("works one character at a time", () => {
    expect(run([..."<think>ab</think>cd"])).toEqual({ content: "cd", reasoning: "ab" });
  });

  it("output that does not start with a think block passes through untouched", () => {
    expect(run(["Hello ", "<think>not a block</think>"])).toEqual({
      content: "Hello <think>not a block</think>",
      reasoning: "",
    });
    expect(run(["<thi", "s is text"])).toEqual({ content: "<this is text", reasoning: "" });
  });

  it("leading whitespace before plain text is kept", () => {
    expect(run(["  ", "hi"])).toEqual({ content: "  hi", reasoning: "" });
  });

  it("an unclosed think block ends as reasoning", () => {
    expect(run(["<think>never closed </thi"])).toEqual({ content: "", reasoning: "never closed </thi" });
  });

  it("a later think block is plain content", () => {
    expect(run(["<think>a</think>x<think>b</think>"])).toEqual({ content: "x<think>b</think>", reasoning: "a" });
  });
});
