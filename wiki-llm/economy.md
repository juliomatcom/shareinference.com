# Economy

## Prices

- Integer credits. `credits = (promptTokens × 1 + completionTokens × 5) × model.price_multiplier`. Thinking tokens are completion tokens.
- Constants live in one core module (`INPUT_CREDITS_PER_TOKEN = 1`, `OUTPUT_CREDITS_PER_TOKEN = 5`). MVP has one model with multiplier 1.

## Settlement

- On a job's `done`, one database transaction: `spend` entry (−credits) for the consumer, `earn` entry (+credits) for the provider, both with the job id; update both `balances`; mark the job succeeded with its token counts. Spend always equals earn (no burn).
- Idempotent: ledger `idempotency_key` = `job:<id>:spend` / `job:<id>:earn`.
- Failed, cancelled or interrupted jobs move no credits.
- Reported usage is untrusted and capped: `completionTokens ≤ max_tokens` and `≤ number of chunks received`; `promptTokens ≤ model context`. A job reporting beyond the caps is settled at the caps and logged as `usage_capped`.

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
