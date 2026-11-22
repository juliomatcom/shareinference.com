# Setup

## Run

`cp .env.example .env`, fill the required values, `docker compose up -d --build`. Web on `http://localhost:4400`, api on `http://localhost:4401` (host ports `WEB_PORT` / `API_PORT`; container ports stay 3000 / 4000). Migrations run on api start (and via `pnpm db:migrate`).

Dev with live reload: `pnpm dev` starts the `db` container, then runs the api (`tsx watch`, port 4401) and web (`next dev`, port 4400) on the host; stop the compose `api`/`web` first (same ports). The api reads the root `.env`, so for `pnpm dev` it holds host values: `DATABASE_URL` with `127.0.0.1` (not `db`, which resolves only inside compose) and `PORT=4401`.

## Environment (`.env`, documented in `.env.example`)

| Variable                                   | Required | Purpose                                                                                                                                                                    |
| ------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPOSE_PROFILES`                         | no       | `localdb` starts the bundled Postgres; empty when using an external one                                                                                                    |
| `POSTGRES_PASSWORD`                        | localdb  | Password of the bundled Postgres; empty by default (db refuses to start); fixed at first volume init                                                                       |
| `DATABASE_URL`                             | yes      | Postgres connection URL (include `sslmode` for managed databases)                                                                                                          |
| `DB_POOL_MAX`                              | no       | Max pool size, 2 or more (default 10)                                                                                                                                      |
| `WEB_ORIGIN`                               | yes      | Public origin of the web app (cookie, redirects, CSRF `Origin` check); no path                                                                                             |
| `API_PUBLIC_URL`                           | yes      | Public URL of the api (consumers, provider WebSocket)                                                                                                                      |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | yes      | GitHub OAuth app (below); the api refuses to start without them                                                                                                            |
| `SIGNUP_GRANT_CREDITS`                     | no       | Credits granted at sign-up as a `grant` ledger entry; integer >= 0 (default 0)                                                                                             |
| `BIND_ADDR`, `WEB_PORT`, `API_PORT`        | no       | Compose only (the app never reads them): host bind address (default `127.0.0.1`) and ports (4400/4401)                                                                     |
| `LOG_LEVEL`                                | no       | `debug` / `info` (default) / `warn` / `error`                                                                                                                              |
| `TRUST_PROXY`                              | no       | `true` / `false` (default): per-IP limits read `X-Real-IP` (set by Caddy) instead of the socket; production only                                                           |
| `DOMAIN`, `API_DOMAIN`                     | prod     | Compose only (`compose.prod.yaml`): the website host and the api host Caddy serves (`shareinference.com`, `api.shareinference.com`); locally `localhost` / `api.localhost` |
| `HTTP_PORT`, `HTTPS_PORT`                  | no       | Compose only: host ports of Caddy (default 80 / 443; override to test locally)                                                                                             |
| `IMAGE_TAG`                                | prod     | Compose only: tag of the prebuilt images (`shareinference-api:<tag>`); `scripts/deploy.mjs` writes it to `.deploy.env`; default `latest`                                   |

`BIND_ADDR` is the host address the web and api ports are published on. Keep the loopback default; set it to the VM's NIC address (e.g. `10.0.2.15`) only when the stack runs inside a VM with NAT port forwarding from the host, and never to `0.0.0.0` on a public machine. The `db` port always stays on `127.0.0.1`.

Tests: `TEST_DATABASE_URL` (optional; DB tests skip without it).

The api container receives only the variables it reads (explicit `environment:` in `compose.yaml`), never `POSTGRES_PASSWORD`. It listens on a fixed port 4000 inside the container. The web image takes the build arg `API_INTERNAL_URL` (default `http://localhost:4401`, for running web outside Docker; compose sets `http://api:4000`): Next resolves the `/api/*` rewrite at build time, so changing it needs a rebuild. The `/docs` pages are built from the repo's `docs/` at image build time (editing a doc needs a rebuild of `web`). The `db` port `127.0.0.1:5432` is published for development and tests only; `compose.prod.yaml` removes it.

## GitHub OAuth app

Sign-in is GitHub only. On GitHub: Settings -> Developer settings -> OAuth Apps -> New OAuth App.

- Homepage URL: the value of `WEB_ORIGIN` (e.g. `http://localhost:4400`).
- Authorization callback URL: `<WEB_ORIGIN>/api/auth/github/callback` (the api route `/auth/github/callback` reached through the web rewrite). The api sends this exact value as `redirect_uri`.
- Copy the Client ID into `GITHUB_CLIENT_ID`, generate a client secret into `GITHUB_CLIENT_SECRET`, restart the api (`docker compose up -d`). Scope requested: `read:user`.
- Changing `WEB_ORIGIN` (another host or port) means updating the callback URL on GitHub.
- The api sends no `Strict-Transport-Security` header and no `upgrade-insecure-requests` CSP directive (Helmet's defaults are switched off): the TLS terminator in front (Caddy in production) owns HSTS, and plain-http use (localhost, a VM) must keep working.
- Per-IP limits live in the api (rules in [api.md](api.md) "Limits"); Caddy has no rate limiter. They identify the caller by `X-Real-IP` only when `TRUST_PROXY=true`.

## Database

- Bundled: service `db` (Postgres 17) under profile `localdb`, data in named volume `db-data` — survives restarts and `docker compose down`; only `docker compose down -v` deletes it.
- External (e.g. GCP Cloud SQL for PostgreSQL 17): remove `localdb` from `COMPOSE_PROFILES`, set `DATABASE_URL` (TLS required; private IP or Cloud SQL Auth Proxy).

## Browser engine (`libs/wllama-webgpu`)

What the engine is and how it loads: [web.md](web.md) "Share page". Commands, from the repo root:

- `pnpm --filter @shareinference/wllama-webgpu sync`: checks `vendor/<engine id>/` against the sha256 and sources recorded in its `BUILD.md` (the copy is the recorded build, and the recorded wllama and llama.cpp commits, tag and emsdk version, plus the submodule gitlink when git is available, equal `refs.json`; this is integrity, not provenance: it does not prove the files were built from those sources) and copies the engine into `apps/web/public/engine/` (generated, git-ignored; `apps/web` `dev` and `build` run it, so the Docker build needs no extra step). Nothing needs the submodule or a toolchain: the built engine is committed.
- `pnpm --filter @shareinference/wllama-webgpu test`: unit tests of the shader patch, the model-family profiles, the job streaming (fake wllama) and the BUILD.md source check (no browser).
- `pnpm --filter @shareinference/wllama-webgpu check:browser`: the browser gate. Runs the synced engine in a Worker in system Chrome (needs a GPU, so run it on a Mac; run `sync` first) and drives it over the DevTools Protocol. Env: `CHECK_MODEL` (public id or full `gguf_ref`, default `qwen3.5-2b`), `CHECK_CASES` (comma list of A to K; case P, prefill tokens/s, is opt-in), `CHECK_CONTEXT` (default 16384), `CHECK_PREFILL_TOKENS` (case P prompt size, default 14000), `CHECK_STOCK=1` (first load without the shader patch, for diagnosis), `CHECK_CHROME` (browser binary), `CHECK_PROFILE_DIR` (reuse a profile so model downloads survive; never deleted). The first run of a model downloads its GGUF file.

**Engine build (maintainers only; `pnpm install`, `pnpm dev`, tests, lint and Docker never need it).** wllama and llama.cpp are compiled to wasm from our fork, a git submodule at `libs/wllama-webgpu/wllama` (`juliomatcom/wllama`, branch `shareinference`: upstream tag plus a newer llama.cpp pin plus minimal glue patches, see its `SHAREINFERENCE.md`). `libs/wllama-webgpu/build/refs.json` pins every input (fork commit, llama.cpp tag and commit, emsdk version, Dawn `emdawnwebgpu` package with its sha256) and the engine id.

- One-time: `git submodule update --init libs/wllama-webgpu/wllama` (shallow), and an emsdk **4.0.20** installed outside the repo: `git clone https://github.com/emscripten-core/emsdk ~/emsdk && cd ~/emsdk && ./emsdk install 4.0.20 && ./emsdk activate 4.0.20`. Other emscripten versions fail at link (Homebrew's 7.0.0 does). Also needs cmake, make, python3, unzip, node and npm.
- `EMSDK=~/emsdk pnpm --filter @shareinference/wllama-webgpu build:engine` (about 75 s on 12 cores): checks the submodule is at `refs.json`'s commit, builds with `GGML_WEBGPU=ON GGML_WEBGPU_JSPI=ON`, packages one ES module, refuses output that contains a local path, and writes `vendor/<engine id>/wllama/index.js`, `wllama/wasm/wllama.wasm` and `BUILD.md` (refs, flags, sizes, sha256). The wasm embeds the fork's commit hash, so every fork commit changes it; a rebuild that ships needs a new engine id (the files are cached as immutable).

**Upgrading the engine** (new llama.cpp or wllama):

1. In the fork's `shareinference` branch: move the llama.cpp submodule, fix any glue drift, push. Upstream the patch when it helps others.
2. Move the submodule pointer, then update `refs.json` (commits, tag, engine id) and the id in `apps/web/public/share-worker.js` and `libs/wllama-webgpu/scripts/check-page/worker.js`.
3. Run `build:engine`, commit `vendor/`. Before shipping, a second maintainer step: rebuild from the pinned refs (clean checkout of the pinned submodule commit, same emsdk) and compare the `sha256` lines of the new `BUILD.md` with the committed ones; the committed binary is trusted only if they match.
4. Run `check:browser` on `qwen3.5-2b` and `qwen3.5-9b`.
5. If the shader patch reports `applied` 0 or `skipped` above 0, the shader text changed: update the patch, or remove it if upstream fixed this.
6. Ship only if all cases pass.

Enabling the shader patch for another GPU vendor requires that vendor to pass case C (identical output) first.

## CLI (root `pnpm` scripts)

Commands run inside the running api container (`docker compose exec api node dist/…`) through the root scripts, so they use the container's `DATABASE_URL`. Only `db:make` runs locally (it needs no database).

- `pnpm db:migrate`, `pnpm db:rollback`, `pnpm db:status`, `pnpm db:make <name>`
- `pnpm users list` · `pnpm users suspend|unsuspend <login>` · `pnpm users throttle <login> <perMin> <perDay>` (stores `rate_limit_override`; replaces the per-minute and per-day limits, [api.md](api.md))
- `pnpm credit <login> <amount> <reason>` (an `adjust` entry; negative debits) · `pnpm ledger <login>` · `pnpm ledger:check` (every balance equals the sum of its entries; exit 1 on mismatch)
- `pnpm users dev-session <login>` — **dev/test tool only**. Creates the local test user `<login>` if missing (negative `github_id`, GitHub account created one year ago) and prints a session token on stdout (pnpm's own header goes to stderr). Use it as the `si_session` cookie to test signed-in flows without GitHub: `curl -b "si_session=$(pnpm users dev-session alice)" http://localhost:4400/api/me`. Anyone holding a token is signed in as that user, so never run it against a public server's database. It refuses real GitHub accounts (positive `github_id`) and matches the GitHub login only.
- `pnpm fake-worker <login> [--seconds N] [--api URL] [--device KEY]` — **dev/test tool only** (`apps/api/src/devFakeWorker.ts`, runs in the api container). Gets a session for the test user `<login>` through the same code as `dev-session`, requests a worker token, connects to `/v1/worker` (Origin `WEB_ORIGIN`), announces the `qwen3.5-4b` `gguf_ref` with a fake GPU, heartbeats every 5 s, and answers any `job` with canned chunks (starting with `<think>\n\n</think>\n\n`) and a `done` with plausible usage; it honours `cancel`. It stops on Ctrl-C or when stdin closes; with `--seconds N` it ignores stdin and runs N seconds (use this when backgrounding with no stdin). Example: `sleep infinity | pnpm fake-worker alice &`. Then `curl http://localhost:4400/api/public/models` shows `workersOnline: 1`. Never run it against a public server.
- CLI output for the operator (tables, balances, tokens, usage) is plain text on stdout; logs (state changes, failures) are JSON lines in the shape of [logging.md](logging.md).
- `<login>` is a GitHub login or a display name, case-insensitive; an ambiguous match is an error.

## Production (one VM, D41)

Docs: `docs/deploy.md` (runbook). Files:

- `compose.prod.yaml`, used as `docker compose -f compose.yaml -f compose.prod.yaml --env-file .env --env-file .deploy.env`: adds `caddy` (`caddy:2.11.9`, ports `HTTP_PORT`/`HTTPS_PORT` default 80/443 + 443/udp, volumes `caddy-data`/`caddy-config`, read-only directory mount `ops/caddy/`, 64 MB); removes the host ports of `db`, `api`, `web`; forces `TRUST_PROXY=true` on the api (Caddy is always in front); runs prebuilt images `shareinference-{api,web}:${IMAGE_TAG}` (no `build`); `web` has `NODE_OPTIONS=--max-old-space-size=160` and 256 MB; `db` runs `shared_buffers=64MB`, `max_connections=20`, 256 MB (the 1 GB VM budget, D41).
- `ops/caddy/Caddyfile` (the directory is mounted so a deploy that replaces the file is seen; `scripts/deploy.mjs` also runs `caddy reload`): three sites with automatic HTTPS and HSTS. `www.{$DOMAIN}` redirects permanently to `https://{$DOMAIN}{uri}`. `{$DOMAIN}` -> `web:3000`; `{$API_DOMAIN}` -> `api:4000` (`/v1/*`, the `/v1/worker` WebSocket, every api route), `flush_interval -1` so SSE streams, no `encode` (nothing compresses `text/event-stream`). Both set `X-Real-IP {remote_host}` (overwriting any client value); the Next `/api/*` rewrite forwards it. Prod `.env`: `WEB_ORIGIN=https://shareinference.com`, `API_PUBLIC_URL=https://api.shareinference.com`, `TRUST_PROXY=true`, `COMPOSE_PROFILES=localdb`, `DOMAIN`, `API_DOMAIN`. DNS needs A records for the apex, `api.` and `www.` and no AAAA for now (Docker's userland proxy can hide IPv6 client addresses). The Share page (on the web origin) opens the WebSocket cross-origin; the upgrade's `Origin` check stays `WEB_ORIGIN`.
- Production VM: deploy and operate as `root` over key-only ssh (`PasswordAuthentication no`, `PermitRootLogin prohibit-password`); no separate deploy user (2026-11-20; a `docker`-group user is root-equivalent anyway). Scripts and the systemd unit assume root.
- `scripts/deploy.mjs`, run as `pnpm run deploy` (Node, no shell script; plain `pnpm deploy` is pnpm's own command; `DEPLOY_HOST=root@host [DEPLOY_DIR] [DEPLOY_DOMAIN] [DEPLOY_API_DOMAIN] [DEPLOY_PLATFORM=linux/amd64] [-- --dry-run]`; progress lines in `scripts/deploy-log.mjs`, unit tests `pnpm test:scripts`): builds both images locally (tag = short commit, `-dirty-<time>` when uncommitted), `docker save | gzip | ssh ... docker load`, copies `compose.yaml`, `compose.prod.yaml`, `ops/`, starts with the new tag in a temp `.deploy.env.new`, reloads Caddy, polls both health URLs, and only then makes it live (`.deploy.env`, the old one kept as `.deploy.env.prev`). The previous tag is read before anything changes; any failure prints the exact rollback command. `IMAGE_TAG=<tag> pnpm run deploy` (tag already on the VM) redeploys without building or uploading = rollback. Uploads a local gitignored `.env.prod` as the VM's `.env` (mode 600, replacing the one there) with the images when it exists; otherwise the VM needs a hand-made `.env` and the script never touches it.
- `ops/backup.sh`: `pg_dump -Fc` through `docker compose exec -T db` to `$BACKUP_DIR` (default `/var/backups/shareinference`) as `shareinference-<UTC>.dump`, atomic (`.tmp` then `mv`), verified with `pg_restore -l`, names include seconds and the PID, retention `BACKUP_RETENTION_DAYS` (14; also prunes `pre-restore-*` dumps and `*.tmp` leftovers older than a day), optional upload when `BACKUP_RCLONE_REMOTE` is set (off-VM storage is later; Linode daily VM backups are the interim off-site layer). `ops/shareinference-backup.{service,timer}` run it nightly 03:30 UTC (`Persistent=true`); no alerting (check `systemctl --failed` / `journalctl -u shareinference-backup`). Dumps hold user data: encrypt the off-VM copy (rclone crypt) when it is enabled. `COMPOSE_DIR` / `COMPOSE_ARGS` select the stack (default: production arguments when `.deploy.env` exists).
- `ops/restore.sh [--yes] [--db NAME] <dump>`: default target is the live `shareinference` (confirmation by typing the name; stops `api`, drops and recreates the database, `pg_restore`, starts `api`; first a safety `pg_dump` to `BACKUP_DIR/pre-restore-<time>.dump`, abort if it fails); `--db NAME` restores into a scratch database and leaves `api` alone (restore test).
- Admin on the VM: `docker compose ... exec -T api node dist/users.js <cmd>` (the `pnpm` scripts need the dev stack). `suspend` blocks an account everywhere and drops its workers (4403, at the next heartbeat check); suspending the owner is the worker-level suspension in the MVP. `throttle <login> <perMin> <perDay>` replaces the user's rate limits. The CLI opens 2 database connections; the root `pnpm db:*` scripts pin `DB_POOL_MAX=2`, so nothing competes with the api's pool for Postgres' 20 connections.
