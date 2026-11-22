# Architecture

## Components

| Component  | What it is                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api` | Express 5 + `ws`, single process. Auth, OpenAI-compatible API, provider WebSocket, in-memory worker registry and queues, ledger settlement, CLI |
| `apps/web` | Next.js + Tailwind. Public pages, gated dashboard, provider Share page (wllama in a Web Worker). No backend: `/api/*` rewrites to the api       |
| Postgres   | Postgres 17. Users, sessions, keys, workers, jobs, ledger, balances, votes, models                                                              |

Compose services: `db` (profile `localdb`, volume `db-data`), `api` (container port 4000, published on `API_PORT`, default 4401), `web` (container port 3000, published on `WEB_PORT`, default 4400), both bound to `BIND_ADDR` (default `127.0.0.1`). Production adds `caddy` (TLS, two hosts: website -> `web`, `api.` host -> `api`) and publishes nothing but 80/443 ([setup.md](setup.md) "Production"). The api reads only `DATABASE_URL`, so `db` can be replaced by any Postgres 17 (e.g. GCP Cloud SQL) — see [setup.md](setup.md).

## Request lifecycle (consumer)

1. `POST /v1/chat/completions` with `Authorization: Bearer <api key>` → key hash lookup → user.
2. Validate body (zod), resolve public model id → catalog row, apply limits ([api.md](api.md)).
3. Admission: rate limits by lane; free lane (balance ≤ 0) requires GitHub account age ≥ 30 days ([economy.md](economy.md)). Admitted requests get a `jobs` row (`queued`).
4. Route: the dispatcher (`core/dispatcher.ts`, in memory) picks a **random** eligible worker — `ready`, idle, same model, owner ≠ consumer. None → enqueue. No worker of the model online at all, or only workers of the consumer itself (it is never routed to itself) → `503 no_providers` at once, with its own message when only the consumer's own GPU is online.
5. Dispatch `job` to the worker with only `messages` + whitelisted params. Mark worker busy.
6. Stream `chunk`s to the consumer (SSE) or buffer them (JSON). On `done`, apply the thinking split (below), settle credits in one transaction, send the provider its `stats`, mark worker idle, dispatch the next queued job.

## Queues and routing

- One queue per model with two lanes: **priority** (consumer balance > 0) is always served before **fair** (balance ≤ 0). Inside the fair lane, higher balance first, then arrival order.
- Routing is random and blind: consumers choose a model, never a provider. The provider's public name is revealed only in the consumer's history after the job ends.
- A worker never receives a job from its own owner.
- Limits: max 100 queued requests per model (the 101st → `503 network_busy` at once); max wait 300 s → `503 network_busy`. A job that fails before its first chunk is requeued at the front of its lane (before any other job of that lane); a job whose only idle worker belongs to its consumer is skipped in favour of the next job. `GET /public/models` reports the queue depth per model.

## Failure rules

- Worker disconnects, errors or times out **before the first chunk** → requeue once at the front of its lane, to a different worker than the one that failed; second failure → `502 provider_failed`. A `done` with no (or only whitespace) output counts as a worker failure. The 300 s queue wait is one budget per job across attempts: a retry has only what is left of it (nothing left → `provider_failed`).
- **After the first chunk** a provider failure ends the stream with an error event; no credits move (consumer not charged, provider not paid).
- Consumer disconnects → send `cancel` to the worker. Before the first chunk no credits move. After output was delivered the consumer is billed for it: the worker's `done { abort }` within the 30 s grace is settled with usage capped ([economy.md](economy.md)); without it nothing moves.
- Per-job timeout: first chunk after `max(90 s, 30 s + prompt tokens / MIN_PREFILL_TPS[model])`, capped at 80% of the job's total time (`firstChunkTimeoutMs` and `MIN_PREFILL_TPS` in `models.ts`; 90 s is `FIRST_CHUNK_TIMEOUT_MS`, the default when a job carries none); total 600 s for API requests and 300 s for the web Playground (`JOB_TIMEOUT_MS`, `PLAYGROUND_JOB_TIMEOUT_MS` in `dispatcher.ts`). The web proxy timeout must stay above the largest total.
- After a cancel or timeout the worker stays busy until it answers `done`/`error` for that job; silent for 30 s → its socket is dropped (4408), see [worker-protocol.md](worker-protocol.md).
- Heartbeat: a worker silent for 15 s is dropped (its job follows the rules above). A replaced socket (same device reconnected) counts as a dropped worker for its job.
- The queue is not flushed when the last worker leaves: waiting jobs wait for a returning provider (a page reload is a brief reconnect) until the queue-wait limit (300 s).
- Output beyond what `max_tokens` allows is cut off like a failure after the first chunk.

## Thinking output

Models may emit `<think>…</think>` at the start of the output. The api strips it from `content`; non-empty thinking is returned as `reasoning_content` (message and stream delta). Its tokens are billed as output. The leading block may be preceded by whitespace and its tags may be split across chunks; whitespace right after `<think>` and `</think>` is dropped, and a model that does not open with `<think>` passes through unchanged. Whitespace-only thinking (the empty block Qwen emits when thinking is off) yields no `reasoning_content`.

## Model catalog

The `models` table maps a public id (e.g. `qwen3.5-4b`) to its `gguf_ref`, VRAM need and `price_multiplier` (the context window is in code, see below). A `gguf_ref` is `owner/repo@<40-hex revision>/file.gguf`: a Hugging Face file pinned to a revision, so a repo update never changes what providers run. The catalog has five enabled models. Four are Q4_K_M from `unsloth` at a 16K window: `qwen3.5-2b`, `qwen3.5-4b`, `qwen3.5-9b` and `gemma-4-e2b` (refs in the migration `20261121120000_gguf_catalog.ts`). The fifth, `inkling-2-mini` (migration `20261122120000_inkling_2_mini.ts`), is bartowski's IQ3_XXS (a 26B MoE with 3.4B active parameters, 13.3 GB file, not unsloth's because every unsloth Inkling file has NVFP4 tensors that give NaN logits on llama.cpp's WebGPU backend): an 8K window, its multiplier in [economy.md](economy.md), `vram_mb` 13689, `MIN_PREFILL_TPS` 42 so a full 8K prompt waits 225 s for its first chunk, inside the Playground's 240 s. It needs llama.cpp b12613, hence our own wllama build (D47); how thinking maps for it is in [worker-protocol.md](worker-protocol.md). `vram_mb` is measured with the engine at the model's window (model, KV, recurrent state and compute buffers). A `gguf_ref` can be up to 256 characters (the `ready` frame bound); Inkling's is 132. Rolling its migration back fails once `jobs` reference it (`ON DELETE RESTRICT`): disable the row instead. The default, `qwen3.5-4b`, is a web constant (`DEFAULT_MODEL_ID` in `apps/web/app/lib/api.ts`), not catalog data. The browser runtime (wllama built from our fork, D46, D47) is described in [web.md](web.md); its build in [setup.md](setup.md).

**Context window:** `CONTEXT_WINDOWS` in `apps/api/src/core/models.ts` is the single place for a model's window (default 4096; not a database column, so changing it is a redeploy). The api uses it to admit requests (prompt estimate + `max_tokens` must fit) and returns it as `contextWindow` in `/public/models`; the Share page passes that to the engine as `n_ctx` when loading (`share-worker.js`). The engine allocates the KV cache for the whole window at load, so a larger window costs GPU memory up front. Each worker announces the window it loaded in `ready` (`contextWindow`; 4096 for tabs that do not say), and routing only offers it jobs that fit, so after raising an entry a tab that still runs the old window simply stops getting long jobs until its provider restarts sharing; a request no online worker can fit gets `503 no_providers` at once. How far each model can go is measured per device, see the plan's verification log.
