import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/adapters/postgres/db.js";
import type { Dispatcher } from "../src/core/dispatcher.js";
import { postEntry } from "../src/core/ledger.js";
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
const messages = [{ role: "user", content: "hi" }];

// The dispatcher is a stub that refuses at once: these tests are about who may enter, not about routing.
const refusing = { submit: (_req, sink) => (sink.onFail("network_busy"), { cancel() {} }) } as Dispatcher;

describe.skipIf(!testDatabaseUrl)("admission: lanes, free-tier age, rate limits", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let h: Harness;

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    h = createHarness(db, { core: { dispatcher: { ...refusing, queueDepth: () => 0 } as Dispatcher } });
    h.core.registry.register("w1", "00000000-0000-4000-8000-000000000001", "device-admission");
    h.core.registry.markReady(
      "w1",
      {
        id: "qwen3.5-4b",
        ggufRef: "unsloth/Qwen3.5-4B-GGUF@e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf",
      },
      GPU,
    );
  });
  afterAll(() => drop());

  async function user(githubId: number, login: string, over: { createdAt?: Date } = {}) {
    const cookie = await signInAs(h, profile(githubId, login, over));
    const id = (await db("users").where({ github_id: githubId }).first())!.id as string;
    const key = (await request(h.app).post("/keys").set("Cookie", cookie).set(sameOrigin).send({ name: "k" })).body.key;
    const chat = () =>
      request(h.app)
        .post("/v1/chat/completions")
        .set("Authorization", `Bearer ${key}`)
        .send({ model: "qwen3.5-4b", messages });
    return { id, chat };
  }

  it("a GitHub account under 30 days old gets 403 account_too_new on the fair lane", async () => {
    const young = await user(4001, "younguser", { createdAt: new Date(h.clock.now().getTime() - 10 * 86_400_000) });
    const res = await young.chat();
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ type: "permission_error", code: "account_too_new" });
    expect(await db("jobs").where({ consumer_id: young.id })).toHaveLength(0);
  });

  it("the same young account is admitted to the priority lane once its balance is positive", async () => {
    const young = await user(4002, "younglucky", { createdAt: new Date(h.clock.now().getTime() - 86_400_000) });
    await postEntry(h.core, { userId: young.id, amount: 100, kind: "grant", note: null, idempotencyKey: "g:4002" });
    const res = await young.chat();
    expect(res.status).toBe(503); // the stub refuses: it got past admission
    expect(await db("jobs").where({ consumer_id: young.id, lane: "priority" })).toHaveLength(1);
  });

  it("an old account with no credits uses the fair lane, which is limited to 10 per minute", async () => {
    const old = await user(4003, "oldtimer");
    for (let i = 0; i < 10; i++) expect((await old.chat()).status).toBe(503);
    expect(await db("jobs").where({ consumer_id: old.id, lane: "fair" })).toHaveLength(10);
    const res = await old.chat();
    expect(res.status).toBe(429);
    expect(res.body.error).toMatchObject({ type: "rate_limit_error", code: "rate_limited" });
    // A minute later the window has slid.
    h.clock.advance(61_000);
    expect((await old.chat()).status).toBe(503);
  });

  it("rate_limit_override replaces the per-minute number", async () => {
    const limited = await user(4004, "limitedone");
    await h.core.users.setRateLimit(limited.id, { perMin: 1, perDay: 500 });
    expect((await limited.chat()).status).toBe(503);
    expect((await limited.chat()).status).toBe(429);
  });
});
