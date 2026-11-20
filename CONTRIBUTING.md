# Contributing

## Setup

Requires Docker Engine 25+ with Compose 2.20+, and Node 24 with pnpm (enable it with `corepack enable`).

```sh
pnpm install
cp .env.example .env   # set POSTGRES_PASSWORD (openssl rand -hex 16), GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
docker compose up -d --build
```

The GitHub values come from an OAuth app you create ([`docs/setup.md`](docs/setup.md)). To test signed-in flows without GitHub use `pnpm users dev-session <login>` (dev/test only).

Database tests need `TEST_DATABASE_URL` (an empty database on the bundled Postgres, see `.env.example`); they skip without it.

## Before a pull request

`pnpm lint`, `pnpm test` and `pnpm format:check` must pass.

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
- The project rules and architecture live in [`wiki-llm/`](wiki-llm/index.md); agents and humans follow them, and a change to a flow, contract or rule updates the owning wiki page in the same commit.
- By contributing you agree that your contribution is licensed under [AGPL-3.0](LICENSE).
