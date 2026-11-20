# Logging

Every service logs structured JSON, one object per line, through the shared library `libs/logger-ts` (package `@shareinference/logger`, decision D40). Never use `console.*` or `process.stdout.write` for logs.

## Package

Private ESM workspace package, TypeScript strict, compiled with `tsc` to `dist`; consumers import the build, so run `pnpm build:libs` first (`pnpm lint`, `pnpm test` and `pnpm db:make` do it; the api Dockerfile and CI build it too). It has no runtime dependencies and never reads `process.env`: the caller passes the level.

## Envelope

`{timestamp, severity, app, module, message, context?}`, keys in that order, one line each.

- `timestamp`: ISO 8601 UTC with milliseconds.
- `severity`: `DEBUG`, `INFO`, `WARNING` or `ERROR`. `debug` and `info` go to stdout, `warn` and `error` to stderr.
- `app`: the service (`api`). `module`: the part of it (below).
- `context`: any JSON, omitted when none. `Error`s anywhere in it become `{name, message, stack, cause?}` (cause recursively); bigints become strings; circular references become `"[Circular]"`; nesting deeper than 8 becomes `"[MaxDepth]"`. A context that cannot be serialized becomes `{serializationError}`; logging never throws.

## API

- `createLogger(app, module, { level? })` → `{debug, info, warn, error}(message, context?)`. `level` is `debug` | `info` | `warn` | `error` (default `info`); lower levels are dropped.
- `startTimer()` → a function returning the milliseconds elapsed since the call.
- Api: `adapters/logger.ts` `createLogger(module, level)` implements the core `Logger` port `(msg, fields?)` on top of it with `app: "api"`. Core depends on the port only (an architecture test rejects any other import in `src/core`); `main.ts` creates one logger per module.

## `LOG_LEVEL`

`debug` | `info` (default) | `warn` | `error`. Read only in `adapters/config.ts` and passed to every logger; the CLIs do the same.

## Modules (api)

`main` (start, shutdown), `db` (knex's own messages), `migrate` (also the `pnpm db:*` CLI), `http` (unhandled errors), `auth` (sign-in, API keys), `ledger` (postings), `inference` (dispatch, settlement), `ws` (provider sockets), `cli` (`pnpm users`, `credit`, `ledger`), `fake-worker` (dev tool).

## Rules

- Never log prompt or completion text, tokens (session, worker, OAuth `code`/`state`), API keys, cookies, secrets, `DATABASE_URL` or other env values, nor a whole WebSocket frame. Log ids, counts, timings and reason codes.
- Log an `Error` as `{ error }` in the context (never `String(error)` where the stack matters); for a failure at the edge of `main`, the message alone.
- A message is a fixed phrase (`"api key created"`); the variable parts go in `context` (snake_case keys for new fields).
- CLI output meant for the operator (tables, balances, the `dev-session` token, usage text) is plain text on stdout and is not a log; only logs use the logger.

## What is logged

- **Startup and shutdown** (`main`): `config loaded` (port, log level, origins, trust_proxy; never secrets); then one info `<step> ready` per startup step, in order `database` (`db_host`, `db_port`, `db_name`; never user or password), `migrations`, `github oauth` (`callback`), `core`, `job recovery`, `http` (`port`), `worker websocket` (`path`); then `api started` (`port`). A failing step logs error `<step> failed` (`step`, its fields, `error`: message only) and the process exits 1; invalid configuration logs `startup failed` (`step: config`, naming the variables, never their values). `shutting down` (`signal`), `shutdown complete`.
- **Migrations** (`migrate`, `db`): `migration applied` / `migration rolled back` (`name`), `migration created` (`file`), `migrations` (`applied`, `pending`; `pnpm db:status`), `migration command failed` (error); knex warnings and errors from `db`.
- **Sign-in** (`auth`): `signed in` (`user_id`, `created`), `sign-in rejected` (warn: `reason`, `github_id`), `display name released to its GitHub login` (warn), `sign-in failed` (error). Never the code, state or session token. A new account's sign-up grant is a ledger entry written with the account, not a separate line.
- **API keys** (`auth`): `api key created` (`user_id`, `key_id`), `api key revoked` (`user_id`, `key_id`), `api key refused` (`reason`: `too_many_keys`). Never the key or its hash.
- **Ledger** (`ledger`): `ledger entry posted` (`user_id`, `entry_id`, `kind`, `amount`, `balance`, `job_id?`) after commit; `ledger entry not posted` (debug: `status`: `duplicate` or `no_user`). Never the note.
- **Workers** (`ws`): `worker connected` (`worker_id`, `user_id`, `replaced`), `worker ready` (`worker_id`, `model`, `load_ms`), `worker disconnected` (`worker_id`, `code`), `worker timed out` (`worker_id`), `worker owner suspended` (`worker_id`), `worker dropped` (`worker_id`, `code`: the dispatcher dropped it), `worker refused` (warn: `close` code), `worker upgrade refused` (warn: `reason`), `worker frame failed` (error), `worker socket error` (debug).
- **Inference** (`inference`): `job settled` (`job_id`, `consumer_id`, `provider_id`, `status`, `credits`, `prompt_tokens`, `completion_tokens`), `usage_capped` (warn: job and worker ids, reported and capped counts), `settle_lost` (error: ids and counts of a settlement that failed 3 times), `job settle attempt failed` (warn), `job timed out` (warn: `job_id`, `worker_id`, `reason`), `worker ignored cancel` (warn: the worker is then dropped), `job output over limit` (warn), `job send failed` (warn), `worker job error` (info: `code` only, never the message), `job <what> failed` (error: a database write of a job failed), `unfinished jobs abandoned` (`main`, warn: `count`). Never messages or completions.
- **HTTP** (`http`): `unhandled error` (error: the error; 5xx only).
- **CLI** (`cli`, `ledger`, `fake-worker`): `user suspended` / `user unsuspended` (`user_id`), `rate limit set`, credit postings through `ledger`, `command failed` (error: message only); the fake worker's `connected`, `welcome` (`worker_id`), `stats` (`jobs_served`), `closed`, `socket error`, `fake worker failed`.
