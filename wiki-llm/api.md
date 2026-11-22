# api

## Auth

- **GitHub OAuth only.** `GET /auth/github` → GitHub (with random `state` in a short-lived cookie) → `GET /auth/github/callback` checks `state`, exchanges the code, reads `/user` (`id`, `login`, `created_at`, `avatar_url`), upserts the user, creates a session, redirects to `WEB_ORIGIN/dashboard`. The GitHub OAuth app callback URL is `WEB_ORIGIN/api/auth/github/callback` (reached through the web rewrite).
- **Callback failures** (state mismatch or missing cookie, GitHub refusing the code, suspended user, or any other error, e.g. a database failure, which is logged) redirect to `WEB_ORIGIN/?signin=failed`. The state cookie `si_oauth_state` (`HttpOnly`, `SameSite=Lax`, 10 min) is single use. The authorize request sends `scope=read:user` and `redirect_uri=WEB_ORIGIN/api/auth/github/callback`. A new user's display name is the GitHub login (`login-1` ... `login-5`, then `login-<random 6 hex>`, when taken, reserved, or equal to another account's GitHub login; logins shorter than 3 characters become `user-<login>`). Signing in again refreshes login and avatar. A GitHub login outranks a display name: when a signing-in account's login (new or changed) equals another user's display name, that other user's display name is reset in the same transaction to their own login (`login-<random 4 hex>` if taken) and the event is logged with ids only.
- **Session:** random 32-byte token in cookie `si_session` (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `WEB_ORIGIN` is https, 30 days). Stored as SHA-256 in `sessions`; expired rows are dropped when seen and at each new sign-in.
- **CSRF:** a non-GET request authenticated by cookie must send `Content-Type: application/json` and an `Origin` header equal to `WEB_ORIGIN`, else `403 permission_error` / `csrf`. Checked after authentication (an unauthenticated write is 401). Bearer requests are not cookie-authenticated and skip it.
- **API keys:** `si_` + 32 random bytes (base64url). Shown once; stored as SHA-256 plus a display prefix (`si_` + first 8 characters). `Authorization: Bearer <key>`; revoked keys never match; `last_used_at` is updated at most once a minute. At most 20 active keys per user (checked in a transaction that locks the user row). A Bearer key is not a session: session routes answer 401 to it, and the `/v1/*` routes answer 401 to a session cookie.
- **Worker token:** `POST /worker-token` (session, CSRF checked) returns `{ token, expiresInS: 60 }`: 32 random bytes, valid 60 s, single use, tied to the user, kept in memory as a hash. At most 10 000 pending tokens (oldest evicted) and 10 per user (that user's oldest evicted). The provider sends it in the WebSocket's first message ([worker-protocol.md](worker-protocol.md)); the Share page asks for a new one for every connection attempt.
- Suspended users (`users.suspended_at`) get `403 permission_error` / `suspended` everywhere and cannot sign in.

## Routes

Public allowlist (everything else is 401 without credentials):

| Route                                           | Purpose                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /healthz`                                  | Liveness (compose healthcheck)                                                       |
| `GET /robots.txt`                               | Disallow-all for crawlers (see Crawlers below)                                       |
| `GET /auth/github`, `GET /auth/github/callback` | Sign-in                                                                              |
| `GET /public/stats`                             | Total tokens served, active workers, models online, jobs served                      |
| `GET /public/models`                            | Catalog with online workers and queue depth per model                                |
| `GET /public/config`                            | `{ apiPublicUrl }`: where the web app finds the api and its WebSocket (D39)          |
| `GET /public/leaderboard`                       | Top providers: public name, GPU, device label, tokens, credits earned, tok/s, online |

Session (cookie): `POST /auth/logout`, `GET /me`, `PATCH /me`, `GET /keys`, `POST /keys`, `DELETE /keys/:id`, `GET /ledger`, `GET /jobs`, `PUT /jobs/:id/vote` (shapes below), `POST /worker-token`, `GET /worker/stats` (own provider totals), `POST /playground/chat/completions` (below).

API key (Bearer): `GET /v1/models` (enabled models with ≥ 1 ready worker), `POST /v1/chat/completions`.

WebSocket: `GET /v1/worker` (upgrade; token auth in first message).

## Provider routes

- `GET /public/config` -> `{ apiPublicUrl }` (the `API_PUBLIC_URL` value).
- `GET /public/models` -> `{ models: [{ id, ggufRef, contextWindow, priceMultiplier, workersOnline, queueDepth }] }`: enabled catalog rows; `priceMultiplier` is the credit multiplier ([economy.md](economy.md)), used by the Playground to show what a reply cost; `workersOnline` counts ready and busy workers of that model; `queueDepth` is the number of jobs waiting for a worker of that model.
- `POST /worker-token` -> `{ token, expiresInS }` (above).
- `GET /worker/stats` -> `{ totals: { jobsServed, promptTokens, completionTokens, creditsEarned }, workers: [{ id, status, model, connectedAt }] }`, the caller's own. `status` is `connected` (authenticated, not yet ready), `ready` (idle) or `busy`; `model` is the public id.

## Public aggregates

Read-only, no credentials, aggregate or opt-in fields only (D14); never a user id, GitHub login (unless it is the display name), balance or consumer data.

- `GET /public/stats` -> `{ tokensServed, activeWorkers, modelsOnline, jobsServed }`: `tokensServed` = sum of prompt + completion tokens of succeeded jobs, `jobsServed` = count of them; `activeWorkers` = live workers that are `ready` or `busy`; `modelsOnline` = enabled models with at least one such worker.
- `GET /public/leaderboard` -> `{ providers: [{ rank, name, gpu, deviceLabel, model, tokensServed, creditsEarned, tokensPerS, online }] }`: the top 100 users by tokens served as provider (succeeded jobs; suspended users left out), most first. `name` is the display name (D15). `gpu` is `"<vendor> <architecture>"` (cleaned strings, see [worker-protocol.md](worker-protocol.md)) from the user's most recently seen device that announced a GPU (null if none); `deviceLabel` is the optional label from Settings; `model` is the public id of that device's last model (null if unknown). `tokensServed` and `creditsEarned` sum the user's succeeded jobs as provider. `tokensPerS` is the mean `decode_tps` of their last 50 succeeded jobs, rounded to 1 decimal (null without any). A provider-reported decode speed is clamped to 500 tokens/s (`MAX_DECODE_TPS`, the one place this ceiling is stated) when stored at settlement and again in the average. `online` is true while the user has a `ready` or `busy` worker.
- Both answers are computed at most once per 5 s per process (in-memory cache in core with the injected clock; concurrent callers share one load; when a reload fails the last good value is served, with none the request fails; `stats` totals include suspended providers' history and are clamped, never thrown on) and sent with `Cache-Control: public, max-age=5`. Per-IP limits: see Limits.

## Account routes (session)

- `GET /me` -> `{ id, githubLogin, avatarUrl, displayName, deviceLabel, balance, createdAt }`.
- `PATCH /me` `{ displayName?, deviceLabel? }` (unknown keys rejected; `deviceLabel` empty or null clears it) -> the same profile. Errors are `400` with `code`: `invalid_display_name`, `display_name_taken` (another display name, case-insensitive; another user's GitHub login; or a reserved name: admin, administrator, root, system, support, help, security, api, shareinference, moderator, mod, staff, official, null, undefined), `invalid_device_label`, or `invalid_request` (empty or malformed body).
- `GET /keys` -> `{ keys: [{ id, name, prefix, createdAt, lastUsedAt, revokedAt }] }` (live keys first, then the 30 most recently revoked, each group newest first). `POST /keys` `{ name }` (1-60 characters, see Text rules) -> `201 { id, name, prefix, createdAt, key }`, the only time the plaintext key is returned; `400` `invalid_name` / `too_many_keys`. `DELETE /keys/:id` -> `204`; `404` when the key is not the caller's or already revoked.
- `GET /ledger?page=N` -> `{ page, pageSize, total, entries: [{ id, amount, kind, note, jobId, createdAt }] }`, the caller's own, newest first, 10 per page (`PAGE_SIZE`, `adapters/http/paging.ts`; `page` is 1-based, default 1; anything else is `400 invalid_request`).
- `GET /jobs?page=N` -> `{ page, pageSize, total, jobs: [{ id, model, status, source, promptTokens, completionTokens, credits, createdAt, finishedAt, servedBy, vote }] }`, the caller's own requests as consumer, newest first, 10 per page (same `page` rules as `/ledger`). `status` is queued / running / succeeded / failed / cancelled; `source` is `api` (a `/v1` request) or `playground`; token counts and `credits` are `null` until the job succeeds. `servedBy` (the provider's display name) and `vote` (the caller's own vote for that provider, 1 | -1 | null) are `null` unless the job succeeded (failed and cancelled jobs reveal no provider).
- `PUT /jobs/:id/vote` `{ value: 1 | -1 }` (unknown keys rejected) -> `{ ok: true, value }`. `404` unless the job is the caller's own, succeeded, and has a provider. One vote per (voter, provider): a later vote replaces the earlier one. `400` for a bad body.
- `POST /auth/logout` -> `{ ok: true }`, ends the session and clears the cookie.

Text rules (device label, key name, ledger notes): printable, with at least one letter or digit, no control or format characters (`\p{C}`), no line or paragraph separators, none of the blank-looking code points U+3164, U+2800, U+115F, U+1160, U+FFA0, and no run of more than 2 combining marks. A credit amount is an integer of at most 1 000 000 000 000 either way per entry.

## `/v1/chat/completions`

- `GET /v1/models` -> `{ object: "list", data: [{ id, object: "model", created, owned_by: "shareinference" }] }`: enabled models with at least one ready or busy worker.
- Accepted fields: `model`, `messages` (roles system/user/assistant, string content), `stream`, `stream_options.include_usage`, `temperature`, `top_p`, `max_tokens`, `stop`, `presence_penalty`, `frequency_penalty`, `seed`, `enable_thinking` (extension; also read from `chat_template_kwargs.enable_thinking`). Others → 400.
- Fields are validated strictly (unknown keys anywhere, including inside a message, are 400); a `null` value counts as unset. `temperature` 0-2, `top_p` 0-1, penalties -2..2, `seed` a 32-bit integer, `stop` a non-empty string or up to 4 non-empty strings of at most 64 characters, 1-256 messages. `max_tokens` default 4096, max 8192 (still bounded by the context window: prompt + `max_tokens` must fit). Body max 256 KiB. The prompt must fit the context window together with `max_tokens` (400, message mentions the context length): the prompt is estimated as ⌈ASCII characters / 4⌉ + one token per other code point, and `estimate + max_tokens ≤ contextWindow`. Without `max_tokens` the reply gets `min(4096, contextWindow - estimate)` (400 only when that is below 1). The request must also fit the window some online provider loaded (`ready.contextWindow`, see [worker-protocol.md](worker-protocol.md)), else `503 no_providers` at once. Only `messages` and these generation params reach the provider.
- Admission order: validate (400) → model (404 `model_not_found`) → size (400) → at least one worker online that is not the caller's own (else 503 `no_providers`; the message says so when only the caller's own GPU serves the model) → lane from the balance (> 0 priority, else fair) → fair lane needs a GitHub account of at least 30 days (403 `account_too_new`) → rate limits (429 `rate_limited`) → queue. Ids are `chatcmpl-<job id>`; `model` echoes the public id.
- Stream: SSE headers go out with the first provider chunk, so a failure before it (queue timeout, provider failure) is a normal JSON error with its status; the first delta has `role: "assistant"`. After the first chunk a failure ends the stream with one `data: {"error": {...}}` event and no `[DONE]`. A client that disconnects cancels the job (`cancel` to the worker, no credits).
- Stream: SSE `data: {chat.completion.chunk}` lines, a final chunk with `finish_reason`, a usage chunk (`choices: []`) when `stream_options.include_usage`, then `data: [DONE]`. Non-stream: one `chat.completion` object with `usage` (capped values, [economy.md](economy.md)). A leading `<think>` block is returned as `reasoning_content` (message, or stream delta) and left out of `content` ([architecture.md](architecture.md)).
- Errors use the OpenAI shape `{ "error": { "message", "type", "code" } }`; `type` follows the status (401 `authentication_error`, 403 `permission_error`, 404 `not_found_error`, 429 `rate_limit_error`, other 4xx `invalid_request_error`, 5xx `api_error`) and `code` is the short code below: 400 `invalid_request`, 401 `unauthorized`, 403 `forbidden` / `suspended` / `csrf` / `account_too_new`, 404 `model_not_found`, 429 `rate_limited`, 502 `provider_failed`, 503 `network_busy` / `no_providers`.

## `/playground/chat/completions`

- `POST /playground/chat/completions`: the signed-in browser's door to `/v1/chat/completions` (D44). Session only (a Bearer key is `401`), CSRF-checked like every cookie write (JSON content type and `Origin` = `WEB_ORIGIN`, else `403 csrf`). It is the same handler as `/v1/chat/completions`: same body schema, admission, rate limits, queue, failure rules, billing and response (SSE or JSON); the job row only differs by `source = playground`. Not public.
- Responses never carry provider, worker or device information (nothing but the OpenAI-shaped completion and its capped `usage`); a test asserts it for both routes.

## Limits

- Rate limits per user, in memory (reset on restart): fair lane 10 req/min, 500/day, 1 concurrent; priority lane 60 req/min, 4 concurrent. An admin override (`users.rate_limit_override`, [setup.md](setup.md) CLI) replaces the per-minute and per-day numbers of either lane. Only requests that pass admission count.
- Public routes: cached 5 s ([Public aggregates](#public-aggregates)).
- Per-IP limits (`core/ipLimiter.ts`, in memory, sliding 60 s window, bounded to 10 000 addresses): unauthenticated requests on public routes 600/min (`/healthz` is exempt; the site polls every 10 s per open tab and shared addresses add up); `/auth/*` 20/min; worker WebSocket upgrades 30/min (refused `429` at the upgrade, [worker-protocol.md](worker-protocol.md)); bad Bearer keys or session cookies 60/min: the credential is looked up first, a valid one proceeds and is never limited; an invalid one is counted, and past 60/min of them from one IP the answer becomes `429` instead of `401` (requests with no credentials do not count). HTTP `429` uses `rate_limited` with `Retry-After: 60`. Preflights are not counted.
- The caller's address is the socket address, or `X-Real-IP` when `TRUST_PROXY=true` (production: Caddy overwrites the header on every request; with the flag off a client-sent header is ignored). IPv4-mapped IPv6 counts as the IPv4 address and any other IPv6 address as its /64 prefix. Behind a shared address (campus, office) visitors share one allowance.

## CORS

Set by `adapters/http/cors.ts` before authentication, so preflights (no credentials) are answered `204` and never hit deny-by-default. Credentials are never allowed cross-origin: no response carries `Access-Control-Allow-Credentials`. The web app reaches session routes same-origin through its `/api` rewrite.

- **Open routes** (`/v1/*`, and `/public/*` and `/healthz` for GET, HEAD and OPTIONS only; Bearer or nothing, never cookies): `Access-Control-Allow-Origin: *`, `Expose-Headers: Retry-After`, `Cross-Origin-Resource-Policy: cross-origin`. Preflight: `Allow-Methods: GET, POST, OPTIONS`, `Allow-Headers`: `Authorization, Content-Type, Accept, OpenAI-Organization, OpenAI-Project` plus the headers the preflight asks for (the OpenAI SDKs send changing `x-stainless-*` ones; names are validated), `Max-Age: 600`. Browser apps can use the OpenAI SDK with `dangerouslyAllowBrowser` (the key is then visible to that page: use it only for your own keys).
- **Every other route** (session): only `WEB_ORIGIN` is allowed (`Allow-Origin` = the origin, `Vary: Origin`; preflight `Allow-Methods: GET, POST, PUT, PATCH, DELETE`, `Allow-Headers: Content-Type, Accept`, `Max-Age: 600`). Other origins get no CORS headers. CSRF rules are unchanged.
- The provider WebSocket is not CORS: its upgrade checks `Origin` = `WEB_ORIGIN` ([worker-protocol.md](worker-protocol.md)).

## Crawlers

The api is never to be indexed or scraped. Layers, from advisory to enforced (`adapters/http/botGuard.ts`, `ops/caddy/Caddyfile`):

- `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex` on every api response (errors and 404s included), also set by Caddy on the api host.
- `GET /robots.txt` returns `User-agent: *` / `Disallow: /`. It and `/healthz` are never refused.
- A request with no `Authorization` header and no cookie whose User-Agent names a crawler, AI trainer or scraper (`bot`, `crawl`, `spider`, `scrap`, `slurp`, `gpt`, `claude`, `anthropic`, `perplexity`, ...) gets `403 bots_not_allowed`, in the app and again at Caddy. Anything that sends credentials is a customer and is never refused for its User-Agent.
- This only stops bots that identify themselves. A bot that lies about its User-Agent is stopped like any anonymous caller: deny-by-default authentication and the per-IP limits above.
- The website side (signed-in pages and the `/api/*` proxy) is closed the same way: `noindex` headers and robots rules in `apps/web`, plus Caddy refusing bot User-Agents on those paths. Link-preview bots keep working on public pages.
