# wiki-llm index

ShareInference: an open-source inference network. Providers share GPU compute from a browser tab: wllama (llama.cpp WebGPU, GGUF models) runs a model inside a Web Worker that holds a WebSocket to the api. Consumers call an OpenAI-compatible API (`/v1/chat/completions`) with an API key. The api is CPU-only: it authenticates, queues, routes each request to one random idle provider with that model loaded, streams tokens back, and settles credits in a Postgres ledger (consumer spend = provider earn). Everything is gated by GitHub sign-in except read-only public pages and aggregate stats.

This wiki is the source of truth for agents. Code follows it; a change to a flow, contract, rule or number updates the owning page in the same commit. `docs/` is friendly human documentation and follows this wiki. `specs/mvp-plan.md` holds the plan, decision log (D-numbers) and verification history.

| Page                                     | Open it for                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| [conventions.md](conventions.md)         | Every project rule: architecture, security, code, tests, definition of done               |
| [architecture.md](architecture.md)       | Components, compose services, request lifecycle, routing and queues, failure rules        |
| [api.md](api.md)                         | HTTP contract: auth (GitHub, sessions, API keys, worker tokens), routes, errors, limits   |
| [worker-protocol.md](worker-protocol.md) | Provider WebSocket protocol: messages, heartbeat, job lifecycle                           |
| [economy.md](economy.md)                 | Credits, prices, settlement, free tier and negative balances, anti-abuse rules            |
| [data-model.md](data-model.md)           | Tables, invariants, what is never stored                                                  |
| [web.md](web.md)                         | `apps/web`: pages, public vs gated, design reference, provider Share page                 |
| [logging.md](logging.md)                 | Shared logger library, JSON envelope, `LOG_LEVEL`, what is logged, what never is          |
| [setup.md](setup.md)                     | `.env` variables, compose services and profiles, CLI commands, engine build (wllama fork) |
