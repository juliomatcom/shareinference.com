# web

Next.js (App Router) + Tailwind 4. No backend: `next.config` rewrites `/api/:path*` to `API_INTERNAL_URL` (the api on the compose network), so the session cookie is first-party. Design reference: `specs/design/landing.png` (dark theme, green accent).

## Pages

| Path            | Access  | Content                                                                                             |
| --------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `/`             | public  | Hero "N tokens served" + active GPUs, earn/spend cards, top providers table (from `/public/*`)      |
| `/how-it-works` | public  | Static explanation, privacy disclosure                                                              |
| `/models`       | public  | Catalog, online workers, queue depth                                                                |
| `/leaderboard`  | public  | Top providers                                                                                       |
| `/docs`         | public  | Renders `docs/` pages                                                                               |
| `/dashboard`    | session | Balance, ledger, API keys (create shows the key once), request history with served-by and own votes |
| `/share`        | session | Provider mode (below)                                                                               |
| `/settings`     | session | Display name, device label                                                                          |

Gated pages redirect to `/api/auth/github` when `/api/me` returns 401.

## Share page

- Checks WebGPU (`navigator.gpu`, adapter, `shader-f16`, limits); shows a clear message when unsupported.
- Runs WebLLM in a module Web Worker; the worker owns the engine and the WebSocket to `NEXT_PUBLIC_API_URL` (`/v1/worker`), per [worker-protocol.md](worker-protocol.md).
- Shows load progress, status (loading / ready / busy / disconnected), live usage from `stats` (jobs, tokens, tokens/sec, credits earned). Never shows consumer identity or content.
- Requests a screen Wake Lock while visible; reconnects with backoff after disconnects.
