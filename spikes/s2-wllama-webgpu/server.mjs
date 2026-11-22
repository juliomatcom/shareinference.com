import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_ROOT = path.join(dir, 'node_modules', '@wllama', 'wllama', 'esm');
const PORT = Number(process.env.PORT) || 8788;
const HTML = ['index.html', 'text/html; charset=utf-8'];
const FILES = { '/': HTML, '/index.html': HTML, '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.html': 'text/html; charset=utf-8',
};
// Cross-origin isolation (threads, SharedArrayBuffer) needs COOP + COEP.
const HEADERS = {
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

function send(res, status, type, body) {
  res.writeHead(status, { ...HEADERS, 'content-type': type }).end(body);
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return send(res, 400, 'text/plain', 'bad request'); }

  let file = null, type = null;
  if (FILES[pathname]) {
    file = path.join(dir, FILES[pathname][0]); type = FILES[pathname][1];
  } else if (pathname.startsWith('/vendor/wllama/')) {
    const target = path.resolve(VENDOR_ROOT, pathname.slice('/vendor/wllama/'.length));
    if (target.includes('\0') || !target.startsWith(VENDOR_ROOT + path.sep)) return send(res, 403, 'text/plain', 'forbidden');
    type = MIME[path.extname(target)];
    if (!type) return send(res, 404, 'text/plain', 'not found');
    file = target;
  }
  if (!file) return send(res, 404, 'text/plain', 'not found');
  try { send(res, 200, type, await readFile(file)); }
  catch { send(res, 404, 'text/plain', 'not found'); }
});

server.listen(PORT, '127.0.0.1', () => console.log(`listening on http://127.0.0.1:${PORT}`));
