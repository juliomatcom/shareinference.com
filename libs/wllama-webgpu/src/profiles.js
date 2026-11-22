// Per-model-family adapters (pure, no wllama, no DOM). The api's thinking parser (D31) only understands
// `<think>…</think>` at the start of the content, so every family's reasoning markup is rewritten to that shape here, and
// the thinking on/off switch is mapped to the chat-template variable the family's template actually reads.
// Prompts and completions pass through here: nothing is logged.

const OPEN = "<think>";
const CLOSE = "</think>";

/**
 * Rewrites a streamed completion: `open` becomes `<think>` and `close` becomes `</think>`, `drop` markers vanish. Markers
 * may arrive split across deltas, so a tail that could still grow into a marker is held back; a partial marker is never
 * emitted. Only the first reasoning block of a reply is wrapped (the api reads one, at the start): a later `open`, a
 * stray `close` or any `drop` marker is removed and the text around it stays content. No marker may be a prefix of
 * another one.
 */
export function createMarkerNormalizer({ open, close, drop = [] }) {
  const markers = [open, close, ...drop];
  // start: nothing but whitespace seen (an `open` may still come); thinking: inside the block; answer: past it.
  let state = "start";
  let pendingSpace = ""; // whitespace before the first real text: dropped if reasoning opens, else sent with the text
  let buffer = "";

  const text = (segment) => {
    if (!segment) return "";
    if (state !== "start") return segment;
    if (segment.trim() === "") {
      pendingSpace += segment;
      return "";
    }
    state = "answer";
    const out = pendingSpace + segment;
    pendingSpace = "";
    return out;
  };

  const marker = (found) => {
    if (found === open && state === "start") {
      state = "thinking";
      pendingSpace = "";
      return OPEN;
    }
    if (found === close && state === "thinking") {
      state = "answer";
      return CLOSE;
    }
    return "";
  };

  // Length of the longest tail of `s` that is a proper prefix of some marker.
  const pendingTail = (s) => {
    for (let n = Math.min(s.length, Math.max(...markers.map((m) => m.length)) - 1); n > 0; n--) {
      const tail = s.slice(s.length - n);
      if (markers.some((m) => m.startsWith(tail))) return n;
    }
    return 0;
  };

  return {
    push(delta) {
      buffer += delta;
      let out = "";
      for (;;) {
        let at = -1;
        let found = null;
        for (const m of markers) {
          const i = buffer.indexOf(m);
          if (i >= 0 && (at < 0 || i < at)) [at, found] = [i, m];
        }
        if (found === null) break;
        out += text(buffer.slice(0, at)) + marker(found);
        buffer = buffer.slice(at + found.length);
      }
      const keep = pendingTail(buffer);
      out += text(buffer.slice(0, buffer.length - keep));
      buffer = buffer.slice(buffer.length - keep);
      return out;
    },
    /** What is still held when the generation ends: text that only looked like the start of a marker. */
    end() {
      const out = text(buffer) + pendingSpace;
      buffer = "";
      pendingSpace = "";
      return out;
    },
  };
}

const passthrough = () => ({ push: (delta) => delta, end: () => "" });
const enableThinking = (on) => (on === undefined ? undefined : { enable_thinking: on });

// Qwen3.5 and any unknown architecture: the template already writes `<think>…</think>` and reads enable_thinking.
const DEFAULT = { id: "default", templateKwargs: enableThinking, createNormalizer: passthrough };

// Gemma 4: thinking on prefixes the reply with `<|channel>thought\n…<channel|>`; `<turn|>` ends a turn. The template
// reads enable_thinking (default off).
const GEMMA4 = {
  id: "gemma4",
  templateKwargs: enableThinking,
  createNormalizer: () =>
    createMarkerNormalizer({ open: "<|channel>thought\n", close: "<channel|>", drop: ["<turn|>"] }),
};

// Inkling 2: the reply is `<|content_thinking|>REASONING<|end_message|>` then the answer; the template ignores
// enable_thinking and reads reasoning_effort (default "high"; it cannot be turned off, only minimised, so thinking off
// still yields a short `<think>` block, billed as output like any other, D28). Thinking on, and unset, ask for "medium":
// the default "high" reasons for so long that a reply at x3 credits per token runs past the job's time and costs too
// much, and an API client that never sends enable_thinking must not get that surprise.
// The answer may carry the template's role and content markers, which are not text for the consumer.
const INKLING = {
  id: "inkling2_loop",
  templateKwargs: (on) => ({ reasoning_effort: on === false ? "minimal" : "medium" }),
  createNormalizer: () =>
    createMarkerNormalizer({
      open: "<|content_thinking|>",
      close: "<|end_message|>",
      drop: ["<|message_model|>", "<|content_text|>", "<|content_model_end_sampling|>"],
    }),
};

const BY_ARCHITECTURE = { gemma4: GEMMA4, inkling2_loop: INKLING };

/** The adapter for a GGUF `general.architecture` value; anything unknown gets the Qwen-style default. */
// hasOwn: the architecture string comes from a GGUF file, and "constructor" or "__proto__" must not hit Object.prototype.
export const selectProfile = (architecture) =>
  Object.hasOwn(BY_ARCHITECTURE, architecture) ? BY_ARCHITECTURE[architecture] : DEFAULT;

/** True while the normalised text so far can still become an empty think block: it must not reach the api yet. */
export const isEmptyThinkPrefix = (text) => `${OPEN}${CLOSE}`.startsWith(text.replace(/\s+/g, ""));
