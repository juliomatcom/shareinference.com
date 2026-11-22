// Browser gate for the engine: serves the synced engine files, runs them inside a Worker in headless system Chrome
// (stock flags: real providers run stock Chrome) and drives the page over the DevTools Protocol.
// Env: CHECK_MODEL (ggufRef, default qwen3.5-2b), CHECK_CASES (for example "A,B,G,H"), CHECK_CONTEXT (default 16384),
// CHECK_STOCK=1 (first load without the shader patch, diagnosis), CHECK_PREFILL_TOKENS (case P, default 14000 or what fits), CHECK_CHROME (browser binary), CHECK_PROFILE_DIR (reuse a profile so model downloads survive; never deleted here),
// CHECK_FORCE_PROFILE=raw (diagnosis: skip the model adapter so case S prints the model's raw markup).
// Case S is opt-in: it prints one normalised sample with thinking on and one with it off.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(here, "../../../apps/web/public/engine");
const pageRoot = path.join(here, "check-page");
const MODELS = {
  "qwen3.5-2b": "unsloth/Qwen3.5-2B-GGUF@f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf",
  "qwen3.5-4b": "unsloth/Qwen3.5-4B-GGUF@e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf",
  "qwen3.5-9b": "unsloth/Qwen3.5-9B-GGUF@3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf",
  "gemma-4-e2b": "unsloth/gemma-4-E2B-it-GGUF@0314792d7f1f7e229411f620751375812bb9faf2/gemma-4-E2B-it-Q4_K_M.gguf",
  // Needs CHECK_CONTEXT=8192: the default 16384 does not fit a 16 GB GPU with this model.
  inkling:
    "bartowski/thinkingmachines_Inkling-2-Mini-GGUF@76d57028717ed7c63f5e90de75234cae0bc9b360/thinkingmachines_Inkling-2-Mini-IQ3_XXS.gguf",
};
const modelEnv = process.env.CHECK_MODEL ?? "qwen3.5-2b";
const REF = MODELS[modelEnv] ?? modelEnv;
const CONTEXT = Number(process.env.CHECK_CONTEXT) || 16384;
const ALL_CASES = "ABCDEFGHIJK".split("");
const CASES = new Set(
  (process.env.CHECK_CASES ?? ALL_CASES.join(","))
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean),
);
const CHROME =
  process.env.CHECK_CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(
    existsSync,
  );
const say = (text) => process.stdout.write(`${text}\n`);

// ---- prompts ----------------------------------------------------------------------------------------------------

const WORDS = (
  "river stone window garden morning engine paper silver forest bridge letter market winter candle harbor mirror " +
  "thunder meadow lantern copper ribbon valley orchard pencil island canvas feather marble village kettle anchor " +
  "pepper sunset tunnel blanket compass violin saddle cabin ladder meadow button pillow rocket castle puzzle " +
  "turtle jungle desert glacier planet comet signal cipher beacon quartz amber cedar maple willow clover thistle"
).split(" ");
// Measured with the Qwen tokenizer on this generator's output; adjust if prompts drift out of range.
const TOKENS_PER_WORD = Number(process.env.CHECK_TOKENS_PER_WORD) || 1.38;

function notes(tokens, salt) {
  let seed = (salt * 7919 + 17) >>> 0;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const lines = [];
  for (let n = 0, words = Math.round(tokens / TOKENS_PER_WORD); n < words;) {
    const sentence = Array.from({ length: 10 }, () => WORDS[Math.floor(next() * WORDS.length)]);
    lines.push(`${sentence.join(" ")}.`);
    n += 10;
  }
  return lines.join("\n");
}

// Cases G, H and P fill the window; a smaller one (Inkling runs at 8192) scales them down, 14000 stays as is at 16384.
const FILL = Math.min(14000, CONTEXT - 1500);
const user = (content) => [{ role: "user", content }];
const long = (tokens, salt = 1) =>
  user(`Read these notes, then answer with one short sentence.\n\n${notes(tokens, salt)}`);
const SHORT = user("Say hello in one short sentence.");

// ---- static server ----------------------------------------------------------------------------------------------

const TYPES = { ".js": "text/javascript", ".html": "text/html", ".wasm": "application/wasm" };

function serve() {
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const [root, rel] = pathname.startsWith("/engine/")
      ? [engineRoot, pathname.slice("/engine/".length)]
      : [pageRoot, pathname === "/" ? "index.html" : pathname.slice(1)];
    const file = path.resolve(root, rel);
    const headers = {
      "cache-control": "no-store",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "credentialless",
    };
    if (!file.startsWith(root + path.sep)) return res.writeHead(403, headers).end();
    try {
      const body = await readFile(file);
      res
        .writeHead(200, { ...headers, "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" })
        .end(body);
    } catch {
      res.writeHead(404, headers).end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---- DevTools Protocol -------------------------------------------------------------------------------------------

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = [];
  constructor(ws) {
    this.#ws = ws;
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const { resolve, reject } = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message}`));
        else resolve(message.result);
      } else {
        for (const listener of this.#listeners) listener(message);
      }
    };
    ws.onclose = () => {
      for (const { reject } of this.#pending.values()) reject(new Error("Chrome closed the DevTools connection"));
      this.#pending.clear();
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("DevTools connection failed"));
    });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  on(listener) {
    this.#listeners.push(listener);
  }
}

async function launchChrome(profile) {
  if (!CHROME) throw new Error("No Chrome found; set CHECK_CHROME.");
  // A reused profile still holds the previous run's port file.
  await rm(path.join(profile, "DevToolsActivePort"), { force: true });
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) {
      const [port, wsPath] = (await readFile(portFile, "utf8")).split("\n");
      if (wsPath) return { child, url: `ws://127.0.0.1:${port}${wsPath}` };
    }
    await sleep(100);
  }
  throw new Error("Chrome did not expose a DevTools port.");
}

// ---- helpers -----------------------------------------------------------------------------------------------------

const results = [];
const record = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail });
  say(`${pass ? "PASS" : "FAIL"} ${id} ${name}: ${detail}`);
};
const num = (n) => (typeof n === "number" ? Math.round(n * 10) / 10 : n);

async function main() {
  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}/`;
  const profile = process.env.CHECK_PROFILE_DIR ?? (await mkdtemp(path.join(os.tmpdir(), "si-engine-check-")));
  const ownsProfile = !process.env.CHECK_PROFILE_DIR;
  let chrome = null;
  const cleanup = async () => {
    chrome?.kill("SIGKILL");
    server.close();
    if (ownsProfile) {
      await sleep(500);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  };
  process.on("SIGINT", () => cleanup().finally(() => process.exit(130)));

  try {
    say(`model ${modelEnv} (${REF})\ncontext ${CONTEXT}, cases ${[...CASES].sort().join(",")}`);
    const launched = await launchChrome(profile);
    chrome = launched.child;
    const cdp = await Cdp.connect(launched.url);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    cdp.on((m) => {
      if (m.method === "Runtime.exceptionThrown") say(`  [page exception] ${m.params.exceptionDetails.text}`);
    });

    const evaluate = async (expression) => {
      const out = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? "evaluate failed");
      return out.result.value;
    };
    const call = async (message) => {
      const reply = await evaluate(`__si.call(${JSON.stringify(message)})`);
      if (!reply.ok) throw new Error(reply.error);
      return reply.data;
    };
    const job = (messages, params = {}, abort = {}) =>
      call({ op: "job", messages, params: { temperature: 0, seed: 42, ...params }, ...abort });
    const navigate = async () => {
      const loaded = new Promise((resolve) =>
        cdp.on((m) => m.method === "Page.loadEventFired" && m.sessionId === sessionId && resolve()),
      );
      await cdp.send("Page.navigate", { url: origin }, sessionId);
      await loaded;
      for (let i = 0; i < 100 && !(await evaluate("globalThis.__si?.ready === true")); i++) await sleep(100);
    };
    const load = async (stock) => {
      let timer = setInterval(async () => {
        try {
          const p = await evaluate("__si.progress");
          if (p) say(`  ... ${p.text} ${Math.round((p.progress ?? 0) * 100)}%`);
        } catch {
          // page busy or navigating
        }
      }, 20_000);
      const t0 = Date.now();
      try {
        const info = await call({
          op: "load",
          ref: REF,
          contextWindow: CONTEXT,
          stock,
          forceProfile: process.env.CHECK_FORCE_PROFILE,
        });
        const { logs } = await call({ op: "logs" });
        return { ...info, logs, loadMs: Date.now() - t0 };
      } catch (e) {
        // The engine's own lines (llama.cpp / WebGPU) say why a load failed.
        const { logs } = await call({ op: "logs" }).catch(() => ({ logs: [] }));
        for (const l of logs.slice(-30)) say(`  [engine] ${l.trim()}`);
        throw e;
      } finally {
        clearInterval(timer);
      }
    };
    const ok = (r) => r.error === null && r.result && r.result.finishReason !== "abort";
    let shortDetail = "";
    const shortWorks = async () => {
      const r = await job(SHORT, { max_tokens: 16 });
      shortDetail = r.error
        ? `error ${r.error}`
        : `finish ${r.result?.finishReason}, ${r.result?.usage?.completionTokens} completion tokens, ${Math.round(r.totalMs)} ms`;
      return ok(r) && r.result.usage.completionTokens > 0;
    };

    // Phase 1: patched shaders.
    await navigate();
    const info = await load(process.env.CHECK_STOCK === "1");
    say(`loaded in ${Math.round(info.loadMs / 1000)}s, n_ctx ${info.contextWindow}, profile ${info.profile}`);
    say("native memory log:");
    for (const l of info.logs.filter((l) => /buffer size|offloaded/i.test(l))) say(`  ${l.trim()}`);

    const offloaded = info.logs.map((l) => /offloaded (\d+)\/(\d+)/.exec(l)).find(Boolean);
    const run = async (id, name, fn) => {
      if (!CASES.has(id)) return;
      try {
        const [pass, detail] = await fn();
        record(id, name, pass, detail);
      } catch (e) {
        record(id, name, false, `threw: ${e.message}`);
      }
    };

    await run("A", "Environment", async () => [
      info.isolated === true && !!offloaded && offloaded[1] === offloaded[2],
      `crossOriginIsolated=${info.isolated}, offloaded ${offloaded ? `${offloaded[1]}/${offloaded[2]}` : "line missing"}`,
    ]);
    await run("B", "Patch active", async () => [
      info.shaderPatch.applied > 0 && info.shaderPatch.skipped === 0,
      `applied=${info.shaderPatch.applied}, skipped=${info.shaderPatch.skipped}`,
    ]);

    let patchedText = null;
    if (CASES.has("C")) {
      const r = await job(long(2500, 1), { max_tokens: 64 });
      patchedText = r.text;
      say(
        `  C patched run: ${r.error ?? `${r.result.usage.promptTokens} prompt tokens, ${r.result.usage.completionTokens} generated`}`,
      );
    }

    await run("D", "No KV reuse (D27)", async () => {
      const a = await job(long(2500, 1), { max_tokens: 8 });
      const b = await job(long(2500, 1), { max_tokens: 8 });
      if (a.error || b.error) return [false, `error ${a.error ?? b.error}`];
      const [x, y] = [a.result, b.result];
      return [
        x.cachedTokens === 0 &&
          y.cachedTokens === 0 &&
          x.usage.promptTokens === y.usage.promptTokens &&
          x.usage.promptTokens > 0,
        `cachedTokens ${x.cachedTokens}/${y.cachedTokens}, promptTokens ${x.usage.promptTokens}/${y.usage.promptTokens}`,
      ];
    });

    // Every profile (profiles.js) must hand the api `<think>…</think>` and nothing of the model's own markup.
    const RAW_MARKUP = /<\|[a-z_]+\|>|<\|channel>|<channel\||<turn\|>/;
    const normalised = (text, finish) =>
      /^\s*<think>/.test(text) && !RAW_MARKUP.test(text) && (finish === "length" || /<\/think>\s*\S/.test(text));
    await run("E", "Hold-back and think form", async () => {
      const off = await job(long(2500, 2), { max_tokens: 32, enable_thinking: false });
      if (off.error) return [false, `error ${off.error}`];
      const decodeMs =
        ((off.result.usage.completionTokens - 1) / Math.max(off.result.usage.decodeTokensPerS, 1)) * 1000;
      const prefillMs = off.totalMs - decodeMs;
      const emptyThink = /^\s*<think>\s*<\/think>\s*$/.test(off.text.slice(0, 40)) || off.text.trim() === "";
      const late = off.firstDeltaMs >= prefillMs * 0.8;
      const offClean = !RAW_MARKUP.test(off.text);
      // Thinking on: reasoning must arrive wrapped, closed and followed by an answer (unless the token cap cut it).
      const on = await job(long(500, 3), { max_tokens: 768, enable_thinking: true });
      const onForm = !on.error && normalised(on.text, on.result.finishReason);
      return [
        !emptyThink && late && offClean && onForm,
        `off: firstDelta ${num(off.firstDeltaMs)} ms vs prefill ~${num(prefillMs)} ms, starts ${JSON.stringify(off.text.slice(0, 24))}, clean ${offClean}; on: ${on.error ?? `starts ${JSON.stringify(on.text.slice(0, 24))}, finish ${on.result.finishReason}, <think> form ${onForm}`}`,
      ];
    });

    // Opt-in: one normalised sample per thinking setting, for reading by a human.
    await run("S", "Sample", async () => {
      const ask = user("What is the capital of France? Answer in one sentence.");
      const lines = [];
      let good = true;
      for (const enable_thinking of [true, false]) {
        const r = await job(ask, { max_tokens: 1024, enable_thinking });
        if (r.error) return [false, `error ${r.error}`];
        // With thinking off a model may or may not reason (Inkling always does): only the markup must be clean.
        good &&= process.env.CHECK_FORCE_PROFILE
          ? true
          : enable_thinking
            ? normalised(r.text, r.result.finishReason)
            : r.text.trim() !== "" && !RAW_MARKUP.test(r.text);
        lines.push(
          `thinking ${enable_thinking ? "on" : "off"}: ${r.result.usage.completionTokens} tokens, finish ${r.result.finishReason}, first delta ${num(r.firstDeltaMs)} ms\n${r.text}`,
        );
      }
      say(`  ----- sample -----\n${lines.join("\n  ----- next -----\n")}\n  ----- end -----`);
      return [good, "printed above"];
    });

    await run("F", "Stop in decode", async () => {
      const r = await job(
        user("Write a very long story about a dragon."),
        { max_tokens: 512, enable_thinking: false },
        { abortAfterDeltas: 8 },
      );
      if (r.error) return [false, `error ${r.error}`];
      const next = await shortWorks();
      return [
        r.result.finishReason === "abort" &&
          r.returnedAfterAbortMs < 10_000 &&
          r.result.usage.completionTokens > 0 &&
          next,
        `finish ${r.result.finishReason}, returned ${num(r.returnedAfterAbortMs)} ms after abort, completionTokens ${r.result.usage.completionTokens}, next job ${next}`,
      ];
    });

    await run("G", "Stop in prefill", async () => {
      // CHECK_G_TRIES > 1 repeats the stop and prints every time (diagnosis only); the verdict is the first try's.
      const tries = [];
      for (let i = 0; i < (Number(process.env.CHECK_G_TRIES) || 1); i++) {
        tries.push(await job(long(FILL, 4 + i * 10), { max_tokens: 16 }, { abortAfterMs: 2000 }));
      }
      const r = tries[0];
      if (r.error) return [false, `error ${r.error}`];
      const next = await shortWorks();
      return [
        r.result.finishReason === "abort" && r.returnedAfterAbortMs < 10_000 && next,
        `finish ${r.result.finishReason}, returned ${tries.map((t) => num(t.returnedAfterAbortMs)).join("/")} ms after abort, prompt total seen ${r.result.usage.promptTokens}, next job ${next}`,
      ];
    });

    await run("H", "Long jobs in a row", async () => {
      const notesOut = [];
      for (const salt of [5, 6]) {
        const r = await job(long(FILL, salt), { max_tokens: 16 });
        const good = ok(r) && r.result.usage.completionTokens > 0;
        notesOut.push(
          r.error
            ? `error ${r.error}`
            : `${r.result.usage.promptTokens} prompt tokens in ${Math.round(r.totalMs / 1000)}s (${r.result.finishReason})`,
        );
        if (!good) return [false, notesOut.join("; ")];
      }
      const next = await shortWorks();
      return [next, `${notesOut.join("; ")}; short job ${next} (${shortDetail})`];
    });

    // Opt-in (CHECK_CASES=P, not in the default run): prefill speed near a full context, for MIN_PREFILL_TPS.
    await run("P", "Prefill speed", async () => {
      const tokens = Number(process.env.CHECK_PREFILL_TOKENS) || FILL;
      const speeds = [];
      for (const salt of [21, 22]) {
        const r = await job(long(tokens, salt), { max_tokens: 1 });
        if (r.error) return [false, `error ${r.error}`];
        speeds.push(
          `${r.result.usage.promptTokens} tokens in ${num(r.totalMs / 1000)}s = ${num((r.result.usage.promptTokens / r.totalMs) * 1000)} tok/s`,
        );
      }
      return [true, speeds.join("; ")];
    });

    await run("I", "Params", async () => {
      const ask = user("Count from 1 to 20 separated by commas, nothing else.");
      // A model that always reasons (Inkling) needs room to finish its <think> block before the answer starts.
      const stopped = await job(ask, { max_tokens: 600, stop: ["5"], enable_thinking: false });
      const penalised = await job(ask, {
        max_tokens: 16,
        presence_penalty: 0.5,
        frequency_penalty: 0.5,
        enable_thinking: false,
      });
      if (stopped.error || penalised.error) return [false, `error ${stopped.error ?? penalised.error}`];
      return [
        !stopped.text.includes("5") && stopped.text.includes("4") && ok(penalised),
        `stop output ${JSON.stringify(stopped.text.slice(0, 30))} (finish ${stopped.result.finishReason}); penalties ${penalised.result.finishReason}`,
      ];
    });

    await run("J", "Over context", async () => {
      const r = await job(long(CONTEXT + 4000, 7), { max_tokens: 8 });
      const next = await shortWorks();
      return [
        /context window|prompt tokens|too long|exceed/i.test(r.error ?? "") && next,
        `error ${JSON.stringify((r.error ?? "none").slice(0, 120))}, next job ${next}`,
      ];
    });

    await run("K", "Reload", async () => {
      await call({ op: "unload" });
      const again = await load(false);
      const next = await shortWorks();
      return [next, `reloaded in ${Math.round(again.loadMs / 1000)}s, job ${next}`];
    });

    // Phase 2 (case C): the same prompt on stock shaders in a fresh page load.
    await call({ op: "unload" }).catch(() => {});
    if (CASES.has("C")) {
      try {
        await navigate();
        const stock = await load(true);
        const r = await job(long(2500, 1), { max_tokens: 64 });
        const same = !r.error && patchedText !== null && patchedText.length > 0 && r.text === patchedText;
        record(
          "C",
          "Patch is safe",
          same,
          `${r.text.length} chars, identical to patched: ${same} (stock applied=${stock.shaderPatch.applied})`,
        );
      } catch (e) {
        record("C", "Patch is safe", false, `threw: ${e.message}`);
      }
    }
  } finally {
    await cleanup();
  }

  results.sort((a, b) => a.id.localeCompare(b.id));
  say(`\nsummary ${modelEnv}: ${results.map((r) => `${r.id}=${r.pass ? "PASS" : "FAIL"}`).join(" ")}`);
  process.exitCode = results.some((r) => !r.pass) || results.length === 0 ? 1 : 0;
}

main().catch((e) => {
  process.stderr.write(`check failed: ${e.stack ?? e}\n`);
  process.exit(1);
});
