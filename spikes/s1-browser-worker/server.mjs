import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const HTML = ['index.html', 'text/html; charset=utf-8'];
const FILES = { '/': HTML, '/index.html': HTML, '/worker.js': ['worker.js', 'text/javascript; charset=utf-8'] };

const server = http.createServer(async (req, res) => {
  const f = FILES[new URL(req.url, 'http://localhost').pathname];
  if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
  try {
    res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store' }).end(await readFile(path.join(dir, f[0])));
  } catch { res.writeHead(500).end('read error'); }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });
let active = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

wss.on('connection', (ws) => {
  if (active) { ws.close(1013, 'busy'); return; }
  const s = active = { ws, seq: 0, pending: null, closed: false, vis: 'visible', lastBeat: 0, file: null, results: null };
  console.log('[ws] worker connected');
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    onMessage(s, m);
  });
  ws.on('close', () => {
    s.closed = true;
    if (active === s) active = null;
    s.pending?.finish({ error: 'disconnected' });
    console.log('[ws] worker disconnected');
  });
});

function save(s) { if (s.file) writeFileSync(s.file, JSON.stringify(s.results, null, 2)); }

function onMessage(s, m) {
  const p = s.pending;
  if (m.type === 'hello') {
    if (s.results) return;
    mkdirSync(path.join(dir, 'results'), { recursive: true });
    const startedAt = new Date().toISOString();
    s.file = path.join(dir, 'results', startedAt.replace(/:/g, '-') + '.json');
    s.results = { startedAt, hello: m, jobs: [], determinismIdentical: null,
      heartbeat: { count: 0, maxGapMs: { visible: 0, hidden: 0 }, warnings: [] }, soak: [] };
    s.vis = 'visible';
    console.log('[hello]', JSON.stringify(m), '\n[results]', s.file);
    save(s);
    suite(s).catch((e) => console.log('[suite stopped]', e.message));
  } else if (m.type === 'heartbeat' && s.results) {
    const hb = s.results.heartbeat, now = Date.now(), prev = s.vis;
    s.vis = m.visibility;
    hb.count++;
    if (s.lastBeat) {
      const gap = now - s.lastBeat;
      hb.maxGapMs[m.visibility] = Math.max(hb.maxGapMs[m.visibility] ?? 0, gap);
      if (gap > 7500) {
        const w = { at: new Date(now).toISOString(), gapMs: gap, lastVisibility: prev, visibility: m.visibility };
        hb.warnings.push(w);
        console.log(`\nWARN heartbeat gap ${gap} ms (last visibility ${prev}, now ${m.visibility})`);
      }
    }
    s.lastBeat = now;
    save(s);
  } else if (m.type === 'chunk' && p?.id === m.id) {
    p.rec.text += m.delta;
    process.stdout.write(m.delta);
  } else if ((m.type === 'done' || m.type === 'error') && p && (m.id === p.id || m.id === undefined)) {
    p.finish(m);
  } else if (m.type === 'error') {
    console.log('[worker error]', m.message);
  }
}

function runJob(s, name, messages, params, list = s.results.jobs) {
  return new Promise((resolve, reject) => {
    if (s.closed) return reject(new Error('worker disconnected'));
    const id = ++s.seq;
    const rec = { name, params, text: '', finish_reason: null, usage: null, timing: null, visibility: s.vis };
    list.push(rec);
    const t0 = Date.now();
    const timer = setTimeout(() => finish({ error: 'timeout after 180 s' }), 180000);
    function finish(m) {
      clearTimeout(timer);
      if (s.pending?.id === id) s.pending = null;
      if (m.error || m.type === 'error') {
        rec.error = m.error ?? m.message;
        console.log(`\n[${name}] ERROR ${rec.error}`);
      } else {
        rec.finish_reason = m.finish_reason; rec.usage = m.usage; rec.timing = m.timing;
        const u = m.usage ?? {}, x = u.extra ?? {};
        console.log(`\n[${name}] finish=${m.finish_reason} prompt_tokens=${u.prompt_tokens} completion_tokens=${u.completion_tokens}` +
          ` prefill_tps=${x.prefill_tokens_per_s} decode_tps=${x.decode_tokens_per_s} ttft_s=${x.time_to_first_token_s}`);
      }
      rec.latencyMs = Date.now() - t0;
      rec.visibility = s.vis;
      save(s);
      m.error === 'disconnected' ? reject(new Error('worker disconnected')) : resolve(rec);
    }
    s.pending = { id, rec, finish };
    s.ws.send(JSON.stringify({ type: 'job', id, messages, params }));
  });
}

const NOTHINK = { enable_thinking: false };
const LIGHTHOUSE = 'A lighthouse is a tall tower with a powerful light at the top, built near dangerous coastlines, harbors, and reefs to guide ships safely through the night and in bad weather. Early lighthouses burned wood or coal, later ones used oil lamps with mirrors, and modern ones use electric lamps behind specially shaped glass lenses that concentrate the beam. Keepers once lived inside, trimming wicks, polishing lenses, and winding clockwork, while today most stations are automated and monitored remotely. Each lighthouse has a distinctive pattern of flashes so sailors can identify it on a chart. Many old towers are now museums, and visitors climb the spiral stairs for views across the sea.';

async function suite(s) {
  const U = (content) => ({ role: 'user', content });
  const run = (name, messages, params) => runJob(s, name, messages, params);
  await run('warmup', [U('Reply with exactly: OK')], { temperature: 0, max_tokens: 16, extra_body: NOTHINK });
  await run('thinking-on', [U('What is 17*23? Answer briefly.')], { temperature: 0, max_tokens: 1024 });
  await run('thinking-off', [U('What is 17*23? Answer briefly.')], { temperature: 0, max_tokens: 256, extra_body: NOTHINK });
  const texts = [];
  for (let i = 1; i <= 3; i++) {
    texts.push((await run('determinism', [U('List the first 10 prime numbers, comma separated.')], { temperature: 0, max_tokens: 64, extra_body: NOTHINK })).text);
  }
  s.results.determinismIdentical = texts.every((t) => t === texts[0]);
  console.log('[determinism] identical =', s.results.determinismIdentical);
  await run('long-prompt', [U('Summarize the following text in 3 sentences:\n\n' + Array(18).fill(LIGHTHOUSE).join('\n\n'))],
    { temperature: 0, max_tokens: 128, extra_body: NOTHINK });
  const first = U('My name is Ana. Remember it.');
  const f1 = await run('resume-1', [first], { temperature: 0, max_tokens: 64, extra_body: NOTHINK });
  const f2 = await run('resume-2', [first, { role: 'assistant', content: f1.text }, U('What is my name?')], { temperature: 0, max_tokens: 64, extra_body: NOTHINK });
  console.log(`[resume] prompt_tokens f1=${f1.usage?.prompt_tokens} f2=${f2.usage?.prompt_tokens}`);
  console.log('\n[soak] suite finished; warmup job every 60 s until Ctrl+C. Switch tabs/apps now.');
  while (!s.closed) {
    await sleep(60000);
    if (s.closed) break;
    const rec = await runJob(s, 'soak', [U('Reply with exactly: OK')], { temperature: 0, max_tokens: 16, extra_body: NOTHINK }, []);
    s.results.soak.push({ t: new Date().toISOString(), latencyMs: rec.latencyMs, visibility: s.vis });
    save(s);
  }
}

server.listen(PORT, '127.0.0.1', () => console.log(`listening on http://127.0.0.1:${PORT}`));
