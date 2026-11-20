# Economy

## Prices

- Integer credits. `credits = (promptTokens × 1 + completionTokens × 5) × model.price_multiplier`. Thinking tokens are completion tokens.
- Constants live in one core module (`INPUT_CREDITS_PER_TOKEN = 1`, `OUTPUT_CREDITS_PER_TOKEN = 5`). Multipliers: `qwen3.5-2b` x1, `qwen3.5-4b` x1, `qwen3.5-9b` x2. A provider earns the same per token on any model of equal multiplier, so a cheap-to-run small model is attractive; integer multipliers cannot price below x1. The web Playground mirrors the two constants in `apps/web/app/lib/api.ts` to show per-reply credits (`priceMultiplier` comes from `GET /public/models`); change them in both places.

## Settlement

- On a job's `done`, one database transaction: `spend` entry (−credits) for the consumer, `earn` entry (+credits) for the provider, both with the job id; update both `balances`; mark the job succeeded with its token counts. Spend always equals earn (no burn).
- Idempotent: ledger `idempotency_key` = `job:<id>:spend` / `job:<id>:earn`. Both balance rows are locked in id order. A settlement is retried up to 3 times (idempotent); if every attempt fails it is logged `settle_lost` (ids and counts), the job ends `failed` / `settle_failed`, and the consumer gets `502 provider_failed` (a stream already underway ends with an error event) instead of an uncharged completion. A job settled at 0 credits (no tokens) writes no entries but still ends `succeeded`. There is no balance pre-check: the consumer may go below zero.
- Failed or interrupted jobs move no credits, including a provider failing after the first chunk. A consumer that cancels or disconnects **after output reached it** is billed for what it received: the api waits (within the 10 s cancel grace, [worker-protocol.md](worker-protocol.md)) for the worker's `done { abort }` and settles its capped usage, with `completionTokens` also capped at the chunks delivered to the consumer; no `done` in time (silent, `error`, gone) → no settlement. Cancelling before the first chunk moves no credits (the job ends `cancelled`).
- Reported usage is untrusted and capped: `completionTokens ≤ max_tokens` and `≤ number of chunks received`; `promptTokens ≤ min(model context, estimate)` where estimate = UTF-8 bytes of all message contents + 16 per message + 32. A `done` with no output, or only whitespace, is not a success: it is a worker failure (requeue rules, [architecture.md](architecture.md)). A job reporting beyond the caps is settled at the caps and logged as `usage_capped`.

## Balances, lanes and free tier

- Balances may go negative (no floor). Positive balance → priority lane; ≤ 0 → fair lane, ordered by balance (more negative = further back).
- Using the fair lane requires a GitHub account at least 30 days old (`users.github_created_at`); younger accounts get `403 account_too_new` while their balance is ≤ 0.
- Earnings simply raise the balance, so providers in debt work their way back up.
- Sign-up grant: `SIGNUP_GRANT_CREDITS` (default 0), written as a `grant` entry.
- Admin `adjust` entries via CLI carry a reason.

## Anti-abuse (MVP)

- Never route a job to a worker owned by the consumer.
- Fair-lane rate limits ([api.md](api.md)); admin CLI can throttle or suspend a user.
- Votes: a user may vote (+1/−1) on a provider who served them, once per provider (latest vote wins). Votes are private in MVP: only the voter sees them, on their history rows. Stored for the post-MVP trust score.
- Deferred: daily earn cap per negative-balance consumer, canary prompts, trust score.
