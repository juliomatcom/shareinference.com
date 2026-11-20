# Using the API

ShareInference speaks the OpenAI chat completions protocol, so any OpenAI client works: point it at `<API_PUBLIC_URL>/v1` (`https://api.shareinference.com/v1` on the hosted instance) and use a ShareInference API key. The authoritative technical reference is [`wiki-llm/api.md`](../wiki-llm/api.md); if the two disagree, the wiki wins.

## Get a key

Sign in, open the dashboard and create an API key under **API keys**. It starts with `si_` and is shown once. Keep it secret: anyone holding it spends your credits.

The examples use the hosted instance, `https://api.shareinference.com`, and `$SI_KEY` for the key. On your own install use your `API_PUBLIC_URL` instead (`http://localhost:4401` by default).

Want to try it first? The **Playground** (signed in, no key needed) lets you chat with an online model in the browser and shows tokens, latency, speed and credits for every reply. It spends credits exactly like an API call.

## Credits, in short

A request costs `(prompt tokens × 1 + completion tokens × 5)` credits and the provider that served it earns the same amount. You earn credits by sharing your GPU on the **Share** page. Your balance may go below zero: you are then in the _fair lane_, served after everyone with credits, and only if your GitHub account is at least 30 days old. See the [economy](../wiki-llm/economy.md) page for the rules.

## List models

```sh
curl https://api.shareinference.com/v1/models -H "Authorization: Bearer $SI_KEY"
```

Only models with at least one provider online are listed.

## Chat completion

```sh
curl https://api.shareinference.com/v1/chat/completions \
  -H "Authorization: Bearer $SI_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.5-4b",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}],
    "max_tokens": 256
  }'
```

The answer is a normal `chat.completion` with `usage`. Add `"stream": true` (and curl's `-N`) to receive server-sent events ending with `data: [DONE]`; add `"stream_options": {"include_usage": true}` to get a final usage chunk.

### With the OpenAI SDK

```js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.SI_KEY, baseURL: "https://api.shareinference.com/v1" });

// Non-streaming
const res = await client.chat.completions.create({
  model: "qwen3.5-4b",
  messages: [{ role: "user", content: "Say hello in one sentence." }],
});
console.log(res.choices[0].message.content, res.usage);

// Streaming
const stream = await client.chat.completions.create({
  model: "qwen3.5-4b",
  messages: [{ role: "user", content: "Count to five." }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

Python works the same way: `OpenAI(api_key=..., base_url="https://api.shareinference.com/v1")`.

### What is accepted

`model`, `messages` (roles `system`, `user`, `assistant`; text content only), `stream`, `stream_options.include_usage`, `temperature`, `top_p`, `max_tokens` (default 1024, at most 2048), `stop`, `presence_penalty`, `frequency_penalty`, `seed`, and `enable_thinking` (also read from `chat_template_kwargs.enable_thinking`). Any other field is rejected with a `400`. Requests are limited to 256 KiB, and the prompt plus `max_tokens` must fit the model's context window.

Models that "think" first put that reasoning in `reasoning_content` (on the message, or as stream deltas) and keep it out of `content`. Thinking tokens are billed as output.

## Errors

Errors use the OpenAI shape: `{"error": {"message", "type", "code"}}`.

| Status | `code`                         | Meaning                                                                                                         |
| ------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`              | Unknown field, bad value, or messages too long                                                                  |
| 401    | `unauthorized`                 | Missing, wrong or revoked key (a browser session does not work on `/v1`)                                        |
| 403    | `account_too_new`              | No credits and your GitHub account is younger than 30 days                                                      |
| 404    | `model_not_found`              | Unknown model id                                                                                                |
| 429    | `rate_limited`                 | Too many requests. Fair lane: 10 per minute, 500 per day, 1 at a time. With credits: 60 per minute, 4 at a time |
| 502    | `provider_failed`              | The provider failed twice before answering (or failed mid-stream)                                               |
| 503    | `network_busy`, `no_providers` | The queue is full or you waited 30 s; or no provider is online for the model                                    |

If a provider fails after it has started answering, a stream ends with one `data: {"error": ...}` event and you are not charged. If you close the connection, the request is cancelled: before any output arrived you are not charged; after it, you pay for the tokens you received.

## Request history and votes

The dashboard lists your requests with tokens, credits and status. Once a request has succeeded it shows which provider served it, and you can vote 👍 or 👎 for that provider. Votes are private: only you see them. The same data is available to a signed-in browser at `GET /api/jobs`.
