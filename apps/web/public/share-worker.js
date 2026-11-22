// Share GPU worker: owns the wllama engine and the provider WebSocket (wiki-llm/worker-protocol.md).
// Plain JS, no bundling: the page starts it with `new Worker("/share-worker.js", { type: "module" })`.
// Prompts and completions pass through here only; nothing is stored or logged, and only status/usage reach the page.
import { createEngine } from "/engine/wllama-3.13.0-b12613/engine.js";

const HEARTBEAT_MS = 5_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// A connection must stay up this long before the backoff starts over (a flapping link keeps backing off).
const STABLE_MS = 30_000;
// The api drops a worker silent for 15 s and answers every heartbeat with `pong`: hearing nothing for this long means
// the socket is dead (machine slept, tab frozen, network changed) even when the browser has not noticed.
const DEAD_MS = 15_000;
// After a wake-up hint the socket gets this long to answer a heartbeat before it is replaced.
const WAKE_CHECK_MS = 4_000;
// Consecutive failed jobs (engine exceptions) after which the engine is reloaded: a lost GPU device does not heal.
const MAX_ENGINE_FAILURES = 3;
// The page's token request gets this long before the worker gives up on it and retries (a fetch can hang when the
// machine slept mid-request).
const TOKEN_WAIT_MS = 15_000;
// An engine exception counts as a failing engine unless it is the consumer's fault: a prompt over the context window
// must not make a provider unload its model. Everything else (device loss, wasm trap, "Model failed to start
// inference", a failed allocation) is an engine failure, since the error text of a broken engine cannot be predicted.
// Kept narrow on purpose: a bare /context/ would also match "failed to allocate context". The texts are llama.cpp's
// (request over n_ctx, or the context filling up mid-generation).
const PROMPT_ERROR =
  /exceeds the available context size|context size has been exceeded|larger than the max context size|prompt (is )?too long/i;
// How long Stop and an engine unload wait before giving up on a stuck engine.
const INTERRUPT_WAIT_MS = 15_000;
// A job that does not end this long after an abort is stuck (e.g. a hung engine after device loss): rebuild the engine.
// The engine only sees an abort between 512-token batches, so on a slow GPU one batch can take well over 15 s; this
// stays just under the api's 30 s cancel grace (`CANCEL_GRACE_MS`), after which the api gives up on the job anyway.
const ABORT_WATCHDOG_MS = 25_000;
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
let lastHeard = 0; // performance.now() of the last frame from the api (pong included)
let wakeTimer = null;
let tokenPending = false; // a `need-token` is out and its answer has not arrived
let tokenTimer = null;
let pongSeen = false; // this socket's api answers heartbeats (an api from before `pong` never does)
let engineFailures = 0;
let recovering = false;
let loaded = false; // the engine is built and warm: the worker may connect
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
      // A token that arrives after its wait ran out belongs to an attempt that was already replaced.
      if (!tokenPending) break;
      settleToken();
      openSocket(data.token);
      break;
    case "token-failed":
      if (!tokenPending) break;
      settleToken();
      scheduleReconnect();
      break;
    case "wake":
      wake();
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
  await loadEngine();
  if (!stopped) requestToken();
}

async function loadEngine() {
  loaded = false;
  status("loading");
  const t0 = performance.now();
  // The catalog's context window (`CONTEXT_WINDOWS` in apps/api/src/core/models.ts, sent by the page) sizes the KV cache
  // at load (wiki-llm/architecture.md).
  const contextWindow = Number.isInteger(cfg.contextWindow) && cfg.contextWindow > 0 ? cfg.contextWindow : 4096;
  engine = await createEngine({
    ref: cfg.model,
    contextWindow,
    // The shader patch's identical-output check has only run on Apple GPUs; every other vendor gets the stock shader.
    stockShaders: cfg.gpu?.vendor !== "apple",
    onProgress: (progress, text) => post({ type: "progress", progress, text }),
  });
  loadedWindow = engine.contextWindow;
  loadMs = Math.round(performance.now() - t0);
  loaded = true;
  void removeLegacyCaches();
}

// WebLLM stored its model files in Cache Storage under `webllm/...`. They are dead weight now (several GB): best effort,
// never blocks `ready`.
async function removeLegacyCaches() {
  try {
    for (const name of await caches.keys()) if (name.startsWith("webllm/")) await caches.delete(name);
  } catch {
    // Cache Storage unavailable
  }
}

// The token is single use and lives 60 s, so it is fetched right before connecting, never before the model loads.
function settleToken() {
  tokenPending = false;
  clearTimeout(tokenTimer);
}

function requestToken() {
  if (stopped || recovering || tokenPending) return;
  tokenPending = true;
  clearTimeout(tokenTimer);
  tokenTimer = setTimeout(() => {
    if (!tokenPending) return;
    tokenPending = false;
    scheduleReconnect();
  }, TOKEN_WAIT_MS);
  status(attempt === 0 ? "connecting" : "reconnecting");
  post({ type: "need-token" });
}

function openSocket(token) {
  if (stopped) return;
  const base = cfg.apiUrl.replace(/^http/, "ws").replace(/\/$/, "");
  ws = new WebSocket(`${base}/v1/worker`);
  const socket = ws;
  lastHeard = performance.now();
  pongSeen = false;
  socket.onopen = () => send({ type: "auth", token, protocol: 1, deviceKey: cfg.deviceKey });
  socket.onmessage = (event) => {
    lastHeard = performance.now();
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (frame.type === "pong") pongSeen = true;
    onFrame(frame).catch((e) => fail(e));
  };
  socket.onclose = (event) => socketGone(socket, event.code);
}

// The socket is over (closed by either side, or declared dead): stop its timers and reconnect unless that is pointless.
function socketGone(socket, code) {
  if (socket !== ws) return;
  clearInterval(heartbeat);
  clearTimeout(stableTimer);
  clearTimeout(wakeTimer);
  // Nobody is waiting for this job's output any more.
  interrupt();
  if (stopped) return;
  if (FATAL_CLOSE[code]) {
    stopped = true;
    post({ type: "fatal", message: FATAL_CLOSE[code] });
    return;
  }
  scheduleReconnect();
}

// A socket the browser still calls open but the api no longer answers: replace it now, without waiting for a close
// event that may never come, and retry at once (the machine just woke up; there is nothing to back off from).
function declareDead(socket) {
  if (socket !== ws) return;
  socket.onclose = null;
  socket.onmessage = null;
  try {
    socket.close();
  } catch {
    // already closed
  }
  attempt = 0;
  socketGone(socket, 0);
}

// The page saw the tab become visible again, the network return, or the page resume: check the connection now instead
// of waiting for the next heartbeat tick (timers run late or not at all while the machine is idle or asleep).
function wake() {
  if (stopped || recovering || !cfg || tokenPending) return;
  const socket = ws;
  // A socket still connecting may be hanging on a network that just came back: replace it too.
  if (socket && socket.readyState === WebSocket.CONNECTING) return declareDead(socket);
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    // Between connections: skip the rest of the backoff.
    if (loaded) {
      clearTimeout(reconnectTimer);
      attempt = 0;
      requestToken();
    }
    return;
  }
  // Without `pong` (older api) silence proves nothing; the api's own 15 s sweep still drops a dead worker.
  if (!pongSeen) return;
  if (performance.now() - lastHeard > DEAD_MS) return declareDead(socket);
  const asked = performance.now();
  send({ type: "heartbeat" });
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    if (lastHeard < asked && pongSeen) declareDead(socket);
  }, WAKE_CHECK_MS);
}
self.addEventListener("online", wake);

function beat(socket) {
  if (socket !== ws) return;
  if (pongSeen && performance.now() - lastHeard > DEAD_MS) return declareDead(socket);
  send({ type: "heartbeat" });
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
      lastHeard = performance.now();
      const socket = ws;
      heartbeat = setInterval(() => beat(socket), HEARTBEAT_MS);
      status("ready");
      break;
    case "job":
      if (current) send({ type: "error", id: String(frame.id), code: "busy", message: "a job is already running" });
      else currentDone = runJob(frame);
      break;
    case "cancel":
      if (current && current.id === frame.id) interrupt();
      break;
    case "stats":
      post({ type: "stats", stats: frame });
      break;
  }
}

// Stops the running generation; a job that ends because of this is not an engine failure.
function interrupt() {
  if (!current) return;
  current.interrupted = true;
  current.controller.abort();
  // Without this a job that never settles keeps `current` set and every reconnect waits on it forever.
  const job = current;
  job.watchdog ??= setTimeout(() => {
    if (current === job) void recover();
  }, ABORT_WATCHDOG_MS);
}

// Resolves when `promise` does, or after `ms`, whichever is first (never rejects).
function within(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(
      () => (clearTimeout(timer), resolve()),
      () => (clearTimeout(timer), resolve()),
    );
  });
}

async function runJob({ id, messages, params }) {
  const job = (current = { id, interrupted: false, controller: new AbortController(), watchdog: null });
  status("busy");
  try {
    const result = await engine.complete({
      messages,
      params,
      signal: job.controller.signal,
      onDelta: (delta) => current === job && send({ type: "chunk", id, delta }),
    });
    // recover() gave up on this job while it hung: its socket and engine are gone, so it has nothing to report.
    if (current !== job) return;
    // Only a job that really finished proves the engine works; a failed one never resets the count.
    if (!job.interrupted) engineFailures = 0;
    send({ type: "done", id, finishReason: result.finishReason, usage: result.usage });
  } catch (e) {
    if (current !== job) return;
    const text = String(e?.message ?? e);
    if (!job.interrupted && !PROMPT_ERROR.test(text)) engineFailures++;
    send({ type: "error", id, code: "engine_error", message: text.slice(0, 200) });
  } finally {
    clearTimeout(job.watchdog);
    if (current === job) {
      current = null;
      if (engineFailures >= MAX_ENGINE_FAILURES) void recover();
      else if (ws && ws.readyState === WebSocket.OPEN) status("ready");
    }
  }
}

// Repeated engine exceptions usually mean the WebGPU device was lost (driver reset, power event): leave the network,
// rebuild the engine, then come back, instead of staying online and failing every job.
async function recover() {
  if (recovering || stopped) return;
  recovering = true;
  engineFailures = 0;
  clearInterval(heartbeat);
  clearTimeout(reconnectTimer);
  clearTimeout(wakeTimer);
  clearTimeout(stableTimer);
  settleToken();
  const old = ws;
  ws = null;
  old?.close(1000);
  // A job stuck in the old engine is abandoned (its late result is dropped, see runJob).
  if (current) clearTimeout(current.watchdog);
  current = null;
  currentDone = Promise.resolve();
  try {
    // unload() ends wllama's worker for good: a new engine is built, this one is never reused. On a hung engine it may
    // not return either, so it is not waited on forever.
    await within(engine?.unload() ?? Promise.resolve(), INTERRUPT_WAIT_MS);
    engine = null;
    if (!stopped) await loadEngine();
  } catch (e) {
    recovering = false;
    return fail(e);
  }
  recovering = false;
  attempt = 0;
  requestToken();
}

async function stop() {
  stopped = true;
  clearInterval(heartbeat);
  clearTimeout(wakeTimer);
  clearTimeout(tokenTimer);
  clearTimeout(reconnectTimer);
  clearTimeout(stableTimer);
  if (ws) ws.close(1000);
  interrupt();
  await within(currentDone, INTERRUPT_WAIT_MS);
  if (engine) await within(engine.unload(), INTERRUPT_WAIT_MS);
  engine = null;
  status("stopped");
}
