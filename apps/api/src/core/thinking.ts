// Splits a leading `<think>...</think>` block off a model's output (wiki-llm/architecture.md "Thinking output").
// The tags may arrive split across chunks, so text that could still become a tag is held back until it is decided.
const OPEN = "<think>";
const CLOSE = "</think>";

export interface Split {
  /** Text for the visible answer. */
  content: string;
  /** Text of the think block (`reasoning_content`). */
  reasoning: string;
}

export interface ThinkSplitter {
  push(text: string): Split;
  /** The stream ended: releases whatever is still held back. */
  end(): Split;
}

/** Length of the longest suffix of `text` that is a proper prefix of `tag`. */
function partialTag(text: string, tag: string): number {
  for (let n = Math.min(text.length, tag.length - 1); n > 0; n--) {
    if (tag.startsWith(text.slice(-n))) return n;
  }
  return 0;
}

export function createThinkSplitter(): ThinkSplitter {
  // start: still deciding whether the output opens with <think>; thinking: inside the block; answer: past it.
  let state: "start" | "thinking" | "answer" = "start";
  let held = "";
  // Whitespace right after <think> and after </think> is layout, not content.
  let trimNext = false;

  const empty = (): Split => ({ content: "", reasoning: "" });

  function step(): Split {
    const out = empty();
    for (;;) {
      if (trimNext) {
        held = held.trimStart();
        if (held === "") return out;
        trimNext = false;
      }
      if (state === "start") {
        const text = held.trimStart();
        if (text.startsWith(OPEN)) {
          held = text.slice(OPEN.length);
          state = "thinking";
          trimNext = true;
          continue;
        }
        // Whitespace alone, or the beginning of a tag: wait for more.
        if (text === "" || OPEN.startsWith(text)) return out;
        out.content += held;
        held = "";
        state = "answer";
        return out;
      }
      if (state === "thinking") {
        const at = held.indexOf(CLOSE);
        if (at === -1) {
          const keep = partialTag(held, CLOSE);
          out.reasoning += held.slice(0, held.length - keep);
          held = held.slice(held.length - keep);
          return out;
        }
        out.reasoning += held.slice(0, at);
        held = held.slice(at + CLOSE.length);
        state = "answer";
        trimNext = true;
        continue;
      }
      out.content += held;
      held = "";
      return out;
    }
  }

  return {
    push(text) {
      held += text;
      return step();
    },
    end() {
      // Never decided: it was not a think block. An unclosed block releases its tail as reasoning.
      const out = empty();
      if (state === "thinking") out.reasoning = held;
      else if (!trimNext) out.content = held;
      held = "";
      return out;
    },
  };
}
