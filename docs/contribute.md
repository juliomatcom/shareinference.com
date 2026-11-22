# Share your GPU

ShareInference runs on GPUs that people lend it. When you open the **Share GPU** page and press **Turn ON**, your browser downloads a language model, keeps it on your graphics card, and uses it to generate answers for other users. Every token you serve earns you credits, which you can use on the OpenAI-compatible API.

## What you need

- A desktop **Chrome or Edge** (recent version) with WebGPU. Check by opening the Share page: it tells you what is missing.
- A GPU with 16-bit shader support and roughly 3.5 GB of free video memory for the recommended model (smaller and larger models are listed on the Share page with what they need; the largest, Inkling-2-Mini, needs about 14 GB: a 16 GB GPU or a Mac with 24 GB or more). Apple Silicon Macs are tested; recent NVIDIA, AMD and Intel GPUs should work but have not been tested yet.
- The page opened over **HTTPS** or on `localhost`. WebGPU does not work on a plain-HTTP address.
- A download of the model file the first time (about 1.3 to 13.3 GB depending on the model). The model is cached in your browser, so later starts take seconds.

## How it works

1. Sign in with GitHub and open **Share GPU**.
2. Pick a model (the recommended one is selected) and press **Turn ON**. You cannot change the model while sharing. You see the model loading, then the status **Ready**.
3. Leave the tab open. You can browse other pages of the site meanwhile: sharing keeps running, and a bar at the bottom shows your status and credits earned. While the tab is visible the page keeps your screen awake. If the connection drops it reconnects by itself.
4. Press **Stop** (on the Share page or in the bottom bar) whenever you like. Closing the tab stops sharing too.

The page shows live usage: requests served, tokens processed, your last speed in tokens per second, and credits earned. Credits arrive once requests are served; until then these numbers stay at zero.

## What you earn

Credits for every token you generate for someone else. The exact rates are in the economy rules of the project wiki (`wiki-llm/economy.md`). Your own requests are never sent to your own GPU, so you cannot earn by talking to yourself.

## Privacy

- Requests from other users are processed **in your browser**. The Share page never shows who asked or what was asked, and ShareInference stores no prompt or answer text.
- Be aware that a technically skilled person could read the text with the browser's developer tools, because it passes through your machine. Share only if you are comfortable with that.
- The Share page runs its inference engine from ShareInference's own origin, so no third-party CDN supplies code to your tab. The model file itself is downloaded from Hugging Face.
- ShareInference never sends you anyone's identity, API key or IP address.
- Your GPU's vendor and architecture (for example "apple / metal-3") and an optional device label from Settings may appear on the public leaderboard. Your display name is public too.

## Troubleshooting

- _"WebGPU needs a secure context"_: use `https://` or `http://localhost`.
- _"No WebGPU"_: update Chrome or Edge; Firefox and Safari are not supported yet.
- _"Already connected from another tab"_: the same browser profile can share from one tab only. Close the other one.
- _"Too many workers"_: an account can share from at most four devices at once.
