# Deploying to a server

This is the runbook for putting ShareInference on one public Linux VM (Debian 13, 1 vCPU, 2 GB RAM) at `https://shareinference.com`. For a local or private install see [setup](setup.md). The technical facts (variables, compose files, scripts) are in [`wiki-llm/setup.md`](../wiki-llm/setup.md).

## How it fits together

```
internet -> Caddy :80/:443 (automatic HTTPS, HSTS)
              shareinference.com      -> web:3000  (website; its /api/* calls reach the api internally)
              api.shareinference.com  -> api:4000  (OpenAI-compatible API, streaming, provider WebSocket)
            db (Postgres 17), api and web publish no host ports
```

- Images are built on your own machine and copied to the VM over ssh. Nothing is built on the VM (it has 2 GB of RAM).
- The production settings are an override file, `compose.prod.yaml`, used together with `compose.yaml`.
- Secrets live in one hand-made `.env` on the VM. The deploy script never reads or writes it.
- Per-IP rate limits run in the api and rely on Caddy telling it the visitor's address (`TRUST_PROXY=true`, below).

## 1. Prepare the VM (once)

Log in as `root` (key-only ssh, hardened below; there is no separate deploy user, and a member of the `docker` group would be root-equivalent anyway). Everything here is run on the VM as root. Create the target directory too:

```sh
mkdir -p /opt/shareinference
```

**Docker Engine and the compose plugin** from Docker's own apt repository:

```sh
apt-get update && apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF2
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF2
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

**1 GB of swap** as insurance against memory spikes:

```sh
fallocate -l 1G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

**Firewall.** Only ssh and the web ports are open. (Ports published by Docker bypass ufw, which is why the production override publishes nothing but Caddy's 80/443.)

```sh
apt-get install -y ufw
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw enable
```

**OS updates are manual** (no `unattended-upgrades`, so nothing changes under the running stack by surprise). Roughly once a month, and right away after a Debian security announcement, take a snapshot or backup first, then:

```sh
apt-get update && apt-get upgrade
# reboot only if /var/run/reboot-required exists (a new kernel), then check the stack is back up
```

**Key-only ssh.** Make sure your public key is in `/root/.ssh/authorized_keys` (mode 600) _before_ disabling passwords. Keep your current session open, and check that a new terminal can log in as `root` with the key, then:

```sh
tee /etc/ssh/sshd_config.d/10-hardening.conf >/dev/null <<'EOF2'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF2
systemctl reload ssh
```

Test a **new** session (key login must work, a password login must be refused) before closing the one you have. Some images ship an earlier `sshd_config.d` file that sets these options; the first value read wins, so check the result with `sshd -T | grep -E 'passwordauthentication|permitrootlogin|kbdinteractive'`.

## 2. DNS

`shareinference.com`, `api.shareinference.com` and `www.shareinference.com` must point at the VM before the first start, because Caddy needs them to get the certificates (`www` is redirected to the apex). Create an **A record for each, and no AAAA records for now**: Docker's userland proxy can hide the real address of IPv6 visitors (every one would look like the same address to the per-IP limits). Revisit IPv6 later.

```sh
dig +short shareinference.com        # must print the VM's public IP
dig +short api.shareinference.com    # the same IP
dig +short www.shareinference.com    # the same IP
dig +short AAAA shareinference.com   # must print nothing
```

Ports 80 and 443 must be reachable from the internet (Let's Encrypt validates over them).

## 3. GitHub OAuth app for production

GitHub -> Settings -> Developer settings -> OAuth Apps -> New OAuth App:

- **Homepage URL**: `https://shareinference.com`
- **Authorization callback URL**: `https://shareinference.com/api/auth/github/callback`

Keep the Client ID and generate a client secret. This is a separate app from your local development one.

## 4. Production `.env`

Create `/opt/shareinference/.env` on the VM by hand and lock it down (`chmod 600 .env`). Never commit it.

| Variable                                   | Production value                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPOSE_PROFILES`                         | `localdb` (the bundled Postgres on the VM)                                                                                             |
| `POSTGRES_PASSWORD`                        | `openssl rand -hex 16` (hex only). Fixed when the database is first created.                                                           |
| `DATABASE_URL`                             | `postgres://shareinference:${POSTGRES_PASSWORD}@db:5432/shareinference`                                                                |
| `WEB_ORIGIN`                               | `https://shareinference.com`                                                                                                           |
| `API_PUBLIC_URL`                           | `https://api.shareinference.com` (the api has its own host; the website and the Share page learn it from the api)                      |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | From the production OAuth app above                                                                                                    |
| `DOMAIN`, `API_DOMAIN`                     | `shareinference.com` and `api.shareinference.com` (the hosts Caddy serves and gets certificates for)                                   |
| `TRUST_PROXY`                              | `true`. Makes the api read the visitor's address from the `X-Real-IP` header that Caddy sets. Never set it without the proxy in front. |
| `SIGNUP_GRANT_CREDITS`                     | Optional, e.g. `100`. Default `0`.                                                                                                     |
| `LOG_LEVEL`                                | Optional, `info` (default)                                                                                                             |
| `DB_POOL_MAX`                              | Optional; leave the default (10). Postgres allows 20 connections in production.                                                        |
| `BIND_ADDR`, `WEB_PORT`, `API_PORT`        | Not used in production (no host ports); leave unset                                                                                    |
| `HTTP_PORT`, `HTTPS_PORT`                  | Leave unset (80 / 443)                                                                                                                 |

`IMAGE_TAG` is not in `.env`: the deploy script writes it to `.deploy.env` next to it.

## 5. First deploy

On your own machine, from a clean, committed checkout (the image tag is the git commit; an uncommitted tree gets a `-dirty-<time>` tag). Docker must be running locally.

```sh
export DEPLOY_HOST=root@<vm-address>
ops/deploy.sh --dry-run     # builds the images and prints what it would do on the VM
ops/deploy.sh
```

The script builds the images for `linux/amd64` (set `DEPLOY_PLATFORM` if your VM differs; building amd64 on an ARM Mac uses qemu emulation and is slow, so build on an amd64 machine or in CI when you can), copies them over ssh, copies the compose files and `ops/` to `/opt/shareinference`, starts the stack, reloads Caddy (so a changed `ops/caddy/Caddyfile` applies) and polls `https://shareinference.com/api/healthz` and `https://api.shareinference.com/healthz` for up to 90 seconds. The first start also fetches Postgres and Caddy images and the certificate, so it takes longer.

If it fails, on the VM: `cd /opt/shareinference` and `docker compose -f compose.yaml -f compose.prod.yaml --env-file .env --env-file .deploy.env logs --tail 100`. A convenient alias for the commands below (the live tag is in `.deploy.env`; it changes only after a deploy turned out healthy):

```sh
alias si='docker compose -f compose.yaml -f compose.prod.yaml --env-file .env --env-file .deploy.env'
```

## 6. Backups

The database is the only state worth keeping. `ops/backup.sh` writes a compressed `pg_dump` to `/var/backups/shareinference/` every night and keeps 14 days; the VM provider's daily VM backups (enable them in the provider's panel) are the second layer. **Until `BACKUP_RCLONE_REMOTE` is set (below), the provider's daily VM backup is the only copy that lives off the VM.** The dumps contain user data (GitHub ids and logins, ledger, job metadata): when you enable the off-VM copy, encrypt it (rclone's `crypt` remote).

Install the timer on the VM (adjust the paths in the `.service` file if you deployed elsewhere):

```sh
cp /opt/shareinference/ops/shareinference-backup.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now shareinference-backup.timer
systemctl start shareinference-backup.service     # run one now
journalctl -u shareinference-backup.service -n 20  # "backup written: ..."
ls -l /var/backups/shareinference
```

Failures are not alerted: look now and then (and after any incident) with `systemctl --failed`, `systemctl list-timers shareinference-backup.timer` and `journalctl -u shareinference-backup.service --since '3 days ago'`. The backup directory is root-owned (mode 700); you operate as root, so it is directly readable.

Settings (set with `systemctl edit shareinference-backup.service`, as `Environment=` lines): `BACKUP_DIR`, `BACKUP_RETENTION_DAYS`.

**Later: an off-VM copy.** Install `rclone`, configure a remote for your object storage, and set `BACKUP_RCLONE_REMOTE` (for example `Environment=BACKUP_RCLONE_REMOTE=mystorage:shareinference-backups`). The script then uploads every new dump; until it is set the upload is skipped.

### Test a restore (do this once before launch)

Restore the latest dump into a scratch database and compare counts. The live database and the api are not touched:

```sh
cd /opt/shareinference
DUMP=$(ls -t /var/backups/shareinference/*.dump | head -1)
ops/restore.sh --yes --db restore_test "$DUMP"
for db in shareinference restore_test; do
  si exec -T db psql -U shareinference -d $db -tA -c \
    "select count(*) from users" -c "select count(*) from ledger_entries" -c "select count(*) from jobs"
done
si exec -T db psql -U shareinference -d postgres -c "DROP DATABASE restore_test WITH (FORCE)"
```

(The scripts find the compose files on their own.)

### Restore for real (disaster)

```sh
cd /opt/shareinference
ops/restore.sh /var/backups/shareinference/shareinference-<timestamp>.dump
```

It asks you to type the database name, stops the api, takes a safety dump of the current database (`/var/backups/shareinference/pre-restore-<time>.dump`; the restore aborts if that fails), drops and recreates the `shareinference` database from the dump, and starts the api again (which applies any newer migrations). Finish with `si exec -T api node dist/users.js ledger:check`. Everything written after the dump was taken is lost.

## 7. Smoke test (before telling anyone)

- [ ] `https://shareinference.com` loads over HTTPS (padlock, no warnings) and `http://shareinference.com` redirects to it.
- [ ] Sign in with GitHub; you land on the dashboard. The sign-in page shows the Terms and Privacy line.
- [ ] Create an API key and call it: `curl https://api.shareinference.com/v1/models -H "Authorization: Bearer <key>"`.
- [ ] Open **Share GPU** on **two real contributor devices** (Chrome or Edge with WebGPU), tick "I understand", start sharing, and wait for "Ready". `curl https://api.shareinference.com/public/stats` shows `activeWorkers: 2`. (The page on `shareinference.com` opens its WebSocket to the api host.)
- [ ] `curl -i -X OPTIONS https://api.shareinference.com/v1/chat/completions -H 'Origin: https://example.com' -H 'Access-Control-Request-Method: POST'` answers `204` with `access-control-allow-origin: *` (browser apps may use the API).
- [ ] A streaming request works end to end and tokens arrive incrementally: `curl -N https://api.shareinference.com/v1/chat/completions -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"model":"qwen3.5-4b","stream":true,"messages":[{"role":"user","content":"Hello"}]}'` (use a key of a different account than the contributors: a worker never serves its own owner).
- [ ] The Playground answers from the browser, with metrics.
- [ ] The contributors' dashboards show earned credits; the consumer's shows the spend.
- [ ] `si exec -T api node dist/users.js ledger:check` prints `ledger OK`.
- [ ] A backup ran (`ls /var/backups/shareinference`) and the restore test above passed.
- [ ] Backups: `BACKUP_RCLONE_REMOTE` is not set yet, so the only off-VM copy is the provider's daily VM backup (enabled in its panel). Known and accepted for launch.
- [ ] The api sees visitors' real addresses, not Caddy's. `si exec -T api printenv TRUST_PROXY` prints `true`; then from your laptop run `for i in $(seq 700); do curl -s -o /dev/null -w '%{http_code}\n' -H "X-Real-IP: 10.1.$((i/250)).$((i%250))" https://api.shareinference.com/public/stats; done | sort | uniq -c`: about 600 answers of `200` and the rest `429` (your one address is limited, the spoofed header is ignored), while the same URL still answers `200` from another network (a phone on mobile data).
- [ ] `https://www.shareinference.com/anything` answers `301` to `https://shareinference.com/anything`.
- [ ] `si ps` shows all four containers healthy; `free -m` shows memory headroom.

## Everyday operations

**Admin commands** (the `pnpm users ...` scripts of the setup guide need the repo and the development stack, so on the VM run them through compose; the CLI opens at most 2 database connections, and the root `pnpm db:*` scripts pin `DB_POOL_MAX=2` the same way, so a command never competes with the api's pool for Postgres' 20 connections):

```sh
si exec -T api node dist/users.js list
si exec -T api node dist/users.js suspend <login>     # also: unsuspend, throttle <login> <perMin> <perDay>
si exec -T api node dist/users.js credit <login> 100 "reason"
si exec -T api node dist/users.js ledger:check
```

Suspending a user blocks the account everywhere and disconnects their devices within a minute; that is how a provider's worker is suspended (a worker belongs to its owner). `throttle` replaces the user's per-minute and per-day request limits.

**Logs**: `si logs -f api` (JSON lines; no prompts or replies are ever logged). Docker keeps 5 files of 50 MB per service.

**Update**: commit, then run `ops/deploy.sh` again. The api restarts (about 20 seconds at most); connected providers reconnect by themselves and in-flight requests of that moment fail.

**Roll back**: redeploy a previous tag that is still on the VM. Giving `IMAGE_TAG` means "already on the VM": nothing is built or uploaded. The previous tag is printed at the end of every deploy and kept in `.deploy.env.prev`; `docker images 'shareinference-*'` lists the others. A deploy that fails prints the exact rollback command.

```sh
IMAGE_TAG=<previous-tag> ops/deploy.sh
```

(If a release applied a database migration, rolling back the code does not undo it; restore a dump if the old code cannot run on the new schema.)

**Disk**: old images pile up (about 800 MB per release). Remove the ones you will not roll back to: `docker image rm shareinference-api:<tag> shareinference-web:<tag>`.

## Limits worth knowing

- One VM, one api process: a restart briefly drops all providers and queued requests.
- Per-IP limits (600 requests per minute for public routes (`/healthz` exempt), 20 for sign-in, 60 failed authentications (valid keys are never limited), 30 provider connections; IPv6 counts per /64) are in memory and reset on restart. Visitors behind one shared address (a campus, an office) share their allowance.
- The certificate renews itself. Keep ports 80 and 443 open and DNS pointing at the VM.
