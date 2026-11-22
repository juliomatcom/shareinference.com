# Privacy

_Draft - last updated 2026-11-20_

ShareInference runs inference on contributors' machines, so it is worth being precise about who can see what. The authoritative rules are in the project wiki (`wiki-llm/conventions.md`, `wiki-llm/economy.md`); if they disagree with this page, the wiki wins. Questions, access or deletion requests: see [Contact](#contact).

## What we store

- **Your account** (from GitHub sign-in): GitHub numeric id, login, avatar URL and the date the GitHub account was created (used for the free-tier age rule). We ask for the `read:user` scope only and never see your GitHub password.
- **Your settings:** a display name (public, defaults to your GitHub login) and an optional device label.
- **API keys:** only a SHA-256 hash and a short display prefix. The full key is shown once, when you create it.
- **Credits:** an append-only ledger of balance changes and your balance.
- **Request metadata:** for each request, ids, model, token counts, credits, timings, status and which provider served it. **Never the prompt or the answer text.**
- **Provider devices:** a random device id from your browser, the GPU vendor and architecture the browser reports, the last model loaded and when the device was last seen.
- **Logs:** ids, counts and timings, never message content or keys.

We do not sell or share your data, and we do not use analytics, advertising or tracking scripts.

## Cookies

Two cookies, both strictly necessary and both `HttpOnly`:

- `si_session`: keeps you signed in (30 days, or until you sign out).
- `si_oauth_state`: protects the GitHub sign-in (10 minutes, single use).

Your browser's `localStorage` holds a random device id for providers (`si_device_key`) and a note that you dismissed the cookie banner (`si_cookie_note`). Nothing is used for tracking.

## If you share your GPU (contributor)

- Requests from other users are processed **inside your browser**, in a Web Worker on your GPU. The Share page never displays who asked or what was asked, and it never receives the consumer's identity, API key, IP address or account id.
- Be aware that the prompt text does pass through your machine. A technically skilled person could read it with the browser's developer tools. The interface simply never shows it. Share your GPU only if you are comfortable with that, and never log, keep, copy or use what you see (see the [terms](terms.md)).
- You see your own live usage: jobs served, input and output tokens, tokens per second and credits earned.
- The inference engine is served from ShareInference's own origin (no third-party CDN). Model files are downloaded from Hugging Face.

## If you use the API (consumer)

- Routing is random and blind: you choose a model, never a provider. Providers never learn who you are.
- The provider's public name is shown to you **only after the job has ended**, in your request history ("served by"). It is never shown during the stream.
- Your prompt and the answer pass through a contributor's browser (see above). Avoid sending anything you would not want a stranger's machine to process.

## What is public

The home page, the leaderboard and the model catalog are public and read-only. They show aggregates and opt-in fields only:

- Totals: tokens served, jobs served, active GPUs, models online.
- Per top provider: display name (your GitHub login unless you set another in Settings), GPU vendor and architecture as reported by the browser (for example "apple metal-3"), the optional device label from Settings, the model last hosted, tokens served, credits earned, average speed and whether you are online.

Never public: user ids, API keys, balances, ledger, request history, consumer identity or any prompt or completion text.

## Retention and deletion

Account, ledger and request metadata are kept while your account exists, because the credit ledger must stay consistent. You can ask for your data to be deleted, or for a copy, through the [contact](#contact) below. Credit entries that involve other users may be anonymised rather than removed.

## Contact

Open an issue in the project's GitHub repository, or for anything sensitive follow [`SECURITY.md`](../SECURITY.md) (private vulnerability reports).
