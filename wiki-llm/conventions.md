# Conventions

## Hard invariants

- **Dependency rule:** in `apps/api`, `src/core/` holds plain logic and never imports adapters, frameworks (Express, ws, knex, pg), `process`, network or file APIs. Core declares small interfaces (ports); `src/adapters/` implement them; `src/main.ts` only wires. An architecture test enforces it.
- **No ceremony:** a port is one interface; no DTO copies, no class hierarchies; small logic stays plain functions.
- **Deny by default:** every api route requires auth unless it is on the public allowlist in [api.md](api.md). A test asserts every other route returns 401 without credentials.
- **Untrusted provider:** the provider browser is untrusted. Validate every WebSocket message with zod; cap reported usage (see [economy.md](economy.md)); never send consumer identity, API keys, IPs or account ids to a provider.
- **Privacy:** never store or log prompt or completion text. Logs carry ids, counts and timings only.
- **Secrets:** read from env only (one root `.env`); never in source, images, logs, API responses or URLs. Every env var the code reads is listed and documented in `.env.example`; a test enforces it. CI runs gitleaks over the full history; run `gitleaks git .` and `gitleaks dir .` locally before pushing. False positives are allowlisted by path in `.gitleaks.toml` (keep each entry narrow and explained).
- **Money:** credits are integers. Every balance change is a `ledger_entries` row written in the same transaction as the `balances` update; the ledger is append-only.
- **Bounded everything:** every queue, buffer, body, message and timeout has an explicit limit.
- **Public repository:** assume attackers read the code; security comes from server-side checks, never from client secrecy.
- **CSP (deferred, post-MVP):** the web app sends no `Content-Security-Policy` yet (the api's Helmet CSP covers only its own JSON). The Share page loads the self-hosted engine (same origin, no CDN), model files from Hugging Face, wasm and a module Web Worker, so a policy needs careful testing on real GPU devices; it is an explicit deferral, not an oversight (D39).

## Code

- TypeScript strict, ESM, Node 24. No `any` in `core`. Validation with zod at the edges.
- Formatting: Prettier (width 120). CI fails on unformatted files.
- Logging: one JSON line per event through the shared `@shareinference/logger`; format, rules and what is logged in [logging.md](logging.md). No `console.*` elsewhere.
- Comments explain why, not what.
- Dependencies: pinned versions; never swap or upgrade one without asking the user.

## Tests

- Test what breaks the product when wrong: architecture rule, auth gating, ledger and settlement math, routing and queue rules, protocol validation. No tests for UI styling or copy.
- api tests run with vitest; tests needing Postgres use `TEST_DATABASE_URL` and skip when it is unset.

## Definition of done (per phase)

- `pnpm lint` (typecheck), `pnpm test`, `pnpm format:check` pass; `docker compose up -d --build` starts healthy.
- The phase's check in `specs/mvp-plan.md` passes and is noted in its log.
- Owning wiki pages updated; `docs/` updated where users are affected.
- Contrarian review by a Sonnet subagent done and its findings fixed.
