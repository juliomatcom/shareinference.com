# S1: WebLLM in a browser worker (throwaway spike)

Tests:
- WebLLM engine runs inside a dedicated module Web Worker, with the WebSocket opened from that same worker (jobs in, tokens out to the Node server).
- Cold vs warm load: after the first load, reload the page and press Start again (`cached` and `loadMs` in the results).
- Tokens/sec (prefill, decode, time to first token).
- Thinking on vs off.
- Determinism at temperature 0 (3 identical runs).
- Full-history billing on resume (`prompt_tokens` of resume-2 includes the whole conversation).
- Background-tab behaviour: after the suite finishes, switch to another tab/app for ~10 minutes and watch the server log for `WARN heartbeat gap` lines.

Run (Node >= 22):

    cd spikes/s1-browser-worker && npm install && npm start

Open http://localhost:8787 in Chrome (must be localhost or HTTPS; WebGPU needs a secure context) and press Start.
The first load downloads ~2.4 GB.

Results are written to `results/*.json` (rewritten after every job/heartbeat, so Ctrl+C is safe).
Paste that file back when done.
