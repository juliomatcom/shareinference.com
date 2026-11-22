import assert from "node:assert/strict";
import { test } from "node:test";
import { streamCompletion } from "../src/completion.js";
import { selectProfile } from "../src/profiles.js";

class FakeAbort extends Error {}
const isAbort = (error) => error instanceof FakeAbort;

const token = (content) => ({ choices: [{ delta: { content } }] });
const final = (usage, finish = "stop") => [
  { choices: [{ delta: {}, finish_reason: finish }] },
  { choices: [], usage, timings: { predicted_per_second: 12.5, cache_n: 0 } },
];

// A wllama whose stream yields `events`; `abortAfter` throws the abort error once that many events were yielded
// (wllama drops its final usage chunk on abort).
const fakeWllama = (events, { abortAfter, fail } = {}) => {
  const calls = [];
  return {
    calls,
    async createChatCompletion(options) {
      calls.push(options);
      return (async function* () {
        let seen = 0;
        for (const event of events) {
          if (abortAfter !== undefined && seen === abortAfter) throw new FakeAbort("aborted");
          yield event;
          seen++;
        }
        if (fail) throw new Error("boom");
      })();
    },
  };
};

const run = async (architecture, wllama, params) => {
  const deltas = [];
  const result = await streamCompletion({
    wllama,
    profile: selectProfile(architecture),
    isAbort,
    messages: [{ role: "user", content: "hi" }],
    params,
    signal: undefined,
    onDelta: (d) => deltas.push(d),
  });
  return { deltas, result };
};

test("qwen: the empty think block is held until real text, then sent in one delta", async () => {
  const events = [token("<think>"), token("\n\n"), token("</think>"), token("\n\n"), token("Hel"), token("lo")];
  const { deltas, result } = await run(
    "qwen35",
    fakeWllama([...events, ...final({ prompt_tokens: 9, completion_tokens: 6 })]),
    { enable_thinking: false, max_tokens: 50 },
  );
  assert.deepEqual(deltas, ["<think>\n\n</think>\n\nHel", "lo"]);
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.usage, { promptTokens: 9, completionTokens: 6, decodeTokensPerS: 12.5 });
});

test("the params reach wllama; enable_thinking becomes the family's template variable and is not passed on", async () => {
  const wllama = fakeWllama(final({ prompt_tokens: 1, completion_tokens: 0 }));
  await run("qwen35", wllama, { enable_thinking: true, max_tokens: 7, temperature: 0.2 });
  const [call] = wllama.calls;
  assert.equal(call.max_tokens, 7);
  assert.equal(call.temperature, 0.2);
  assert.equal(call.enable_thinking, undefined);
  assert.deepEqual(call.chat_template_kwargs, { enable_thinking: true });
  assert.equal(call.cache_prompt, false);
  assert.equal(call.stream, true);

  const inkling = fakeWllama(final({ prompt_tokens: 1, completion_tokens: 0 }));
  await run("inkling2_loop", inkling, {});
  assert.deepEqual(inkling.calls[0].chat_template_kwargs, { reasoning_effort: "medium" });
  const plain = fakeWllama(final({ prompt_tokens: 1, completion_tokens: 0 }));
  await run("qwen35", plain, {});
  assert.equal("chat_template_kwargs" in plain.calls[0], false);
});

test("inkling: marker tokens are rewritten or dropped, the usage chunk wins over the raw count", async () => {
  const events = [
    token("<|message_model|>"),
    token("<|content_thinking|>"),
    token("2+2"),
    token("<|end_message|>"),
    token("<|message_model|>"),
    token("<|content_text|>"),
    token("4"),
    token("<|end_message|>"),
    token("<|content_model_end_sampling|>"),
  ];
  const { deltas, result } = await run(
    "inkling2_loop",
    fakeWllama([...events, ...final({ prompt_tokens: 20, completion_tokens: 9 })]),
    {},
  );
  assert.equal(deltas.join(""), "<think>2+2</think>4");
  assert.equal(result.usage.completionTokens, 9); // 9 raw tokens, only 3 deltas reached the api
  assert.ok(deltas.length < 9);
});

test("abort mid-stream: usage falls back to the raw tokens generated, not the forwarded deltas", async () => {
  // Five raw tokens, but the Inkling profile forwards fewer deltas (markers dropped, partial markers held back).
  const events = [
    { choices: [], prompt_progress: { total: 33, processed: 33 } },
    token("<|content_thinking|>"),
    token("a"),
    token("b"),
    token("<|end_message|>"),
    token("<|content_text|>"),
    token("c"),
    token("never reached"),
  ];
  const { deltas, result } = await run("inkling2_loop", fakeWllama(events, { abortAfter: 7 }), {});
  assert.equal(result.finishReason, "abort");
  assert.equal(result.usage.promptTokens, 33);
  assert.equal(result.usage.completionTokens, 6); // every token wllama streamed before the abort
  assert.ok(deltas.length < 6);
  assert.equal(result.usage.decodeTokensPerS, 0);
});

test("abort while text is still held back sends nothing and still counts the tokens", async () => {
  const events = [token("<think>"), token("\n\n"), token("</think>"), token("more")];
  const { deltas, result } = await run("qwen35", fakeWllama(events, { abortAfter: 3 }), {});
  assert.deepEqual(deltas, []);
  assert.equal(result.finishReason, "abort");
  assert.equal(result.usage.completionTokens, 3);
});

test("end of stream flushes what was held back", async () => {
  // Only an empty think block: held until the end, then sent so the api can fail the empty output itself.
  const empty = await run(
    "qwen35",
    fakeWllama([token("<think>"), token("</think>"), ...final({ prompt_tokens: 2 })]),
    {},
  );
  assert.deepEqual(empty.deltas, ["<think></think>"]);

  // A tail that only looked like the start of a marker is text after all.
  const tail = await run(
    "gemma4",
    fakeWllama([token("Hi"), token(" <tu"), ...final({ prompt_tokens: 2, completion_tokens: 2 })]),
    {},
  );
  assert.equal(tail.deltas.join(""), "Hi <tu");
});

test("finish reason length is kept; a missing usage chunk falls back to the raw count", async () => {
  const { result } = await run(
    "qwen35",
    fakeWllama([token("a"), token("b"), ...final(undefined, "length").slice(0, 1)]),
    {},
  );
  assert.equal(result.finishReason, "length");
  assert.equal(result.usage.completionTokens, 2);
  assert.equal(result.usage.promptTokens, 0);
});

test("a failure that is not an abort rejects", async () => {
  await assert.rejects(run("qwen35", fakeWllama([token("a")], { fail: true }), {}), /boom/);
});
