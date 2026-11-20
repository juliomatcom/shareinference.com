# AGENTS.md — ShareInference

> Rules for every coding agent in this repository. Overridden only by an explicit user command.

**Source of truth:** until `wiki-llm/` exists (plan Phase 1), read [`specs/mvp-plan.md`](specs/mvp-plan.md) first. After that, start every task at `wiki-llm/index.md`.

## Agent Behavior

- **Public repository:** everything committed is public. Never commit secrets, `.env` files, personal data or local paths; review the staged diff before every commit and push.
- **Decisions:** a decision enters the plan (or wiki) only after it is verified (spike, source/doc check, or explicit user call). Raise only questions that block the next step.
- **Minimum necessary:** build the smallest thing that proves the current phase's check.
- **Delegation:** keep architecture decisions on the main model; dispatch implementation, boilerplate, tests and docs to Sonnet subagents (`model: sonnet`). Every permanent code change ends with a contrarian Sonnet review whose findings are fixed. Throwaway spikes are exempt.
- **Dependencies:** never swap or upgrade a package without asking the user; adding a new one needs no approval. Pin versions.
- **Secrets:** read from env only (one root `.env`); read `.env.example` for names, never print values.
- **Commits:** Conventional Commits.
