import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/adapters/postgres/db.js";
import type { Dispatcher, JobRequest } from "../src/core/dispatcher.js";
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
const MODEL = { id: "qwen3.5-4b", webllmId: "Qwen3.5-4B-q4f16_1-MLC" };

// ~13 000 tokens by the api's estimate (4 ASCII characters per token), against a 16 384-token window.
const longPrompt = [{ role: "user", content: "x".repeat(4 * 13_000) }];

describe.skipIf(!testDatabaseUrl)("admission and routing by context window", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let h: Harness;
  let last: JobRequest | undefined;

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    const recording = {
      submit: (req: JobRequest, sink: { onFail(code: string): void }) => (
        (last = req),
        sink.onFail("network_busy"),
        { cancel() {} }
      ),
      queueDepth: () => 0,
    } as unknown as Dispatcher;
    h = createHarness(db, { core: { dispatcher: recording } });
  });
  afterAll(() => drop());

  async function chat(githubId: number, body: Record<string, unknown>) {
    const cookie = await signInAs(h, profile(githubId, `window${githubId}`));
    const key = (await request(h.app).post("/keys").set("Cookie", cookie).set(sameOrigin).send({ name: "k" })).body.key;
    return request(h.app)
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${key}`)
      .send({ model: MODEL.id, ...body });
  }

  it("a worker still running a 4096 window is not offered a 13k-token job: 503 no_providers, no queue wait", async () => {
    h.core.registry.register("small", "00000000-0000-4000-8000-0000000000a1", "device-small");
    h.core.registry.markReady("small", MODEL, GPU); // a tab that never announced a window: 4096
    last = undefined;
    const res = await chat(5001, { messages: longPrompt });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("no_providers");
    expect(res.body.error.message).toMatch(/smaller context window/);
    expect(last).toBeUndefined();
  });

  it("a worker that announced 16384 is eligible, and a missing max_tokens is trimmed to what the window leaves", async () => {
    h.core.registry.register("big", "00000000-0000-4000-8000-0000000000a2", "device-big");
    h.core.registry.markReady("big", MODEL, GPU, 16_384);
    const res = await chat(5002, { messages: longPrompt });
    expect(res.status).toBe(503); // the recording stub refuses: it got past admission and routing
    expect(res.body.error.code).toBe("network_busy");
    expect(last?.params.max_tokens).toBe(16_384 - 13_000);
  });

  it("an explicit max_tokens that does not fit is still a 400", async () => {
    const res = await chat(5003, { messages: longPrompt, max_tokens: 4096 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("a prompt that fills the whole window leaves no room for a reply: 400", async () => {
    const res = await chat(5004, { messages: [{ role: "user", content: "x".repeat(4 * 16_384) }] });
    expect(res.status).toBe(400);
  });
});
