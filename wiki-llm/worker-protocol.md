# Provider WebSocket protocol (v1)

Endpoint `GET /v1/worker` on the api's public URL. JSON text frames, one object per frame, each with a `type`. Every inbound frame is validated with zod; an invalid frame closes the socket (4400). Max inbound frame 64 KiB.

## Sequence

1. Browser gets a worker token: `POST /api/worker-token` (session).
2. Opens the socket; first frame within 10 s: `auth { token, protocol: 1, deviceKey }`. `deviceKey` is a random id the browser keeps in `localStorage` (identifies the device row in `workers`). Bad/expired token → close 4401.
3. Server: `welcome { workerId }`.
4. Worker loads the model, runs one tiny warm-up generation, then `ready { model, gpu: { vendor, architecture, shaderF16, maxBufferSize }, loadMs }`. `model` is the WebLLM id; unknown or disabled model → close 4404.
5. Worker sends `heartbeat {}` every 5 s. Silent for 15 s → server drops it.

## Jobs (one at a time per worker)

| Direction       | Frame                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server → worker | `job { id, messages, params }` — params: `temperature`, `top_p`, `max_tokens`, `stop`, `presence_penalty`, `frequency_penalty`, `seed`, `enable_thinking` |
| worker → server | `chunk { id, delta }` — raw text, think tags included                                                                                                     |
| worker → server | `done { id, finishReason, usage: { promptTokens, completionTokens, decodeTokensPerS } }`                                                                  |
| worker → server | `error { id, code, message }`                                                                                                                             |
| server → worker | `cancel { id }` — worker calls `interruptGenerate()`                                                                                                      |
| server → worker | `stats { jobsServed, promptTokens, completionTokens, creditsEarned, lastJob: { completionTokens, decodeTokensPerS, credits } }` after each settled job    |

- Before every job the worker calls `engine.resetChat()` (no KV reuse between jobs).
- The worker maps params to WebLLM: `enable_thinking` → `extra_body.enable_thinking`; streams with `stream_options.include_usage`.
- Frames for an unknown or finished job id are ignored. A second `job` while busy is a server bug: the worker answers `error { code: "busy" }`.
- The provider UI shows live usage from `stats`; it never receives consumer identity.
