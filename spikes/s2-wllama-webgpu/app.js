import { Wllama, WllamaAbortError, getHFModelSource } from './vendor/wllama/index.js';

const $ = (id) => document.getElementById(id);
const now = () => performance.now();
const round = (n, d = 1) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const errText = (e) => (e && (e.stack && String(e.stack).includes(String(e.message)) ? e.stack : `${e?.name ?? 'Error'}: ${e?.message ?? e}`)) || String(e);

// ---- log (kept small; native lines are filtered, they are the GPU evidence) ----
const LOG_MAX = 400, LINE_MAX = 500;
const NATIVE_KEEP = /webgpu|offload|buffer|layers|memory|gpu|fused|flash|graph (splits|nodes)|sched_/i;
const logLines = [];
let logTimer = null;
function pushLog(tag, args) {
  const msg = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? errText(a) : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
  logLines.push(`${new Date().toISOString().slice(11, 23)} ${tag} ${msg.slice(0, LINE_MAX)}`);
  if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  logTimer ??= setTimeout(() => { logTimer = null; $('log').textContent = logLines.join('\n'); $('log').scrollTop = 1e9; }, 100);
}
const log = (...a) => pushLog('app', a);
const logger = {
  debug: (...a) => { if (NATIVE_KEEP.test(a.join(' '))) pushLog('dbg', a); },
  log: (...a) => { if (NATIVE_KEEP.test(a.join(' '))) pushLog('log', a); },
  warn: (...a) => pushLog('WARN', a),
  error: (...a) => pushLog('ERROR', a),
};
window.addEventListener('unhandledrejection', (e) => log('unhandledrejection', e.reason));
window.addEventListener('error', (e) => log('window error', e.message));

// ---- state ----
const results = { env: {}, model: {}, load: {}, run: {}, stop: {}, d27: {} };
let wllama = null, loaded = false, busy = null, op = null, active = null;

// ---- results table ----
const SECTIONS = [['Environment', 'env'], ['Model', 'model'], ['Load', 'load'], ['Run', 'run'], ['Stop', 'stop'], ['D27', 'd27']];
function fmt(v) {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'number') return String(round(v, 2));
  if (typeof v === 'object') { try { return JSON.stringify(v, (k, x) => (typeof x === 'number' ? round(x, 2) : x)); } catch { return String(v); } }
  return String(v);
}
function render() {
  const t = $('results');
  t.textContent = '';
  const addRow = (k, v, cls) => {
    const tr = t.insertRow();
    const th = document.createElement('th'); th.textContent = k; tr.appendChild(th);
    const td = tr.insertCell(); td.textContent = v; if (cls) td.className = cls;
  };
  for (const [title, key] of SECTIONS) {
    const tr = t.insertRow(); const th = document.createElement('th');
    th.colSpan = 2; th.style.color = '#ddd'; th.textContent = title; tr.appendChild(th);
    const o = results[key];
    const keys = Object.keys(o);
    if (!keys.length) { addRow('-', 'not run yet'); continue; }
    for (const k of keys) {
      if (k === 'runs') continue; // full run records stay in the JSON, not the table
      const v = k === 'text' && typeof o[k] === 'string' ? `${o[k].length} chars (see output box)` : o[k];
      let cls = '';
      if (k === 'verdict') cls = String(v).startsWith('PASS') ? 'ok' : String(v).startsWith('FAIL') ? 'bad' : 'warn';
      if (k === 'error' && v) cls = 'bad';
      if (k === 'promptly') cls = v ? 'ok' : 'bad';
      addRow(k, fmt(v), cls);
    }
  }
}
function ui() {
  const gen = busy === 'generate' || busy === 'd27';
  $('load').disabled = !!busy;
  $('unload').disabled = !loaded || !!busy;
  $('gen').disabled = !loaded || !!busy;
  $('d27').disabled = !loaded || !!busy;
  $('stop').disabled = !(gen && active && active.stopT0 === null);
  $('status').textContent = busy ?? (loaded ? 'loaded' : 'idle');
  render();
}

// ---- environment ----
async function collectEnv() {
  const e = results.env;
  e.userAgent = navigator.userAgent;
  e.crossOriginIsolated = self.crossOriginIsolated;
  e.jspi = !!WebAssembly.Suspending;
  try { new WebAssembly.Memory({ address: 'i64', initial: 1n }); e.memory64 = true; } catch { e.memory64 = false; }
  e.hardwareConcurrency = navigator.hardwareConcurrency;
  try { e.libllamaVersion = Wllama.getLibllamaVersion(); } catch (x) { e.libllamaVersion = 'error: ' + x.message; }
  e.webgpu = !!navigator.gpu;
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) e.adapter = 'none returned';
      else {
        const i = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {};
        Object.assign(e, { adapterVendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description,
          maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          shaderF16: adapter.features.has('shader-f16') });
      }
    } catch (x) { e.adapter = 'error: ' + x.message; }
  }
  ui();
}

// ---- inputs ----
const numOr = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
function readInputs(o = {}) {
  return {
    prompt: o.prompt ?? $('prompt').value,
    maxTokens: numOr(o.maxTokens ?? $('maxtok').value, 256),
    temperature: numOr(o.temperature ?? $('temp').value, 0),
    seed: numOr(o.seed ?? $('seed').value, 42),
    thinking: o.thinking ?? $('think-sel').value, // 'off' | 'on' | 'default'
  };
}

// ---- model source ----
async function resolveSource(input) {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) return { url: s };
  let m = s.match(/^([^/\s:]+\/[^/\s:]+)\/(.+\.gguf)$/i);
  if (m) return await getHFModelSource({ repo: m[1], file: m[2] });
  m = s.match(/^([^/\s:]+\/[^/\s:]+)(?::([^/\s]+))?$/);
  if (m) return await getHFModelSource(m[2] ? { repo: m[1], quant: m[2] } : { repo: m[1] });
  throw new Error('cannot parse model: ' + s);
}
const newWllama = () => new Wllama({ default: './vendor/wllama/wasm/wllama.wasm' }, { parallelDownloads: 3, logger });

// ---- exclusive operations ----
function exclusive(name, fn) {
  if (busy) return Promise.reject(new Error('busy: ' + busy));
  busy = name; ui();
  const p = (async () => { try { return await fn(); } finally { busy = null; op = null; active = null; ui(); } })();
  op = p;
  return p;
}

// ---- load ----
function load(opts = {}) {
  return exclusive('load', async () => {
    const L = results.load = {};
    results.model = {}; results.run = {}; results.stop = {}; results.d27 = {};
    $('out').textContent = ''; $('think').textContent = '';
    const input = opts.model ?? $('model').value;
    const nglRaw = opts.nGpuLayers !== undefined ? opts.nGpuLayers : $('ngl').value;
    const ngl = nglRaw === '' || nglRaw === null || nglRaw === undefined ? undefined : Number(nglRaw);
    const nCtx = numOr(opts.nCtx ?? $('nctx').value, 16384);
    let phase = 'resolve';
    const tick = setInterval(() => { if (phase === 'download-progress') return; $('progress').textContent = `${phase} ${Math.round(now() - tPhase)} ms`; }, 250);
    let tPhase = now();
    loaded = false;
    try {
      if (wllama) { await wllama.exit().catch(() => {}); wllama = null; }
      wllama = newWllama();
      L.input = input; L.requestedNGpuLayers = ngl ?? 'default (all)'; L.requestedNCtx = nCtx;

      // 1. resolve
      const source = await resolveSource(input);
      L.resolvedUrl = source.url;
      L.resolveMs = round(now() - tPhase);

      // 2. download (or cache hit)
      phase = 'download'; tPhase = now(); log('download start', source.url);
      const model = await wllama.modelManager.getModelOrDownload(source, {
        progressCallback: ({ loaded: l, total: t }) => {
          $('progress').textContent = `download ${t ? Math.round((l / t) * 100) : '?'}% ${(l / 1e9).toFixed(2)}/${(t / 1e9).toFixed(2)} GB ${Math.round(now() - tPhase)} ms`;
          phase = 'download-progress';
        },
      });
      L.downloadMs = round(now() - tPhase);
      L.shards = model.files.length;
      L.totalBytes = model.size;
      L.totalGB = round(model.size / 1e9, 2);
      log(`download done ${L.downloadMs} ms, ${L.shards} file(s), ${L.totalGB} GB`);

      // 3. init
      phase = 'init'; tPhase = now();
      const params = { n_ctx: nCtx, ...(ngl !== undefined ? { n_gpu_layers: ngl } : {}), n_parallel: 1, ctx_shift: false,
        cache_idle_slots: false, n_cache_reuse: 0, jinja: true, reasoning_format: 'none', ...(opts.loadParams ?? {}) };
      L.params = params;
      await wllama.loadModel(model, params);
      L.initMs = round(now() - tPhase);
      loaded = true;
      try {
        const info = wllama.getLoadedContextInfo(), meta = info.metadata ?? {};
        results.model = { n_ctx: info.n_ctx, n_ctx_train: info.n_ctx_train, n_layer: info.n_layer, n_batch: info.n_batch, n_ubatch: info.n_ubatch,
          architecture: meta['general.architecture'], name: meta['general.name'], file_type: meta['general.file_type'],
          multithread: wllama.isMultithread(), threads: wllama.getNumThreads() };
      } catch (e) { results.model = { error: errText(e) }; }

      // 4. warm-up, same shape as share-worker.js
      phase = 'warmup'; tPhase = now();
      await wllama.createChatCompletion({ messages: [{ role: 'user', content: 'Hi' }], max_tokens: 4, temperature: 0, cache_prompt: false });
      L.warmupMs = round(now() - tPhase);
      L.loadMs = round(L.initMs + L.warmupMs);
      phase = 'done';
      log(`loaded: init ${L.initMs} ms + warmup ${L.warmupMs} ms = loadMs ${L.loadMs}`);
    } catch (e) {
      L.phaseFailed = phase.startsWith('download') ? 'download' : phase;
      L.error = errText(e);
      log(`LOAD FAILED in ${L.phaseFailed}:`, e);
      loaded = false;
      if (wllama && L.phaseFailed !== 'resolve' && L.phaseFailed !== 'download') { await wllama.exit().catch(() => {}); wllama = null; }
    } finally {
      clearInterval(tick);
      $('progress').textContent = L.error ? 'failed (' + L.phaseFailed + ')' : `loaded, loadMs ${L.loadMs}`;
    }
    return L;
  });
}

function unload() {
  return exclusive('unload', async () => {
    if (wllama) { await wllama.exit().catch((e) => log('exit error', e)); wllama = null; }
    loaded = false;
    $('progress').textContent = 'unloaded';
    log('unloaded; next Load creates a new Wllama instance');
  });
}

// ---- generation ----
const newActive = () => ({ controller: new AbortController(), stopT0: null, stopPhase: null, firstTokenAt: null, settled: null });

async function runOnce(a, o = {}) {
  const inp = readInputs(o);
  const content = o.content ?? inp.prompt;
  const cachePrompt = !!o.cachePrompt;
  const req = {
    messages: [{ role: 'user', content }], stream: true, stream_options: { include_usage: true },
    max_tokens: o.tiny ? 4 : inp.maxTokens, temperature: o.tiny ? 0 : inp.temperature, seed: inp.seed,
    cache_prompt: cachePrompt, return_progress: true, abortSignal: a.controller.signal,
    ...(inp.thinking !== 'default' ? { chat_template_kwargs: { enable_thinking: inp.thinking === 'on' } } : {}),
  };
  const rec = { label: o.label ?? null, cachePrompt, thinkingSetting: inp.thinking, aborted: false, error: null };
  let text = '', reasoning = '', chunks = 0, contentDeltas = 0, reasoningDeltas = 0, ttft = null;
  let usage = null, timings = null, progress = null, finish = null, usageAfterAbort = false, deltasAfterAbort = 0;
  if (!o.quiet) { $('out').textContent = ''; $('think').textContent = ''; }
  const t0 = now();
  let tEnd;
  try {
    const stream = await wllama.createChatCompletion(req);
    for await (const chunk of stream) {
      chunks++;
      if (chunk.usage) { usage = chunk.usage; if (a.stopT0 !== null) usageAfterAbort = true; }
      if (chunk.timings) timings = chunk.timings;
      if (chunk.prompt_progress) progress = chunk.prompt_progress;
      const c = chunk.choices?.[0];
      if (c?.finish_reason) finish = c.finish_reason;
      const d = c?.delta ?? {};
      const gotAny = !!(d.content || d.reasoning_content);
      if (gotAny && a.stopT0 !== null) deltasAfterAbort++;
      if (d.content) {
        text += d.content; contentDeltas++;
        // The empty think block of a thinking-off template is not a generated token.
        if (ttft === null && !/^<think>\s*(<\/think>\s*)?$/.test(text)) { ttft = now() - t0; a.firstTokenAt ??= now(); }
        if (!o.quiet) $('out').append(document.createTextNode(d.content));
      }
      if (d.reasoning_content) {
        a.firstTokenAt ??= now();
        reasoning += d.reasoning_content; reasoningDeltas++;
        if (!o.quiet) $('think').append(document.createTextNode(d.reasoning_content));
      }
    }
  } catch (e) {
    if (e instanceof WllamaAbortError || e?.name === 'AbortError') rec.aborted = true;
    else { rec.error = errText(e); log('generate error:', e); }
  }
  tEnd = now();
  if (a.stopT0 !== null) {
    rec.stopInfo = {
      stopMs: round(tEnd - a.stopT0), phaseWhenStopped: a.stopPhase, deltasAfterAbort,
      usageAvailableAfterAbort: usageAfterAbort, abortErrorThrown: rec.aborted,
      promptly: tEnd - a.stopT0 <= 10000,
    };
  }
  const u = usage ?? {};
  Object.assign(rec, {
    ttftMs: round(ttft), firstTokenMs: a.firstTokenAt === null ? null : round(a.firstTokenAt - t0),
    prefillTps: round(timings?.prompt_per_second), decodeTps: round(timings?.predicted_per_second),
    promptTokens: u.prompt_tokens ?? null, completionTokens: u.completion_tokens ?? null,
    cache_n: timings?.cache_n ?? null, prompt_n: timings?.prompt_n ?? null, predicted_n: timings?.predicted_n ?? null,
    cachedTokensUsage: u.prompt_tokens_details?.cached_tokens ?? null,
    finishReason: finish, totalMs: round(tEnd - t0), chunks, contentDeltas, reasoningDeltas, reasoningChars: reasoning.length,
    rawThinkOpen: text.includes('<think>'), rawThinkClose: text.includes('</think>'),
    clientDecodeTps: a.firstTokenAt !== null && (u.completion_tokens ?? 0) > 1 ? round(((u.completion_tokens - 1) / (tEnd - a.firstTokenAt)) * 1000) : null,
    lastPromptProgress: progress, timings, usage, text,
  });
  return rec;
}

function runTracked(o) {
  const a = newActive(); active = a; ui();
  const p = runOnce(a, o);
  a.settled = p;
  return p;
}

function generate(o = {}) {
  return exclusive('generate', async () => {
    results.run = {}; results.stop = {};
    const rec = await runTracked({ ...o, label: 'generate' });
    results.run = rec;
    log(`generate: finish=${rec.finishReason} ttft=${rec.ttftMs} ms decode=${rec.decodeTps} tok/s prefill=${rec.prefillTps} tok/s cache_n=${rec.cache_n}`);
    if (rec.stopInfo) {
      const S = results.stop = { ...rec.stopInfo };
      active = null; ui();
      const tiny = await runOnce(newActive(), { tiny: true, quiet: true, content: 'Hi', thinking: o.thinking });
      S.usableAfterStop = !tiny.error && !tiny.aborted && ((tiny.completionTokens ?? 0) > 0 || tiny.text.length > 0);
      S.afterStopText = tiny.text.slice(0, 80);
      S.afterStopError = tiny.error;
      log(`stop: ${S.stopMs} ms in ${S.phaseWhenStopped}, promptly=${S.promptly}, usableAfterStop=${S.usableAfterStop}`);
    }
    return rec;
  });
}

function stop() {
  const a = active;
  if (!a || a.stopT0 !== null) return Promise.resolve(null);
  a.stopPhase = a.firstTokenAt === null ? 'prefill' : 'decode';
  a.stopT0 = now();
  a.controller.abort();
  ui();
  return op ?? Promise.resolve(null);
}

// ---- D27: cache_prompt:false must really bypass the prompt cache ----
function d27(o = {}) {
  return exclusive('d27', async () => {
    const D = results.d27 = { verdict: 'running' };
    const runs = {};
    for (const [label, cachePrompt] of [['A', false], ['B', false], ['C', true], ['D', true]]) {
      D.verdict = `running ${label}`; ui();
      const rec = await runTracked({ ...o, label, cachePrompt });
      runs[label] = rec;
      if (rec.aborted || rec.error) {
        D.verdict = rec.aborted ? 'ABORTED' : 'ERROR'; D.reason = rec.error ?? `stopped in ${label}`;
        D.runs = runs; return D;
      }
    }
    const { A, B, C, D: Dr } = runs;
    const short = (r) => `cache_n=${r.cache_n} prompt_n=${r.prompt_n} predicted_n=${r.predicted_n} promptTokens=${r.promptTokens} cachedTokensUsage=${r.cachedTokensUsage} totalMs=${r.totalMs}`;
    D.A_cache_false = short(A); D.B_cache_false = short(B); D.C_cache_true_control = short(C); D.D_cache_true = short(Dr);
    D.abTextIdentical = A.text === B.text;
    D.cdTextIdentical = C.text === Dr.text;
    D.allTextIdentical = A.text === B.text && B.text === C.text && C.text === Dr.text;
    const have = [A, B, Dr].every((r) => typeof r.cache_n === 'number' && typeof r.prompt_n === 'number');
    const abClean = A.cache_n === 0 && B.cache_n === 0 && A.prompt_n === B.prompt_n;
    const detectorSeesReuse = typeof Dr.cache_n === 'number' && Dr.cache_n > 0;
    if (!have) { D.verdict = 'INCONCLUSIVE'; D.reason = 'timings.cache_n / prompt_n missing from the stream'; }
    else if (!abClean) { D.verdict = 'FAIL'; D.reason = 'cache_prompt:false runs showed cache reuse or different prompt_n'; }
    else if (!detectorSeesReuse) { D.verdict = 'INCONCLUSIVE'; D.reason = 'A and B had cache_n 0, but control D (cache_prompt:true) also had cache_n 0, so the detector never saw reuse'; }
    else { D.verdict = 'PASS'; D.reason = 'A and B cache_n 0 with same prompt_n; control D cache_n > 0'; }
    D.runs = runs;
    log(`D27 ${D.verdict}: ${D.reason}`);
    return D;
  });
}

// ---- copy ----
function resultsJson() {
  const replacer = (k, v) => (k === 'text' && typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + `...[truncated, ${v.length} chars]` : v);
  return JSON.stringify({ at: new Date().toISOString(), ...results, log: logLines }, replacer, 2);
}
async function copyResults() {
  const json = resultsJson();
  try { await navigator.clipboard.writeText(json); log('results JSON copied'); }
  catch (e) { log('clipboard failed, JSON shown in output box:', e); $('out').textContent = json; }
}

// ---- wire up ----
$('load').onclick = () => load().catch((e) => log('load rejected:', e));
$('unload').onclick = () => unload().catch((e) => log('unload rejected:', e));
$('gen').onclick = () => generate().catch((e) => log('generate rejected:', e));
$('stop').onclick = () => { stop(); };
$('d27').onclick = () => d27().catch((e) => log('d27 rejected:', e));
$('copy').onclick = copyResults;

// load(opts): { model, nGpuLayers, nCtx }; generate/d27(opts): { prompt, maxTokens, temperature, seed, thinking: 'off'|'on'|'default', cachePrompt }
window.__spike = { load, generate, stop, d27, unload, results, resultsJson, wllama: () => wllama };

ui();
collectEnv().catch((e) => log('env failed:', e));
