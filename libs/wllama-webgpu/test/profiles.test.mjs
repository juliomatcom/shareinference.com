import assert from "node:assert/strict";
import { test } from "node:test";
import { createMarkerNormalizer, isEmptyThinkPrefix, selectProfile } from "../src/profiles.js";

const GEMMA_OPEN = "<|channel>thought\n";
const GEMMA_CLOSE = "<channel|>";
const INKLING_OPEN = "<|content_thinking|>";

// Runs a whole stream through a fresh normalizer; `chunks` are the deltas, split exactly as given.
const run = (profile, chunks) => {
  const n = profile.createNormalizer();
  const parts = chunks.map((c) => n.push(c));
  parts.push(n.end());
  return { text: parts.join(""), parts };
};
const chars = (s) => s.split("");

test("selectProfile maps the GGUF architecture and falls back to the default", () => {
  assert.equal(selectProfile("gemma4").id, "gemma4");
  assert.equal(selectProfile("inkling2_loop").id, "inkling2_loop");
  assert.equal(selectProfile("qwen35").id, "default");
  assert.equal(selectProfile(undefined).id, "default");
  // Inherited Object.prototype keys must not be mistaken for an architecture.
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(selectProfile(name).id, "default", name);
  }
});

test("thinking switch maps to the variable each template reads", () => {
  const qwen = selectProfile("qwen35");
  assert.deepEqual(qwen.templateKwargs(false), { enable_thinking: false });
  assert.deepEqual(qwen.templateKwargs(true), { enable_thinking: true });
  assert.equal(qwen.templateKwargs(undefined), undefined);

  const gemma = selectProfile("gemma4");
  assert.deepEqual(gemma.templateKwargs(true), { enable_thinking: true });
  assert.deepEqual(gemma.templateKwargs(false), { enable_thinking: false });

  const inkling = selectProfile("inkling2_loop");
  assert.deepEqual(inkling.templateKwargs(false), { reasoning_effort: "minimal" });
  assert.deepEqual(inkling.templateKwargs(true), { reasoning_effort: "medium" }); // not the template's "high"
  assert.deepEqual(inkling.templateKwargs(undefined), { reasoning_effort: "medium" }); // unset = on, never the "high" default
});

test("default profile passes text through untouched", () => {
  const stream = ["<think>\n", "plan", "</think>\n\n", "Hi <|end_message|> <channel|>"];
  assert.equal(run(selectProfile("qwen35"), stream).text, stream.join(""));
});

test("inkling: reasoning and answer become <think>…</think>answer", () => {
  const { text } = run(selectProfile("inkling2_loop"), [INKLING_OPEN, "Easy: ", "2+2.", "<|end_message|>", "4"]);
  assert.equal(text, "<think>Easy: 2+2.</think>4");
});

test("inkling: template markers around the answer are removed", () => {
  const { text } = run(selectProfile("inkling2_loop"), [
    "<|message_model|>",
    INKLING_OPEN,
    "think",
    "<|end_message|>",
    "<|message_model|><|content_text|>",
    "Paris.",
    "<|end_message|>",
    "<|content_model_end_sampling|>",
  ]);
  assert.equal(text, "<think>think</think>Paris.");
});

test("inkling: a reply without reasoning stays as it is, markers aside", () => {
  const { text } = run(selectProfile("inkling2_loop"), ["<|content_text|>", "Hello", "<|end_message|>"]);
  assert.equal(text, "Hello");
});

test("inkling: only the first reasoning block is wrapped", () => {
  const { text } = run(selectProfile("inkling2_loop"), [
    INKLING_OPEN,
    "a",
    "<|end_message|>",
    "answer ",
    INKLING_OPEN,
    "b",
    "<|end_message|>",
    "end",
  ]);
  assert.equal(text, "<think>a</think>answer bend");
});

test("markers split at every character boundary give the same text and never leak a partial marker", () => {
  const cases = [
    [
      selectProfile("inkling2_loop"),
      `${INKLING_OPEN}why<|end_message|><|message_model|><|content_text|>ok<|end_message|>`,
    ],
    [selectProfile("gemma4"), `${GEMMA_OPEN}why\n${GEMMA_CLOSE}ok<turn|>`],
  ];
  for (const [profile, input] of cases) {
    const whole = run(profile, [input]).text;
    const { text, parts } = run(profile, chars(input));
    assert.equal(text, whole);
    assert.equal(whole.startsWith("<think>why"), true);
    for (const part of parts) assert.doesNotMatch(part, /<\||\|>|<channel|<turn/);
  }
});

test("a partial marker prefix is held until it resolves, and released as text if it was not a marker", () => {
  const n = createMarkerNormalizer({ open: "<|a|>", close: "<|b|>" });
  assert.equal(n.push("<|"), "");
  assert.equal(n.push("a"), "");
  assert.equal(n.push("|>y"), "<think>y");
  const m = createMarkerNormalizer({ open: "<|a|>", close: "<|b|>" });
  assert.equal(m.push("1 <|"), "1 ");
  assert.equal(m.push("c"), "<|c");
  assert.equal(m.push("<"), "");
  assert.equal(m.end(), "<");
});

test("whitespace before the reasoning is dropped; before plain text it is kept", () => {
  const inkling = selectProfile("inkling2_loop");
  assert.equal(run(inkling, ["\n", INKLING_OPEN, "r", "<|end_message|>", "a"]).text, "<think>r</think>a");
  assert.equal(run(inkling, ["\n", "hello"]).text, "\nhello");
  assert.equal(run(inkling, ["\n"]).text, "\n"); // whitespace-only output stays visible to the api's empty-output check
});

test("an unfinished reasoning block (length cut) is not closed", () => {
  const { text } = run(selectProfile("gemma4"), [GEMMA_OPEN, "still think"]);
  assert.equal(text, "<think>still think");
});

test("gemma4 thinking on: channel markers become think tags", () => {
  const { text } = run(selectProfile("gemma4"), [GEMMA_OPEN, "The user says hi.\n", GEMMA_CLOSE, "Hello!"]);
  assert.equal(text, "<think>The user says hi.\n</think>Hello!");
});

test("gemma4 thinking off: plain answer, and an empty channel becomes an empty think block", () => {
  const gemma = selectProfile("gemma4");
  assert.equal(run(gemma, ["Hello!", "<turn|>"]).text, "Hello!");
  const { text } = run(gemma, [GEMMA_OPEN, GEMMA_CLOSE, "Hello!"]);
  assert.equal(text, "<think></think>Hello!");
  assert.equal(isEmptyThinkPrefix("<think></think>"), true); // held back until the answer starts
});

test("hold-back predicate: scaffolding is held, real text is not", () => {
  for (const held of ["<", "<think>", "<think>\n\n", "<think></", "<think>\n</think>", " \n"]) {
    assert.equal(isEmptyThinkPrefix(held), true, JSON.stringify(held));
  }
  for (const real of ["<think>a", "Hello", "<think></think>x", "</think>"]) {
    assert.equal(isEmptyThinkPrefix(real), false, JSON.stringify(real));
  }
});
