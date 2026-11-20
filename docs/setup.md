# Self-hosting guide

This walks you through running your own ShareInference on one machine with Docker. The authoritative technical reference is [`wiki-llm/setup.md`](../wiki-llm/setup.md); if the two ever disagree, the wiki wins.

## What you need

- Docker Engine 25+ with Docker Compose 2.20+.
- A GitHub account (sign-in is GitHub only, so you need to register a small OAuth app).
- For development or the admin commands: Node 24 and pnpm (`corepack enable`).

## 1. Configure

```sh
cp .env.example .env
```

Open `.env` and set:

| Variable                                   | What to put                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `POSTGRES_PASSWORD`                        | Any password without `$`: `openssl rand -hex 16` works well. It is fixed when the database is first created. |
| `WEB_ORIGIN`                               | The address people open in the browser. Default `http://localhost:4400`. No path, no trailing slash.         |
| `API_PUBLIC_URL`                           | The address of the api. Default `http://localhost:4401`.                                                     |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | From the GitHub OAuth app in the next step.                                                                  |
| `SIGNUP_GRANT_CREDITS` (optional)          | Free credits every new user gets, e.g. `100`. Default `0`.                                                   |

`.env` holds secrets and is never committed. Everything else is optional and explained inside `.env.example`.

## 2. Create the GitHub OAuth app

1. On GitHub open **Settings -> Developer settings -> OAuth Apps -> New OAuth App**.
2. **Homepage URL**: the same as `WEB_ORIGIN` (for example `http://localhost:4400`).
3. **Authorization callback URL**: `WEB_ORIGIN` followed by `/api/auth/github/callback`, for example `http://localhost:4400/api/auth/github/callback`.
4. Register the app, copy the **Client ID** into `GITHUB_CLIENT_ID`, then choose **Generate a new client secret** and copy it into `GITHUB_CLIENT_SECRET`.

If you later change the host or port in `WEB_ORIGIN`, update the callback URL on GitHub too.

## 3. Start

```sh
docker compose up -d --build
```

Open `WEB_ORIGIN`, choose **Sign in with GitHub**, and you land on your dashboard: credit balance, API keys (a new key is shown once, so copy it), and the ledger. **Settings** lets you pick a public display name and a device label.

Database migrations run by themselves when the api starts. Your data lives in the `db-data` Docker volume: it survives restarts and `docker compose down`; only `docker compose down -v` deletes it.

The ports are published on `127.0.0.1` only. If you run the stack inside a virtual machine and reach it from the host through port forwarding, set `BIND_ADDR` in `.env` to the VM's network address; never set it to `0.0.0.0` on a public machine. To serve other people you need HTTPS in front: the [deployment guide](deploy.md) sets up Caddy for a VM; `WEB_ORIGIN` must then be your `https://` address.

## 4. Admin commands

Run from the repository root while the stack is up (they execute inside the api container):

```sh
pnpm users list                              # everyone, with balance and status
pnpm users suspend alice                     # block an account everywhere
pnpm users unsuspend alice
pnpm users throttle alice 5 100              # per-minute and per-day request limit
pnpm credit alice 100 "welcome bonus"        # add credits (negative amount removes them), with a reason
pnpm ledger alice                            # that user's credit history
pnpm ledger:check                            # verify every balance matches its ledger entries
```

`alice` can be a GitHub login or a display name.

### Trying things without GitHub (development only)

```sh
curl -b "si_session=$(pnpm users dev-session alice)" http://localhost:4400/api/me
```

`dev-session` creates a local test user and prints a session token you can use as the `si_session` cookie. It exists for local testing only: anyone holding a token is signed in as that user, so do not use it on a server other people can reach. It only serves test users it created itself, never a real GitHub account.

## Troubleshooting

- **Writes fail with 403 `csrf` (sign out, creating a key, saving settings)**: the address in the browser must equal `WEB_ORIGIN` exactly. Open the site through the same host and port as in `.env` (for example the `localhost` forward, not the VM's IP address).
- **The api container restarts and logs "Invalid configuration"**: a required variable in `.env` is empty. The message names it.
- **"Sign-in failed" after returning from GitHub**: the callback URL on the OAuth app does not exactly match `WEB_ORIGIN` plus `/api/auth/github/callback`, or the client secret is wrong.
- **Changed `POSTGRES_PASSWORD` and the database refuses the login**: the password is fixed when the volume is created; reset with `docker compose down -v` (this deletes data).
