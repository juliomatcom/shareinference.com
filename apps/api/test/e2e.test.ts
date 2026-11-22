import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import OpenAI from "openai";
import request from "supertest";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../src/adapters/logger.js";
import type { Db } from "../src/adapters/postgres/db.js";
import { attachWorkerServer } from "../src/adapters/ws/workerServer.js";
import { checkLedger } from "../src/core/ledger.js";
import {
  WEB_ORIGIN,
  createHarness,
  createTestDb,
  profile,
  sameOrigin,
  signInAs,
  testDatabaseUrl,
  type Harness,
} from "./helpers/harness.js";

const MODEL = "unsloth/Qwen3.5-4B-GGUF@e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf";
const GPU = { vendor: "fake", architecture: "fake", shaderF16: true, maxBufferSize: 1 };

type Mode = "plain" | "think" | "hold" | "silent" | "die-after-first-chunk";
type Frame = Record<string, unknown> & { type: string };

/** A provider over a real WebSocket, like the browser worker: canned output, behaviour chosen per test. */
class FakeProvider {
  mode: Mode = "plain";
  readonly frames: Frame[] = [];
  private ws!: WebSocket;
  private heartbeat?: NodeJS.Timeout;

  async connect(url: string, token: string): Promise<void> {
    this.ws = new WebSocket(url, { origin: WEB_ORIGIN });
    this.ws.on("message", (d) => this.onFrame(JSON.parse(String(d)) as Frame));
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.send({ type: "auth", token, protocol: 1, deviceKey: "device-e2e-worker" });
    await this.waitFor("welcome");
    this.send({ type: "ready", model: MODEL, gpu: GPU, loadMs: 1 });
    this.heartbeat = setInterval(() => this.send({ type: "heartbeat" }), 2_000);
  }

  send(frame: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }
  close() {
    clearInterval(this.heartbeat);
    this.ws.terminate();
  }
  of(type: string) {
    return this.frames.filter((f) => f.type === type);
  }
  async waitFor(type: string, count = 1): Promise<Frame> {
    for (let i = 0; i < 300; i++) {
      const found = this.of(type);
      if (found.length >= count) return found[count - 1]!;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${type} frame`);
  }

  private onFrame(frame: Frame) {
    this.frames.push(frame);
    if (frame.type === "job") void this.run(frame.id as string);
  }

  private async run(id: string) {
    const pieces =
      this.mode === "think"
        ? ["<think>", "plan", "</think>", "\n\n", "the", " answer"]
        : ["<think>\n\n</think>\n\n", "Hello", " world"];
    let sent = 0;
    const cancels = this.of("cancel").length;
    const aborted = async () => {
      // Wait for the cancel, like a worker interrupted mid-generation.
      await this.waitFor("cancel", cancels + 1);
      this.send({
        type: "done",
        id,
        finishReason: "abort",
        usage: { promptTokens: 12, completionTokens: sent, decodeTokensPerS: 1 },
      });
    };
    if (this.mode === "silent") return aborted();
    for (const delta of pieces) {
      this.send({ type: "chunk", id, delta });
      sent++;
      if (this.mode === "die-after-first-chunk") return this.close();
      if (this.mode === "hold") return aborted();
      await new Promise((r) => setTimeout(r, 5));
    }
    this.send({
      type: "done",
      id,
      finishReason: "stop",
      usage: { promptTokens: 12, completionTokens: sent, decodeTokensPerS: 40 },
    });
  }
}

describe.skipIf(!testDatabaseUrl)("end to end: openai SDK -> api -> fake provider over WebSocket", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let h: Harness;
  let server: Server;
  let workerServer: { close(): void };
  let provider: FakeProvider;
  let sdk: OpenAI;
  let baseUrl: string;
  let providerId: string;
  let consumerId: string;
  let consumerCookie: string;
  let providerCookie: string;
  let apiKey: string;

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    h = createHarness(db);
    server = h.app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    workerServer = attachWorkerServer({
      server,
      core: h.core,
      log: createLogger("test", "error"),
      webOrigin: WEB_ORIGIN,
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    // User A provides, user B consumes.
    providerCookie = await signInAs(h, profile(3001, "provider"));
    providerId = (await db("users").where({ github_id: 3001 }).first())!.id;
    consumerCookie = await signInAs(h, profile(3002, "consumer"));
    consumerId = (await db("users").where({ github_id: 3002 }).first())!.id;
    apiKey = (await request(h.app).post("/keys").set("Cookie", consumerCookie).set(sameOrigin).send({ name: "e2e" }))
      .body.key;
    sdk = new OpenAI({ apiKey, baseURL: `${baseUrl}/v1`, maxRetries: 0 });

    const token = (await request(h.app).post("/worker-token").set("Cookie", providerCookie).set(sameOrigin).send({}))
      .body.token;
    provider = new FakeProvider();
    await provider.connect(`ws://127.0.0.1:${port}/v1/worker`, token);
    for (let i = 0; i < 300 && h.core.registry.onlineCount(MODEL) === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
  });
  afterAll(async () => {
    provider.close();
    workerServer.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await drop();
  });
  afterEach(() => {
    provider.mode = "plain";
  });

  const balance = async (id: string) => (await h.core.ledger.balance(id))!;
  /** Polls until the condition holds (bounded), instead of sleeping and hoping. */
  const eventually = async (check: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 300; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("condition not met in time");
  };
  const messages = [{ role: "user" as const, content: "say hello" }];

  it("lists the online model", async () => {
    const list = await sdk.models.list();
    expect(list.data.map((m) => m.id)).toEqual(["qwen3.5-4b"]);
    expect(list.data[0]).toMatchObject({ object: "model", owned_by: "shareinference" });
  });

  it("non-stream: content without the empty think block, usage, ledger spend = earn, stats frame to the provider", async () => {
    const [b0, a0] = [await balance(consumerId), await balance(providerId)];
    const res = await sdk.chat.completions.create({ model: "qwen3.5-4b", messages });
    expect(res.object).toBe("chat.completion");
    expect(res.model).toBe("qwen3.5-4b");
    expect(res.choices[0]!.message.content).toBe("Hello world");
    expect(res.choices[0]!.message).not.toHaveProperty("reasoning_content");
    expect(res.choices[0]!.finish_reason).toBe("stop");
    // Three chunks: 12 prompt tokens + 3 completion tokens.
    expect(res.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });

    const credits = 12 * 1 + 3 * 5;
    await eventually(async () => (await balance(providerId)) === a0 + credits);
    expect(await balance(consumerId)).toBe(b0 - credits);
    expect(await checkLedger(h.core)).toEqual([]);

    // The provider is told its new totals, and the job frame carried nothing about the consumer.
    const stats = await provider.waitFor("stats");
    expect(stats).toMatchObject({
      jobsServed: 1,
      promptTokens: 12,
      completionTokens: 3,
      creditsEarned: credits,
      lastJob: { promptTokens: 12, completionTokens: 3, credits },
    });
    expect(JSON.stringify(provider.frames)).not.toContain(consumerId);
    expect(JSON.stringify(provider.frames)).not.toContain(apiKey);
  });

  it("stream: first delta has the assistant role, content assembles, usage chunk on request, then [DONE]", async () => {
    const before = await balance(providerId);
    const stream = await sdk.chat.completions.create({
      model: "qwen3.5-4b",
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks[0]!.choices[0]!.delta.role).toBe("assistant");
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe("Hello world");
    const finish = chunks.filter((c) => c.choices[0]?.finish_reason);
    expect(finish).toHaveLength(1);
    expect(finish[0]!.choices[0]!.finish_reason).toBe("stop");
    const last = chunks[chunks.length - 1]!;
    expect(last.choices).toEqual([]);
    expect(last.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
    expect(chunks[0]!.id).toMatch(/^chatcmpl-[0-9a-f-]{36}$/);
    await eventually(async () => (await balance(providerId)) === before + 27);
  });

  it("stream without include_usage sends no usage chunk", async () => {
    const stream = await sdk.chat.completions.create({ model: "qwen3.5-4b", messages, stream: true });
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks.some((c) => c.usage)).toBe(false);
    expect(chunks[chunks.length - 1]!.choices[0]!.finish_reason).toBe("stop");
  });

  it("a think block becomes reasoning_content, in both modes; its tokens are billed as output", async () => {
    provider.mode = "think";
    const res = await sdk.chat.completions.create({ model: "qwen3.5-4b", messages, enable_thinking: true } as never);
    const message = res.choices[0]!.message as unknown as Record<string, unknown>;
    expect(message.content).toBe("the answer");
    expect(message.reasoning_content).toBe("plan");
    expect(res.usage!.completion_tokens).toBe(6);

    const stream = await sdk.chat.completions.create({ model: "qwen3.5-4b", messages, stream: true });
    let content = "";
    let reasoning = "";
    for await (const c of stream) {
      const delta = c.choices[0]?.delta as unknown as Record<string, string | undefined> | undefined;
      content += delta?.content ?? "";
      reasoning += delta?.reasoning_content ?? "";
    }
    expect({ content, reasoning }).toEqual({ content: "the answer", reasoning: "plan" });
    // enable_thinking reached the worker as a param.
    const job = provider.of("job").find((f) => (f.params as Record<string, unknown>).enable_thinking === true);
    expect(job).toBeDefined();
  });

  it("the consumer's history shows the job, the provider's name and the vote", async () => {
    const jobs = (await request(h.app).get("/jobs").set("Cookie", consumerCookie)).body.jobs;
    expect(jobs.length).toBeGreaterThanOrEqual(3);
    expect(jobs[0]).toMatchObject({ status: "succeeded", servedBy: "provider", model: "qwen3.5-4b" });
    const vote = await request(h.app)
      .put(`/jobs/${jobs[0].id}/vote`)
      .set("Cookie", consumerCookie)
      .set(sameOrigin)
      .send({ value: 1 });
    expect(vote.status).toBe(200);
    expect((await request(h.app).get("/jobs").set("Cookie", consumerCookie)).body.jobs[0].vote).toBe(1);
  });

  it("errors use the OpenAI shape: bad key, session on /v1, unknown model, unknown field, bad params", async () => {
    const call = (body: unknown, auth = `Bearer ${apiKey}`) =>
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const bad = await call({ model: "qwen3.5-4b", messages }, "Bearer si_" + "x".repeat(43));
    expect(bad.status).toBe(401);
    const session = await fetch(`${baseUrl}/v1/models`, { headers: { Cookie: consumerCookie } });
    expect(session.status).toBe(401);
    const unknown = await call({ model: "nope", messages });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: { message: expect.any(String), type: "not_found_error", code: "model_not_found" },
    });
    for (const body of [
      { model: "qwen3.5-4b", messages, tools: [] },
      { model: "qwen3.5-4b", messages, max_tokens: 9000 },
      { model: "qwen3.5-4b", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] },
      { model: "qwen3.5-4b", messages: [] },
      { model: "qwen3.5-4b", messages: [{ role: "user", content: "x".repeat(16384 * 4 + 1) }] },
      // 60000 ASCII characters (~15000 tokens) plus 2048 completion tokens do not fit 16384.
      { model: "qwen3.5-4b", messages: [{ role: "user", content: "x".repeat(60000) }], max_tokens: 2048 },
      // Non-ASCII text counts a token per character.
      { model: "qwen3.5-4b", messages: [{ role: "user", content: "é".repeat(16500) }] },
      { model: "qwen3.5-4b", messages, stop: [""] },
    ]) {
      const res = await call(body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      const error = (await res.json()).error;
      expect(error).toMatchObject({ type: "invalid_request_error", code: "invalid_request" });
      if (JSON.stringify(body).length > 3000) {
        expect(error.message).toContain("context length");
      }
    }
  });

  describe("the Playground door (session, same code path)", () => {
    // Its own account: the fair lane allows 10 requests a minute, and the tests above use most of the other one's.
    let playerId: string;
    let playerCookie: string;
    let playerKey: string;
    beforeAll(async () => {
      playerCookie = await signInAs(h, profile(3003, "player"));
      playerId = (await db("users").where({ github_id: 3003 }).first())!.id;
      playerKey = (await request(h.app).post("/keys").set("Cookie", playerCookie).set(sameOrigin).send({ name: "p" }))
        .body.key;
    });
    const play = (body: unknown, headers: Record<string, string> = { ...sameOrigin, Cookie: playerCookie }) =>
      fetch(`${baseUrl}/playground/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });

    it("non-stream and stream answer like /v1, label the job `playground` and bill the same", async () => {
      const [b0, a0] = [await balance(playerId), await balance(providerId)];
      const json = await play({ model: "qwen3.5-4b", messages });
      expect(json.status).toBe(200);
      const body = await json.json();
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.content).toBe("Hello world");
      expect(body.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });

      const sse = await play({ model: "qwen3.5-4b", messages, stream: true, stream_options: { include_usage: true } });
      expect(sse.headers.get("content-type")).toContain("text/event-stream");
      const text = await sse.text();
      const events = text
        .split("\n\n")
        .filter((e) => e.startsWith("data: "))
        .map((e) => e.slice(6));
      expect(events[events.length - 1]).toBe("[DONE]");
      const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
      expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe("Hello world");
      expect(chunks[chunks.length - 1].usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });

      // Same price as /v1 (12 in + 3 out): 27 credits per request.
      await eventually(async () => (await balance(providerId)) === a0 + 54);
      expect(await balance(playerId)).toBe(b0 - 54);
      expect(await checkLedger(h.core)).toEqual([]);

      const rows = await db("jobs").where({ consumer_id: playerId, source: "playground" });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.status === "succeeded" && Number(r.credits) === 27)).toBe(true);
      const history = (await request(h.app).get("/jobs").set("Cookie", playerCookie)).body.jobs;
      expect(history[0].source).toBe("playground");
    });

    it("a Bearer key is 401, a session without Origin is 403 csrf, a session on /v1 stays 401", async () => {
      const bearer = await play(
        { model: "qwen3.5-4b", messages },
        { Authorization: `Bearer ${playerKey}`, "Content-Type": "application/json" },
      );
      expect(bearer.status).toBe(401);
      const noOrigin = await play(
        { model: "qwen3.5-4b", messages },
        { Cookie: playerCookie, "Content-Type": "application/json" },
      );
      expect(noOrigin.status).toBe(403);
      expect((await noOrigin.json()).error.code).toBe("csrf");
      const bad = await play({ model: "qwen3.5-4b", messages, tools: [] });
      expect(bad.status).toBe(400);
      // A fully valid browser request (cookie, Origin, JSON) is still not an API key on /v1.
      const onV1 = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { ...sameOrigin, Cookie: playerCookie },
        body: JSON.stringify({ model: "qwen3.5-4b", messages }),
      });
      expect(onV1.status).toBe(401);
    });

    it("a provider asking for its own model while only its own GPU serves it gets 503 no_providers, not a queue wait", async () => {
      const own = await play({ model: "qwen3.5-4b", messages }, { ...sameOrigin, Cookie: providerCookie });
      expect(own.status).toBe(503);
      const error = (await own.json()).error;
      expect(error.code).toBe("no_providers");
      expect(error.message).toContain("your own GPU");
      expect(await db("jobs").where({ consumer_id: providerId })).toHaveLength(0);
    });

    const player = () => new OpenAI({ apiKey: playerKey, baseURL: `${baseUrl}/v1`, maxRetries: 0 });

    it("no response body (playground or /v1, stream or not) names the provider or its worker", async () => {
      const providerWorker = (await db("workers").where({ user_id: providerId }).first())!;
      const secrets = [
        providerId,
        providerWorker.id,
        "device-e2e-worker",
        "provider", // the provider's display name and login
        "fake", // its reported GPU
        "servedBy",
        "decode",
        "worker",
        "gpu",
      ];
      const bodies = [
        await (await play({ model: "qwen3.5-4b", messages })).text(),
        await (await play({ model: "qwen3.5-4b", messages, stream: true })).text(),
        JSON.stringify(await player().chat.completions.create({ model: "qwen3.5-4b", messages })),
        await (
          await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${playerKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "qwen3.5-4b",
              messages,
              stream: true,
              stream_options: { include_usage: true },
            }),
          })
        ).text(),
      ];
      const api = await db("jobs").where({ consumer_id: playerId, source: "api" });
      expect(api).toHaveLength(2);
      // Headers carry nothing about the provider either.
      const headerRes = await play({ model: "qwen3.5-4b", messages });
      const headers = [...headerRes.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
      await headerRes.text();
      for (const secret of secrets) expect(headers.toLowerCase(), secret).not.toContain(String(secret).toLowerCase());
      for (const body of bodies) {
        expect(body).toContain("Hello");
        for (const secret of secrets) expect(body.toLowerCase(), secret).not.toContain(String(secret).toLowerCase());
      }
    });
  });

  it("a client that leaves after output is billed for what it received; before any output nothing moves", async () => {
    provider.mode = "hold";
    const [b0, a0] = [await balance(consumerId), await balance(providerId)];
    const abort = new AbortController();
    const stream = await sdk.chat.completions.create(
      { model: "qwen3.5-4b", messages, stream: true },
      { signal: abort.signal },
    );
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next(); // the first chunk is out
    abort.abort();
    // One chunk delivered: 12 prompt tokens + 1 completion token, settled once the worker confirms the abort.
    const credits = 12 + 5;
    await eventually(async () => (await balance(providerId)) === a0 + credits);
    expect(await balance(consumerId)).toBe(b0 - credits);
    expect(provider.of("cancel").length).toBeGreaterThanOrEqual(1);
    expect(await checkLedger(h.core)).toEqual([]);

    provider.mode = "silent";
    const [b1, a1] = [await balance(consumerId), await balance(providerId)];
    const early = new AbortController();
    const jobsBefore = provider.of("job").length;
    const pending = sdk.chat.completions.create({ model: "qwen3.5-4b", messages }, { signal: early.signal });
    pending.catch(() => {});
    const cancelsBefore = provider.of("cancel").length;
    await provider.waitFor("job", jobsBefore + 1);
    early.abort();
    await provider.waitFor("cancel", cancelsBefore + 1);
    await eventually(
      async () => (await db("jobs").where({ status: "cancelled", consumer_id: consumerId })).length === 1,
    );
    expect([await balance(consumerId), await balance(providerId)]).toEqual([b1, a1]);

    provider.mode = "plain";
    const again = await sdk.chat.completions.create({ model: "qwen3.5-4b", messages });
    expect(again.choices[0]!.message.content).toBe("Hello world");
  });

  it("a provider that dies after the first chunk ends the stream with an error event and bills nothing; then no_providers", async () => {
    provider.mode = "die-after-first-chunk";
    const [b0, a0] = [await balance(consumerId), await balance(providerId)];
    const dying = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3.5-4b", messages, stream: true }),
    });
    const sseText = await dying.text();
    // The stream ends with an error event (no [DONE]) that names no provider, worker or device.
    expect(sseText).toContain('"error"');
    expect(sseText).not.toContain("[DONE]");
    for (const secret of [providerId, "device-e2e-worker", "gpu", "servedBy"]) {
      expect(sseText.toLowerCase(), secret).not.toContain(secret.toLowerCase());
    }
    await eventually(
      async () => (await db("jobs").where({ status: "failed", error_code: "provider_failed" })).length === 1,
    );
    expect([await balance(consumerId), await balance(providerId)]).toEqual([b0, a0]);

    for (let i = 0; i < 300 && h.core.registry.onlineCount(MODEL) > 0; i++) await new Promise((r) => setTimeout(r, 10));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3.5-4b", messages }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatchObject({ type: "api_error", code: "no_providers" });
    expect((await sdk.models.list()).data).toEqual([]);
  });
});
