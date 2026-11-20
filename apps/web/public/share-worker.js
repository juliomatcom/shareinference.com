// Share GPU worker: owns the WebLLM engine and the provider WebSocket (wiki-llm/worker-protocol.md).
// Plain JS, no bundling: the page starts it with `new Worker("/share-worker.js", { type: "module" })`.
// Prompts and completions pass through here only; nothing is stored or logged, and only status/usage reach the page.
import * as webllm from "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.89/+esm";

const HEARTBEAT_MS = 5_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// A connection must stay up this long before the backoff starts over (a flapping link keeps backing off).
const STABLE_MS = 30_000;
// The api closed us for a reason that retrying cannot fix. Anything else, including 4413 (backlog) and 4408
// (timeout), is retried with backoff.
const FATAL_CLOSE = {
  4400: "The server rejected a message from this worker.",
  4404: "The server does not serve this model.",
  4409: "This device is already connected from another tab.",
  4429: "Too many workers are connected for this account.",
};

let engine = null;
let ws = null;
let heartbeat = null;
let reconnectTimer = null;
let stableTimer = null;
let stopped = false;
let attempt = 0;
let loadMs = 0;
let loadedWindow; // context window this engine was loaded with (announced in `ready`)
let cfg = null; // { model, contextWindow, apiUrl, deviceKey, gpu }
let current = null; // { id } while a job runs
let currentDone = Promise.resolve();

const post = (message) => postMessage(message);
const status = (state) => post({ type: "status", state });
const send = (frame) => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
};

onmessage = ({ data }) => {
  switch (data.type) {
    case "start":
      start(data).catch((e) => fail(e));
      break;
    case "token":
      openSocket(data.token);
      break;
    case "token-failed":
      scheduleReconnect();
      break;
    case "stop":
      stop().catch(() => {});
      break;
  }
};

function fail(error) {
  post({ type: "fatal", message: String(error?.message ?? error).slice(0, 300) });
}

async function start(message) {
  cfg = message;
  status("loading");
  const t0 = performance.now();
  // The catalog's context window (`CONTEXT_WINDOWS` in apps/api/src/core/models.ts, sent by the page) overrides the prebuilt record's 4096: WebLLM sizes the KV
  // cache from it at load (wiki-llm/architecture.md).
  const chatOpts =
    Number.isInteger(cfg.contextWindow) && cfg.contextWindow > 0
      ? { context_window_size: cfg.contextWindow }
      : undefined;
  loadedWindow = chatOpts?.context_window_size;
  engine = await webllm.CreateMLCEngine(
    cfg.model,
    { initProgressCallback: (r) => post({ type: "progress", progress: r.progress, text: r.text }) },
    chatOpts,
  );
  // One tiny generation so the first real job does not pay the kernel warm-up (D36).
  await engine.chat.completions.create({
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 4,
    temperature: 0,
  });
  await engine.resetChat();
  loadMs = Math.round(performance.now() - t0);
  if (!stopped) requestToken();
}

// The token is single use and lives 60 s, so it is fetched right before connecting, never before the model loads.
function requestToken() {
  status(attempt === 0 ? "connecting" : "reconnecting");
  post({ type: "need-token" });
}

function openSocket(token) {
  if (stopped) return;
  const base = cfg.apiUrl.replace(/^http/, "ws").replace(/\/$/, "");
  ws = new WebSocket(`${base}/v1/worker`);
  const socket = ws;
  socket.onopen = () => send({ type: "auth", token, protocol: 1, deviceKey: cfg.deviceKey });
  socket.onmessage = (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    onFrame(frame).catch((e) => fail(e));
  };
  socket.onclose = (event) => {
    if (socket !== ws) return;
    clearInterval(heartbeat);
    clearTimeout(stableTimer);
    // Nobody is waiting for this job's output any more.
    if (current) engine.interruptGenerate();
    if (stopped) return;
    if (FATAL_CLOSE[event.code]) {
      stopped = true;
      post({ type: "fatal", message: FATAL_CLOSE[event.code] });
      return;
    }
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (stopped) return;
  status("reconnecting");
  attempt++;
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (attempt - 1));
  // Jitter of +-50%, so many providers do not return in the same instant after an api restart.
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(requestToken, delay * (0.5 + Math.random()));
}

async function onFrame(frame) {
  switch (frame.type) {
    case "welcome":
      // A job from the old connection may still be winding down: never announce `ready` while the engine is busy.
      await currentDone;
      send({
        type: "ready",
        model: cfg.model,
        gpu: cfg.gpu,
        loadMs,
        ...(loadedWindow ? { contextWindow: loadedWindow } : {}),
      });
      clearTimeout(stableTimer);
      stableTimer = setTimeout(() => (attempt = 0), STABLE_MS);
      clearInterval(heartbeat);
      heartbeat = setInterval(() => send({ type: "heartbeat" }), HEARTBEAT_MS);
      status("ready");
      break;
    case "job":
      if (current) send({ type: "error", id: String(frame.id), code: "busy", message: "a job is already running" });
      else currentDone = runJob(frame);
      break;
    case "cancel":
      if (current && current.id === frame.id) engine.interruptGenerate();
      break;
    case "stats":
      post({ type: "stats", stats: frame });
      break;
  }
}

const count = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

async function runJob({ id, messages, params }) {
  current = { id };
  status("busy");
  try {
    // No KV reuse between consumers (D27): every job processes its full history.
    await engine.resetChat();
    const { enable_thinking, ...rest } = params ?? {};
    const request = { messages, stream: true, stream_options: { include_usage: true }, ...rest };
    if (enable_thinking !== undefined) request.extra_body = { enable_thinking };
    const stream = await engine.chat.completions.create(request);
    let finish = null;
    let usage = null;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.delta?.content) send({ type: "chunk", id, delta: choice.delta.content });
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
    send({
      type: "done",
      id,
      finishReason: finish === "length" || finish === "abort" ? finish : "stop",
      usage: {
        promptTokens: count(usage?.prompt_tokens),
        completionTokens: count(usage?.completion_tokens),
        decodeTokensPerS: Math.max(0, Number(usage?.extra?.decode_tokens_per_s) || 0),
      },
    });
  } catch (e) {
    send({ type: "error", id, code: "engine_error", message: String(e?.message ?? e).slice(0, 200) });
  } finally {
    current = null;
    if (ws && ws.readyState === WebSocket.OPEN) status("ready");
  }
}

async function stop() {
  stopped = true;
  clearInterval(heartbeat);
  clearTimeout(reconnectTimer);
  clearTimeout(stableTimer);
  if (ws) ws.close(1000);
  if (current) engine.interruptGenerate();
  await currentDone;
  if (engine) await engine.unload();
  status("stopped");
}
