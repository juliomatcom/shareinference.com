# FAQ

Short answers to what people usually ask. ShareInference is an **MVP**: it is young, and the limits and credit rates on this page may change as it grows. The **Limits** section at the bottom is the place to check the current numbers.

## The basics

### What is ShareInference?

An open-source network where people lend GPU time from a browser tab and use credits on an OpenAI-compatible API. You can also chat with the models in the **Playground** without writing any code. The API guide is in [Using the API](api.md).

### Do I need a credit card? How do credits work?

No. There is no credit card and no payment of any kind: you sign in with GitHub and that is it. Nobody pays money, and credits cannot be bought. They are earned by sharing your GPU. Everyone can use the network: if you do not share a GPU you have no credits, so your requests wait in a fair queue, slower and with tighter limits, as long as your GitHub account is at least 30 days old. Usage is measured in credits: a request uses 1 credit per input token plus 5 credits per output token, multiplied by the model's credit multiplier (see **Limits** below), and thinking tokens count as output. Credit holders, the people who share, go to the front of the queue and get higher limits. New accounts start with the sign-up grant, which is 0 credits by default, so the Dashboard shows your real balance.

### How do I earn credits?

Share your GPU: open **Share GPU**, pick a model and press **Turn ON**. Every token your browser generates for someone else earns you the same credits that person uses. The steps are in [Share your GPU](contribute.md).

### Why can't I use my own GPU for my own requests?

So nobody can farm credits by talking to themselves. A request is never routed to a GPU you own, so if your GPU is the only one serving a model you get a `503 no_providers` error. Ask a friend to share, or wait for other providers to come online.

## Sharing your GPU

### Which browsers and GPUs work?

A recent desktop Chrome or Edge with WebGPU, opened over HTTPS (or `localhost`). Firefox and Safari are not supported yet. Apple Silicon Macs are tested; recent NVIDIA, AMD and Intel GPUs should work but have not been tested yet. The Share page checks your setup and tells you what is missing.

### Which model should I pick on the Share page?

The one marked **Recommended** is a good default. Bigger models need more video memory (the Share page shows how much) and are slower, but the biggest ones earn more credits per token (see the credit multipliers below). Fewer GPUs can run them. If your computer struggles, pick a smaller one. You can only change the model while sharing is off.

### Is sharing safe for my computer?

The model runs inside your browser's sandbox, like any web page, and cannot read your files. It does use your GPU and electricity, so your fans may spin up and a laptop on battery will drain faster. Press **Stop** (or close the tab) at any time. Also note that the text you serve passes through your machine; see the privacy answer below.

## Using the models

### Is my data private?

Your prompts are processed in a contributor's browser, and ShareInference never stores or logs the prompt or the reply text, only counts, timings and ids. Because a stranger's computer does the work, do not send anything you would not want a stranger's machine to process. The details are in [Privacy](privacy.md) and the [Terms](terms.md).

### Why is a reply slow?

Speed depends on the GPU of whoever serves you. Long conversations are slower because the model re-reads the whole history on every turn. Starting a new chat or using a smaller model helps.

### Why did a reply stop in the middle of a sentence?

It hit the reply limit: the response ends with finish reason `length`. Thinking tokens count toward that limit, so a model that thinks a lot can run out before it finishes the answer. Try turning **Thinking** off, ask for a shorter answer, or raise `max_tokens` on the API (see **Limits** below).

### What is Thinking?

A switch that lets the model reason step by step before it answers. Answers can be better on hard questions, but they take longer and use more credits, because the reasoning tokens count like reply tokens. The Playground starts with it off.

### What happens when no provider is online?

You get `503 no_providers` when nobody is serving that model. You get `503 network_busy` when the queue is full or you waited more than 300 seconds. Both are temporary: try again in a moment, or share your own GPU so more models are online.

### What does `account_too_new` mean?

You have no credits (balance of 0 or below) and your GitHub account is younger than 30 days. The fair queue needs an older account, which keeps bots from creating throwaway accounts. Earn credits by sharing your GPU, or try again once your account is 30 days old.

## Open source

### Is it open source?

Yes, 100%, under the AGPL-3.0 license. The code, the issue tracker and the docs are in the [repository](https://github.com/juliomatcom/shareinference.com).

## Limits

These are the current MVP defaults. They are set in code, so they can change as the network grows; the numbers on this page are the ones to rely on.

| What                                                    | Limit                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context window (prompt plus reply)                      | 16,384 tokens (8,192 for `inkling-2-mini`)                                                                                                                                                                                                                             |
| Reply length on the API (`max_tokens`)                  | Default 4,096, at most 8,192. Prompt plus `max_tokens` must fit the context window                                                                                                                                                                                     |
| Reply length in the Playground                          | 4,096 tokens (2,048 for `inkling-2-mini`); about 12,000 tokens are left for the conversation (about 6,100 for `inkling-2-mini`)                                                                                                                                        |
| Playground message box                                  | 40,000 characters per message, at most 256 messages in a chat                                                                                                                                                                                                          |
| Request size (API)                                      | 256 KiB, 1 to 256 messages, text only                                                                                                                                                                                                                                  |
| Wait for the first token                                | At least 90 seconds, longer for a long prompt: 30 seconds plus the prompt size at the model's minimum speed, up to 80% of the total time (a full 16K prompt on `qwen3.5-9b` can wait about 6 minutes on the API). Then the request is retried once on another provider |
| Total time of one request                               | 10 minutes on the API, 5 minutes in the Playground                                                                                                                                                                                                                     |
| Wait in the queue                                       | 300 seconds, at most 100 queued requests per model                                                                                                                                                                                                                     |
| Rate limit, fair queue (no credits, balance 0 or below) | 10 requests per minute, 500 per day, 1 at a time; GitHub account at least 30 days old                                                                                                                                                                                  |
| Rate limit, credit holders (balance above 0)            | 60 requests per minute, 4 at a time, no daily limit                                                                                                                                                                                                                    |
| API keys                                                | At most 20 active keys per account                                                                                                                                                                                                                                     |
| Sharing                                                 | At most 4 live GPUs per account, one model per browser, one tab per browser                                                                                                                                                                                            |

Credit multipliers (credits per token are multiplied by this):

| Model            | Multiplier |
| ---------------- | ---------- |
| `qwen3.5-2b`     | x1         |
| `qwen3.5-4b`     | x1         |
| `qwen3.5-9b`     | x2         |
| `gemma-4-e2b`    | x1         |
| `inkling-2-mini` | x3         |

Notes:

- Models and multipliers can be added or changed; only models with a provider online are listed by `GET /v1/models`.
- Rate limits count requests that were accepted. Going over them returns `429 rate_limited`.
- Still stuck? Open an issue in the [repository](https://github.com/juliomatcom/shareinference.com).
