# Architecture

## Components

| Component  | What it is                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api` | Express 5 + `ws`, single process. Auth, OpenAI-compatible API, provider WebSocket, in-memory worker registry and queues, ledger settlement, CLI |
| `apps/web` | Next.js + Tailwind. Public pages, gated dashboard, provider Share page (WebLLM in a Web Worker). No backend: `/api/*` rewrites to the api       |
| Postgres   | Postgres 17. Users, sessions, keys, workers, jobs, ledger, balances, votes, models                                                              |

Compose services: `db` (profile `localdb`, volume `db-data`), `api` (published `127.0.0.1:4000`), `web` (published `127.0.0.1:3000`). The api reads only `DATABASE_URL`, so `db` can be replaced by any Postgres 17 (e.g. GCP Cloud SQL) — see [setup.md](setup.md).

## Request lifecycle (consumer)

1. `POST /v1/chat/completions` with `Authorization: Bearer <api key>` → key hash lookup → user.
2. Validate body (zod), resolve public model id → catalog row, apply limits ([api.md](api.md)).
3. Admission: rate limits by lane; free lane (balance ≤ 0) requires GitHub account age ≥ 30 days ([economy.md](economy.md)).
4. Route: pick a **random** eligible worker — `ready`, idle, same model, owner ≠ consumer. None → enqueue.
5. Dispatch `job` to the worker with only `messages` + whitelisted params. Mark worker busy.
6. Stream `chunk`s to the consumer (SSE) or buffer them (JSON). On `done`, apply the thinking split (below), settle credits in one transaction, send the provider its `stats`, mark worker idle, dispatch the next queued job.

## Queues and routing

- One queue per model with two lanes: **priority** (consumer balance > 0) is always served before **fair** (balance ≤ 0). Inside the fair lane, higher balance first, then arrival order.
- Routing is random and blind: consumers choose a model, never a provider. The provider's public name is revealed only in the consumer's history after the job ends.
- A worker never receives a job from its own owner.
- Limits: max 100 queued requests per model; max wait 30 s → `503 network_busy`.

## Failure rules

- Worker disconnects, errors or times out **before the first chunk** → requeue once at the front of its lane; second failure → `502 provider_failed`.
- **After the first chunk** → end the stream with an error event; no credits move (consumer not charged, provider not paid).
- Consumer disconnects → send `cancel` to the worker; no credits move.
- Per-job timeout: 30 s to first chunk, 180 s total.
- Heartbeat: a worker silent for 15 s is dropped (its job follows the rules above).

## Thinking output

Models may emit `<think>…</think>` at the start of the output. The api strips it from `content`; non-empty thinking is returned as `reasoning_content` (message and stream delta). Its tokens are billed as output.

## Model catalog

The `models` table maps a public id (e.g. `qwen3.5-4b`) to the WebLLM id (e.g. `Qwen3.5-4B-q4f16_1-MLC`), context window, VRAM need and `price_multiplier`. MVP ships one enabled model: `qwen3.5-4b` → `Qwen3.5-4B-q4f16_1-MLC`, context 4096. WebLLM `@mlc-ai/web-llm@0.2.89`, loaded pinned from jsDelivr.
