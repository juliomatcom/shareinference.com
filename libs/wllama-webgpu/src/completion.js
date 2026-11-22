// One streamed job on a loaded wllama instance. Split from engine.js, which imports the built wllama bundle, so it can be
// unit-tested with a fake wllama. Prompts and completions pass through here only: nothing is logged.
import { isEmptyThinkPrefix } from "./profiles.js";

const count = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/**
 * Streams one job through `wllama` with the model family's `profile`. `isAbort(error)` tells an abort (resolves with
 * finishReason "abort") from a real failure (rejects).
 */
export async function streamCompletion({ wllama, profile, isAbort, messages, params, signal, onDelta }) {
  const { enable_thinking, ...rest } = params ?? {};
  const normalizer = profile.createNormalizer();
  const templateKwargs = profile.templateKwargs(enable_thinking);
  let held = "";
  let released = false;
  let generated = 0; // raw tokens wllama streamed, whatever the profile hid, merged or held back
  let promptTotal = 0;
  let finish = null;
  let usage = null;
  let timings = null;
  let aborted = false;
  // A template with thinking off writes an empty think block while the prompt is still being processed; it is not
  // generated output, so it is held until real text follows and never starts the api's first-chunk timer early.
  const forward = (text) => {
    if (released) {
      onDelta(text);
      return;
    }
    held += text;
    if (!isEmptyThinkPrefix(held)) {
      released = true;
      onDelta(held);
      held = "";
    }
  };
  try {
    const stream = await wllama.createChatCompletion({
      ...rest,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      cache_prompt: false, // D27: no KV reuse between jobs
      return_progress: true,
      abortSignal: signal,
      ...(templateKwargs ? { chat_template_kwargs: templateKwargs } : {}),
    });
    for await (const chunk of stream) {
      if (chunk.prompt_progress) promptTotal = chunk.prompt_progress.total;
      if (chunk.usage) usage = chunk.usage;
      if (chunk.timings) timings = chunk.timings;
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finish = choice.finish_reason;
      const raw = choice?.delta?.content;
      if (raw) generated++;
      const text = raw ? normalizer.push(raw) : "";
      if (text) forward(text);
    }
    const tail = normalizer.end();
    if (tail) forward(tail);
  } catch (error) {
    if (!isAbort(error)) throw error;
    aborted = true;
  }
  if (!released && held && !aborted) onDelta(held);
  return {
    finishReason: aborted ? "abort" : finish === "length" ? "length" : "stop",
    usage: {
      // wllama drops the final usage on abort: fall back to what this job saw.
      promptTokens: count(usage?.prompt_tokens ?? promptTotal),
      completionTokens: count(usage?.completion_tokens ?? generated),
      decodeTokensPerS: Math.max(0, Number(timings?.predicted_per_second) || 0),
    },
    cachedTokens: count(timings?.cache_n), // D27 check only, never sent to the api
  };
}
