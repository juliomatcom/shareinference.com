# AGENTS.md — ShareInference

> Rules for every coding agent in this repository. Overridden only by an explicit user command.

**Source of truth:** start every task at [`wiki-llm/index.md`](wiki-llm/index.md) and open only the page it names. Every project rule lives in [`wiki-llm/conventions.md`](wiki-llm/conventions.md). The plan and decision log (D-numbers) are in [`specs/mvp-plan.md`](specs/mvp-plan.md).

- **Wiki upkeep:** a change to a flow, route, contract, rule or number updates the owning wiki page in the same commit. One fact on one page; replace before appending. `docs/` is for humans and follows the wiki.

## Agent Behavior

- **Public repository:** everything committed is public. Never commit secrets, `.env` files, personal data or local paths; review the staged diff before every commit and push.
- **Decisions:** a decision enters the plan (or wiki) only after it is verified (spike, source/doc check, or explicit user call). Raise only questions that block the next step.
- **Minimum necessary:** build the smallest thing that proves the current phase's check.
- **Delegation:** keep architecture decisions on the main model; dispatch implementation, boilerplate, tests and docs to Sonnet subagents (`model: sonnet`). Every permanent code change ends with a contrarian Sonnet review whose findings are fixed. Throwaway spikes are exempt.
- **Dependencies:** never swap or upgrade a package without asking the user; adding a new one needs no approval. Pin versions.
- **Secrets:** read from env only (one root `.env`); read `.env.example` for names, never print values.
- **Commits:** Conventional Commits.
