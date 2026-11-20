# api

## Auth

- **GitHub OAuth only.** `GET /auth/github` → GitHub (with random `state` in a short-lived cookie) → `GET /auth/github/callback` checks `state`, exchanges the code, reads `/user` (`id`, `login`, `created_at`, `avatar_url`), upserts the user, creates a session, redirects to `WEB_ORIGIN/dashboard`. The GitHub OAuth app callback URL is `WEB_ORIGIN/api/auth/github/callback` (reached through the web rewrite).
- **Session:** random 32-byte token in cookie `si_session` (`HttpOnly`, `SameSite=Lax`, `Secure` when `WEB_ORIGIN` is https, 30 days). Stored as SHA-256 in `sessions`.
- **API keys:** `si_` + 32 random bytes (base64url). Shown once; stored as SHA-256 plus a display prefix. `Authorization: Bearer <key>`.
- **Worker token:** `POST /worker-token` (session) returns a random token valid 60 s, single use, stored in memory. The provider sends it in the WebSocket's first message ([worker-protocol.md](worker-protocol.md)).
- Suspended users (`users.suspended_at`) get `403` everywhere.

## Routes

Public allowlist (everything else is 401 without credentials):

| Route                                           | Purpose                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /healthz`                                  | Liveness (compose healthcheck)                                                       |
| `GET /auth/github`, `GET /auth/github/callback` | Sign-in                                                                              |
| `GET /public/stats`                             | Total tokens served, active workers, models online                                   |
| `GET /public/models`                            | Catalog with online workers and queue depth per model                                |
| `GET /public/leaderboard`                       | Top providers: public name, GPU, device label, tokens, credits earned, tok/s, online |

Session (cookie): `POST /auth/logout`, `GET /me` (profile + balance), `PATCH /me` (`displayName`, `deviceLabel`), `GET /keys`, `POST /keys` (`name`), `DELETE /keys/:id`, `GET /ledger`, `GET /jobs` (own consumer history; `servedBy` and own vote only for finished jobs), `PUT /jobs/:id/vote` (`value`: 1 | -1), `POST /worker-token`, `GET /worker/stats` (own provider totals).

API key (Bearer): `GET /v1/models` (enabled models with ≥ 1 ready worker), `POST /v1/chat/completions`.

WebSocket: `GET /v1/worker` (upgrade; token auth in first message).

## `/v1/chat/completions`

- Accepted fields: `model`, `messages` (roles system/user/assistant, string content), `stream`, `stream_options.include_usage`, `temperature`, `top_p`, `max_tokens`, `stop`, `presence_penalty`, `frequency_penalty`, `seed`, `enable_thinking` (extension; also read from `chat_template_kwargs.enable_thinking`). Others → 400.
- `max_tokens` default 1024, max 2048. Body max 256 KiB.
- Stream: SSE `data: {chat.completion.chunk}` lines, final usage chunk when requested, then `data: [DONE]`. Non-stream: one `chat.completion` object with `usage`.
- Errors use the OpenAI shape `{ "error": { "message", "type", "code" } }`: 400 `invalid_request`, 401 `unauthorized`, 403 `forbidden` / `account_too_new`, 404 `model_not_found`, 429 `rate_limited`, 502 `provider_failed`, 503 `network_busy` / `no_providers`.

## Limits

- Rate limits per user: fair lane 10 req/min, 500/day, 1 concurrent; priority lane 60 req/min, 4 concurrent. Admins can override per user ([setup.md](setup.md) CLI).
- Auth routes: 20 req/min per IP. Public routes: cached 5 s.
