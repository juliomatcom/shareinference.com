import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/adapters/postgres/db.js";
import { PostgresJobStore } from "../src/adapters/postgres/jobStore.js";
import type { Dispatcher, JobRequest, JobSink } from "../src/core/dispatcher.js";
import { checkLedger } from "../src/core/ledger.js";
import { startChat, drainInflightWrites } from "../src/core/inference.js";
import type { JobStore, Scheduler } from "../src/core/ports.js";
import {
  createHarness,
  createTestDb,
  profile,
  sameOrigin,
  signInAs,
  testDatabaseUrl,
  type Harness,
} from "./helpers/harness.js";

const GPU = { vendor: "x", architecture: "y", shaderF16: true, maxBufferSize: 1 };
const messages = [{ role: "user" as const, content: "hi" }];
const usage = { promptTokens: 10, completionTokens: 4, decodeTokensPerS: 3 };

describe.skipIf(!testDatabaseUrl)("inference: settlement retries, lost settlements, cancel billing", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let h: Harness;
  let consumerId: string;
  let providerId: string;
  let key: string;
  /** Throws on the next `failures` settle calls. */
  const flaky = { failures: 0, calls: 0 };
  /** What the stub dispatcher does with a submitted job. */
  let script: (req: JobRequest, sink: JobSink) => void = () => {};
  const submitted: { req: JobRequest; sink: JobSink; cancelled: boolean }[] = [];
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const instant: Scheduler = {
    after(_ms, fn) {
      queueMicrotask(fn);
      return () => {};
    },
  };

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    const real = new PostgresJobStore(db);
    const jobs: JobStore = Object.assign(Object.create(real) as JobStore, {
      async settle(input: Parameters<JobStore["settle"]>[0]) {
        flaky.calls++;
        if (flaky.failures > 0) {
          flaky.failures--;
          throw new Error("database blip");
        }
        return real.settle(input);
      },
    });
    const dispatcher = {
      submit(req: JobRequest, sink: JobSink) {
        const entry = { req, sink, cancelled: false };
        submitted.push(entry);
        script(req, sink);
        return {
          cancel() {
            entry.cancelled = true;
          },
        };
      },
      send: () => true,
      queueDepth: () => 0,
    } as unknown as Dispatcher;
    h = createHarness(db, { core: { jobs, dispatcher, scheduler: instant, log } });
    const providerCookie = await signInAs(h, profile(5001, "providerx"));
    const consumerCookie = await signInAs(h, profile(5002, "consumerx"));
    providerId = (await db("users").where({ github_id: 5001 }).first())!.id;
    consumerId = (await db("users").where({ github_id: 5002 }).first())!.id;
    void providerCookie;
    key = (await request(h.app).post("/keys").set("Cookie", consumerCookie).set(sameOrigin).send({ name: "k" })).body
      .key;
    h.core.registry.register("w-stub", providerId, "device-stub-1");
    h.core.registry.markReady("w-stub", { id: "qwen3.5-4b", webllmId: "Qwen3.5-4B-q4f16_1-MLC" }, GPU);
  });
  afterAll(async () => {
    await drainInflightWrites();
    await drop();
  });

  const completes = (req: JobRequest, sink: JobSink) => {
    sink.onStart?.({ providerId, workerId: "w-stub" });
    sink.onChunk("Hello");
    sink.onDone({ finishReason: "stop", usage, providerId, workerId: "w-stub" });
  };
  const chat = (extra: object = {}) =>
    request(h.app)
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${key}`)
      .send({ model: "qwen3.5-4b", messages, ...extra });
  const balance = async (id: string) => (await h.core.ledger.balance(id))!;

  it("retries a failing settlement and still answers", async () => {
    script = completes;
    flaky.failures = 2;
    flaky.calls = 0;
    const before = await balance(providerId);
    const res = await chat();
    expect(res.status).toBe(200);
    expect(flaky.calls).toBe(3);
    expect(await balance(providerId)).toBe(before + 10 + 4 * 5);
    expect(await checkLedger(h.core)).toEqual([]);
  });

  it("when every attempt fails: 502 provider_failed, no completion, job failed settle_failed, settle_lost logged", async () => {
    script = completes;
    flaky.failures = 99;
    flaky.calls = 0;
    const before = [await balance(consumerId), await balance(providerId)];
    const res = await chat();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ type: "api_error", code: "provider_failed" });
    expect(flaky.calls).toBe(3);
    expect(log.error).toHaveBeenCalledWith("settle_lost", expect.objectContaining({ consumer_id: consumerId }));
    expect(await db("jobs").where({ status: "failed", error_code: "settle_failed" })).toHaveLength(1);
    expect([await balance(consumerId), await balance(providerId)]).toEqual(before);
  });

  it("a stream whose settlement is lost ends with an error event instead of the final chunk and [DONE]", async () => {
    script = completes;
    flaky.failures = 99;
    const res = await chat({ stream: true })
      .buffer(true)
      .parse((r, cb) => {
        let text = "";
        r.on("data", (d) => (text += d));
        r.on("end", () => cb(null, text));
      });
    const text = res.body as string;
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"code":"provider_failed"');
    expect(text).not.toContain("[DONE]");
    expect(text).not.toContain('"finish_reason":"stop"');
    flaky.failures = 0;
  });

  it("a consumer cancel after output settles the delivered tokens; with nothing delivered the job is cancelled", async () => {
    flaky.failures = 0;
    const before = [await balance(consumerId), await balance(providerId)];
    // A stub that streams one chunk and then waits.
    script = (_req, sink) => {
      sink.onStart?.({ providerId, workerId: "w-stub" });
      sink.onChunk("Hel");
    };
    const user = (await h.core.users.findById(consumerId))!;
    let jobId = "";
    const started = await startChat(h.core, user, "api", { model: "qwen3.5-4b", messages }, (id) => {
      jobId = id;
      return { onChunk() {}, onDone() {}, onFail() {} };
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    started.cancel();
    const entry = submitted.at(-1)!;
    expect(entry.cancelled).toBe(true);
    // The dispatcher reports the worker's confirmed usage.
    (entry.sink as Required<Pick<JobSink, "onCancelled">>).onCancelled({
      usage: { promptTokens: 10, completionTokens: 1, decodeTokensPerS: 2 },
      providerId,
      workerId: "w-stub",
    });
    await drainInflightWrites();
    expect(await db("jobs").where({ id: jobId }).first()).toMatchObject({ status: "succeeded", completion_tokens: 1 });
    expect([await balance(consumerId), await balance(providerId)]).toEqual([before[0]! - 15, before[1]! + 15]);

    const second = await startChat(h.core, user, "api", { model: "qwen3.5-4b", messages }, (id) => {
      jobId = id;
      return { onChunk() {}, onDone() {}, onFail() {} };
    });
    if (!second.ok) throw new Error("not admitted");
    second.cancel();
    submitted.at(-1)!.sink.onCancelled!(undefined);
    await drainInflightWrites();
    expect(await db("jobs").where({ id: jobId }).first()).toMatchObject({
      status: "cancelled",
      error_code: "client_cancelled",
    });
    expect(await balance(consumerId)).toBe(before[0]! - 15);
    expect(await checkLedger(h.core)).toEqual([]);
  });
});
