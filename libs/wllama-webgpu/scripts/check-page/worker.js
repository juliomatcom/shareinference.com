// Hosts the engine exactly like share-worker.js does in production.
import { createEngine } from "/engine/wllama-3.13.0-b12613/engine.js";

let engine = null;
const logs = [];
const KEEP = /webgpu|offload|buffer size|layers|error|abort|fail/i;
const line = (...args) => {
  const text = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (KEEP.test(text)) logs.push(text);
};
const logger = { debug: line, log: line, warn: line, error: line };

const handlers = {
  async load({ ref, contextWindow, stock, forceProfile }) {
    engine = await createEngine({
      ref,
      contextWindow,
      stockShaders: stock,
      forceProfile,
      logger,
      onProgress: (progress, text) => postMessage({ type: "progress", progress, text }),
    });
    return {
      contextWindow: engine.contextWindow,
      profile: engine.profile,
      shaderPatch: engine.shaderPatch(),
      isolated: self.crossOriginIsolated,
    };
  },
  async unload() {
    await engine?.unload();
    engine = null;
    return {};
  },
  async logs() {
    return { logs: logs.splice(0) };
  },
  async job({ messages, params, abortAfterMs, abortAfterDeltas }) {
    const controller = new AbortController();
    const t0 = performance.now();
    let abortedAt = null;
    const abort = () => {
      if (abortedAt === null) {
        abortedAt = performance.now();
        controller.abort();
      }
    };
    if (abortAfterMs) setTimeout(abort, abortAfterMs);
    const deltas = [];
    let text = "";
    let error = null;
    let result = null;
    try {
      result = await engine.complete({
        messages,
        params,
        signal: controller.signal,
        onDelta: (delta) => {
          deltas.push({ t: performance.now() - t0, chars: delta.length });
          text += delta;
          if (abortAfterDeltas && deltas.length >= abortAfterDeltas) abort();
        },
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const end = performance.now();
    return {
      result,
      error,
      text,
      deltaCount: deltas.length,
      firstDeltaMs: deltas[0]?.t ?? null,
      totalMs: end - t0,
      returnedAfterAbortMs: abortedAt === null ? null : end - abortedAt,
    };
  },
};

self.onmessage = async ({ data }) => {
  const { id, op, ...args } = data;
  try {
    postMessage({ type: "reply", id, ok: true, data: await handlers[op](args) });
  } catch (e) {
    postMessage({ type: "reply", id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
