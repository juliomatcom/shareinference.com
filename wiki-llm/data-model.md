# Data model

Postgres 17, knex migrations in `apps/api/src/adapters/postgres/migrations/`. Ids are UUIDs unless noted. All timestamps `timestamptz`.

| Table            | Columns (key ones)                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`          | `id`, `github_id` (unique), `github_login`, `github_created_at`, `avatar_url`, `display_name` (unique, case-insensitive), `device_label`, `suspended_at`, `rate_limit_override` (jsonb, null), `created_at`                                       |
| `sessions`       | `token_hash` (pk), `user_id`, `expires_at`, `created_at`                                                                                                                                                                                          |
| `api_keys`       | `id`, `user_id`, `name`, `prefix`, `key_hash` (unique), `created_at`, `last_used_at`, `revoked_at`                                                                                                                                                |
| `models`         | `id` (text pk, public id), `webllm_id` (unique), `context_window`, `vram_mb`, `price_multiplier` (int, default 1), `enabled`                                                                                                                      |
| `workers`        | `id`, `user_id`, `device_key`, `gpu` (jsonb), `last_model`, `last_seen_at`, `created_at`; unique (`user_id`, `device_key`)                                                                                                                        |
| `jobs`           | `id`, `consumer_id`, `provider_id`, `worker_id`, `model_id`, `lane`, `status` (queued/running/succeeded/failed/cancelled), `prompt_tokens`, `completion_tokens`, `credits`, `decode_tps`, `error_code`, `created_at`, `started_at`, `finished_at` |
| `ledger_entries` | `id` (bigserial), `user_id`, `amount` (bigint, signed), `kind` (grant/spend/earn/adjust), `job_id`, `note`, `idempotency_key` (unique), `created_at`                                                                                              |
| `balances`       | `user_id` (pk), `balance` (bigint), `updated_at`                                                                                                                                                                                                  |
| `votes`          | pk (`voter_id`, `provider_id`), `value` (smallint ±1), `job_id`, `created_at`, `updated_at`                                                                                                                                                       |

## Invariants

- No prompt or completion text is stored anywhere.
- `balances.balance` = sum of that user's `ledger_entries.amount` (checked by test and by CLI `pnpm ledger:check`).
- A `balances` row is created with the user (balance 0, plus grant if configured).
- Display names: 3–32 chars `[A-Za-z0-9_-]`; default = GitHub login; may not equal another user's GitHub login.
- Device label: optional, ≤ 40 chars, printable.
- Live worker state (ready/busy, current job) is in memory only; `workers` is the durable identity for stats and the leaderboard.
