# Setup

## Run

`cp .env.example .env`, fill the required values, `docker compose up -d --build`. Web on `http://localhost:3000`, api on `http://localhost:4000`. Migrations run on api start (and via `pnpm db:migrate`).

## Environment (`.env`, documented in `.env.example`)

| Variable                                   | Required | Purpose                                                                 |
| ------------------------------------------ | -------- | ----------------------------------------------------------------------- |
| `COMPOSE_PROFILES`                         | no       | `localdb` starts the bundled Postgres; empty when using an external one |
| `POSTGRES_PASSWORD`                        | localdb  | Password of the bundled Postgres                                        |
| `DATABASE_URL`                             | yes      | Postgres connection URL (include `sslmode` for managed databases)       |
| `DB_POOL_MAX`                              | no       | Max pool size (default 10)                                              |
| `WEB_ORIGIN`                               | yes      | Public origin of the web app (cookie, redirects)                        |
| `API_PUBLIC_URL`                           | yes      | Public URL of the api (consumers, provider WebSocket)                   |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | yes      | GitHub OAuth app                                                        |
| `SIGNUP_GRANT_CREDITS`                     | no       | Credits granted at sign-up (default 0)                                  |
| `LOG_LEVEL`                                | no       | `debug` / `info` (default) / `warn` / `error`                           |

Tests: `TEST_DATABASE_URL` (optional; DB tests skip without it).

## Database

- Bundled: service `db` (Postgres 17) under profile `localdb`, data in named volume `db-data` — survives restarts and `docker compose down`; only `docker compose down -v` deletes it.
- External (e.g. GCP Cloud SQL for PostgreSQL 17): remove `localdb` from `COMPOSE_PROFILES`, set `DATABASE_URL` (TLS required; private IP or Cloud SQL Auth Proxy).

## CLI (root `pnpm` scripts, run against `DATABASE_URL`)

- `pnpm db:migrate`, `pnpm db:rollback`, `pnpm db:status`, `pnpm db:make <name>`
- `pnpm users list` · `pnpm users suspend|unsuspend <login>` · `pnpm users throttle <login> <perMin> <perDay>`
- `pnpm credit <login> <amount> <reason>` · `pnpm ledger <login>` · `pnpm ledger:check`
