import * as webllm from "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.89/+esm";

let visibility = 'visible', engine, ws, chain = Promise.resolve();
const fail = (e) => postMessage({ type: 'error', message: String(e?.message ?? e) });

onmessage = ({ data }) => {
  if (data.type === 'visibility') visibility = data.state;
  else if (data.type === 'start') start(data).catch(fail);
};

async function start({ model, wsUrl, gpu }) {
  const cached = await webllm.hasModelInCache(model);
  const t0 = performance.now();
  engine = await webllm.CreateMLCEngine(model, {
    initProgressCallback: (r) => postMessage({ type: 'progress', progress: r.progress, text: r.text }),
  });
  const loadMs = Math.round(performance.now() - t0);
  ws = new WebSocket(wsUrl);
  let timer;
  ws.onopen = () => {
    send({ type: 'hello', gpu, model, cached, loadMs, ua: navigator.userAgent });
    timer = setInterval(() => send({ type: 'heartbeat', t: Date.now(), visibility }), 5000);
    postMessage({ type: 'status', state: 'connected' });
  };
  ws.onclose = () => { clearInterval(timer); postMessage({ type: 'status', state: 'disconnected' }); };
  ws.onerror = () => fail('WebSocket error');
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'job') chain = chain.then(() => runJob(m));
  };
}

function send(o) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); }

async function runJob({ id, messages, params }) {
  let finish = null, usage = null, ttftMs = null, t0;
  try {
    await engine.resetChat();
    t0 = performance.now();
    const stream = await engine.chat.completions.create({
      messages, stream: true, stream_options: { include_usage: true }, ...params,
    });
    for await (const c of stream) {
      const ch = c.choices[0];
      if (ch?.delta?.content) {
        ttftMs ??= performance.now() - t0;
        send({ type: 'chunk', id, delta: ch.delta.content });
      }
      if (ch?.finish_reason) finish = ch.finish_reason;
      if (c.usage) usage = c.usage;
    }
    send({ type: 'done', id, finish_reason: finish, usage, timing: { ttftMs, totalMs: performance.now() - t0 } });
    postMessage({ type: 'job', id, finish_reason: finish });
  } catch (e) {
    send({ type: 'error', id, message: String(e?.message ?? e) });
    postMessage({ type: 'job', id, finish_reason: 'error' });
  }
}
