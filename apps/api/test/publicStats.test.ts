import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/adapters/postgres/db.js";
import { cleanGpuText, clampTps, gpuLabel, MAX_DECODE_TPS } from "../src/core/gpu.js";
import { cached } from "../src/core/publicStats.js";
import { workerReady } from "../src/core/workers.js";
import { createHarness, createTestDb, FakeClock, profile, signInAs, testDatabaseUrl } from "./helpers/harness.js";
import type { Harness } from "./helpers/harness.js";

describe("cached", () => {
  it("serves one load for 5 s, then reloads; concurrent callers share a load; failures are not kept", async () => {
    const clock = new FakeClock();
    let calls = 0;
    let fail = false;
    const get = cached(clock, 5_000, async () => {
      calls++;
      await Promise.resolve();
      if (fail) throw new Error("boom");
      return calls;
    });
    expect(await Promise.all([get(), get()])).toEqual([1, 1]);
    clock.advance(4_999);
    expect(await get()).toBe(1);
    clock.advance(1);
    expect(await get()).toBe(2);
    clock.advance(5_000);
    fail = true;
    expect(await get()).toBe(2); // the failed reload serves the last good value
    fail = false;
    expect(await get()).toBe(4);
    const never = cached(clock, 5_000, async () => {
      throw new Error("boom");
    });
    await expect(never()).rejects.toThrow("boom"); // nothing to fall back on
  });

  it("serves the last good value when a reload fails; a clock that went backwards counts as stale", async () => {
    const clock = new FakeClock();
    let n = 0;
    let fail = false;
    const get = cached(clock, 5_000, async () => {
      if (fail) throw new Error("boom");
      return ++n;
    });
    expect(await get()).toBe(1);
    clock.advance(5_000);
    fail = true;
    expect(await get()).toBe(1); // stale on error
    fail = false;
    expect(await get()).toBe(2);
    clock.advance(-10_000);
    expect(await get()).toBe(3);
  });
});

describe("gpu text and speed", () => {
  it("keeps a plain subset, collapses spaces and caps at 48 characters", () => {
    expect(cleanGpuText("  NVIDIA <script>alert(1)</script>\n  RTX_4090  ")).toBe(
      "NVIDIA scriptalert(1)script RTX_4090",
    );
    expect(cleanGpuText("x".repeat(100))).toHaveLength(48);
    expect(clampTps(1_000)).toBe(MAX_DECODE_TPS);
    expect(clampTps(Number.NaN)).toBe(0);
    expect(clampTps(12.5)).toBe(12.5);
  });
});

describe("gpuLabel", () => {
  it("joins vendor and architecture, and is null without a GPU", () => {
    expect(gpuLabel({ vendor: "apple", architecture: "metal-3", shaderF16: true, maxBufferSize: 1 })).toBe(
      "apple metal-3",
    );
    expect(gpuLabel({ vendor: "", architecture: "", shaderF16: true, maxBufferSize: 1 })).toBeNull();
    expect(gpuLabel(null)).toBeNull();
  });
});

describe.skipIf(!testDatabaseUrl)("public stats and leaderboard", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let h: Harness;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    h = createHarness(db);
    for (const [i, name] of ["alice", "bobby", "carol", "dave"].entries()) {
      await signInAs(h, profile(3000 + i, name));
      ids[name] = (await db("users")
        .where({ github_id: 3000 + i })
        .first())!.id;
    }
    await db("users").where({ id: ids.bobby }).update({ device_label: "Mac Studio 48GB" });
    // bobby serves 2 jobs, carol 1; dave (suspended) serves one huge job; alice only consumes.
    const gpu = { vendor: "apple", architecture: "metal-3", shaderF16: true, maxBufferSize: 1 };
    const worker = async (user: string, key: string) =>
      (
        await db("workers")
          .insert({
            user_id: ids[user],
            device_key: key,
            gpu: JSON.stringify(gpu),
            last_model: "unsloth/Qwen3.5-4B-GGUF@e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf",
          })
          .returning("id")
      )[0].id as string;
    const bobbyWorker = await worker("bobby", "bobby-device");
    const job = async (provider: string, prompt: number, completion: number, credits: number, tps: number) => {
      const id = await h.core.jobs.create({
        consumerId: ids.alice!,
        modelId: "qwen3.5-4b",
        lane: "fair",
        source: "api",
      });
      await h.core.jobs.markRunning(id, ids[provider]!, bobbyWorker, h.clock.now());
      await h.core.jobs.settle({
        jobId: id,
        consumerId: ids.alice!,
        providerId: ids[provider]!,
        credits,
        promptTokens: prompt,
        completionTokens: completion,
        decodeTps: tps,
        at: h.clock.now(),
      });
    };
    await job("bobby", 10, 20, 110, 10);
    await job("bobby", 5, 5, 30, 20);
    await job("carol", 1, 1, 6, 8.26);
    await job("dave", 1000, 1000, 6000, 5);
    await db("users").where({ id: ids.dave }).update({ suspended_at: new Date() });
    // A failed job and a queued one count for nothing.
    const failed = await h.core.jobs.create({
      consumerId: ids.alice!,
      modelId: "qwen3.5-4b",
      lane: "fair",
      source: "api",
    });
    await h.core.jobs.finish(failed, "failed", "provider_failed", h.clock.now());
    await h.core.jobs.create({ consumerId: ids.alice!, modelId: "qwen3.5-4b", lane: "fair", source: "api" });
  });
  afterAll(() => drop());

  it("/public/stats: tokens and jobs of succeeded jobs, live workers and models, no auth needed", async () => {
    // Totals include suspended providers' historical tokens (dave's 2000): the network did serve them.
    const before = await request(h.app).get("/public/stats");
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ tokensServed: 2042, activeWorkers: 0, modelsOnline: 0, jobsServed: 4 });

    // Cached: a live change is not visible inside the window, and is after it.
    h.core.registry.register("w1", ids.bobby!, "bobby-device");
    h.core.registry.markReady(
      "w1",
      {
        id: "qwen3.5-4b",
        ggufRef: "unsloth/Qwen3.5-4B-GGUF@e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf",
      },
      {
        vendor: "apple",
        architecture: "metal-3",
        shaderF16: true,
        maxBufferSize: 1,
      },
    );
    h.core.registry.register("w2", ids.carol!, "carol-device"); // connected, not ready: not counted
    expect((await request(h.app).get("/public/stats")).body.activeWorkers).toBe(0);
    h.clock.advance(5_000);
    expect((await request(h.app).get("/public/stats")).body).toEqual({
      tokensServed: 2042,
      activeWorkers: 1,
      modelsOnline: 1,
      jobsServed: 4,
    });
  });

  it("/public/leaderboard: ranked opt-in fields only, suspended users left out", async () => {
    h.clock.advance(5_000);
    const res = await request(h.app).get("/public/leaderboard");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      providers: [
        {
          rank: 1,
          name: "bobby",
          gpu: "apple metal-3",
          deviceLabel: "Mac Studio 48GB",
          model: "qwen3.5-4b",
          tokensServed: 40,
          creditsEarned: 140,
          tokensPerS: 15,
          online: true,
        },
        {
          rank: 2,
          name: "carol",
          gpu: null,
          deviceLabel: null,
          model: null,
          tokensServed: 2,
          creditsEarned: 6,
          tokensPerS: 8.3,
          online: false,
        },
      ],
    });
  });

  it("exposes no ids, logins, avatars or consumer data anywhere in either payload", async () => {
    h.clock.advance(5_000);
    const text = JSON.stringify([
      (await request(h.app).get("/public/stats")).body,
      (await request(h.app).get("/public/leaderboard")).body,
    ]);
    for (const key of ["id", "userId", "githubLogin", "github_login", "avatarUrl", "consumerId", "providerId"]) {
      expect(text, key).not.toContain(`"${key}"`);
    }
    for (const id of Object.values(ids)) expect(text).not.toContain(id);
  });
});

describe.skipIf(!testDatabaseUrl)("public leaderboard at volume", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let h: Harness;
  let consumer: string;
  const providers: string[] = [];

  const addUser = async (n: number, login: string, display: string) =>
    (
      await db("users")
        .insert({
          github_id: 9000 + n,
          github_login: login,
          github_created_at: new Date("2020-01-01T00:00:00Z"),
          display_name: display,
        })
        .returning("id")
    )[0].id as string;
  const addJob = (provider: string, tokens: number, tps: number, finishedAt: Date) =>
    db("jobs").insert({
      consumer_id: consumer,
      provider_id: provider,
      model_id: "qwen3.5-4b",
      lane: "fair",
      status: "succeeded",
      prompt_tokens: tokens,
      completion_tokens: 0,
      credits: tokens,
      decode_tps: tps,
      finished_at: finishedAt,
    });

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    h = createHarness(db);
    consumer = await addUser(0, "consumer", "consumer");
    // 105 providers with 100..10500 tokens (one job each); the lowest five are the ones that must be cut.
    for (let i = 1; i <= 105; i++) {
      const id = await addUser(i, `login-secret-${i}`, `Prov_${String(i).padStart(2, "0")}`);
      providers.push(id);
      await addJob(id, i * 100, 10, new Date("2026-01-01T00:00:00Z"));
    }
  });
  afterAll(() => drop());

  it("returns the top 100 by tokens, most first, shown by display name and never by GitHub login", async () => {
    const res = await request(h.app).get("/public/leaderboard");
    const rows = res.body.providers as { rank: number; name: string; tokensServed: number }[];
    expect(rows).toHaveLength(100);
    expect(rows.map((r) => r.rank)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(rows[0]).toMatchObject({ name: "Prov_105", tokensServed: 10500 });
    expect(rows[99]).toMatchObject({ name: "Prov_06", tokensServed: 600 });
    expect(JSON.stringify(res.body)).not.toContain("login-secret");
  });

  it("averages only the latest 50 jobs and clamps implausible speeds", async () => {
    const heavy = providers[19]!; // Prov_20 (inside the top 100)
    // 10 old jobs at an absurd speed, then 50 newer ones at 10 tok/s: the old ones are outside the window.
    for (let i = 0; i < 10; i++)
      await addJob(heavy, 1, 9_999, new Date(`2026-02-01T00:00:${String(i).padStart(2, "0")}Z`));
    for (let i = 0; i < 50; i++)
      await addJob(heavy, 1, 10, new Date(`2026-03-01T00:${String(i).padStart(2, "0")}:00Z`));
    const clamped = providers[18]!; // Prov_19
    await addJob(clamped, 1, 9_999, new Date("2026-04-01T00:00:00Z"));
    await db("jobs").where({ provider_id: clamped }).whereNot("decode_tps", 9_999).update({ decode_tps: 500 });
    h.clock.advance(5_000);
    const rows = (await request(h.app).get("/public/leaderboard")).body.providers as {
      name: string;
      tokensPerS: number | null;
    }[];
    expect(rows.find((r) => r.name === "Prov_20")!.tokensPerS).toBe(10);
    expect(rows.find((r) => r.name === "Prov_19")!.tokensPerS).toBe(500);
  });

  it("a busy worker counts as online and as an active worker", async () => {
    const id = providers[24]!; // Prov_25
    h.core.registry.register("wb", id, "device-busy");
    h.core.registry.markReady(
      "wb",
      {
        id: "qwen3.5-4b",
        ggufRef: "unsloth/Qwen3.5-4B-GGUF@e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf",
      },
      {
        vendor: "apple",
        architecture: "metal-3",
        shaderF16: true,
        maxBufferSize: 1,
      },
    );
    h.core.registry.markBusy("wb", "00000000-0000-0000-0000-000000000000");
    h.clock.advance(5_000);
    const board = (await request(h.app).get("/public/leaderboard")).body.providers as {
      name: string;
      online: boolean;
    }[];
    expect(board.find((r) => r.name === "Prov_25")!.online).toBe(true);
    expect(board.find((r) => r.name === "Prov_24")!.online).toBe(false);
    expect((await request(h.app).get("/public/stats")).body).toMatchObject({ activeWorkers: 1, modelsOnline: 1 });
  });

  it("stores only a cleaned GPU label from what the browser reports", async () => {
    const id = providers[0]!;
    const workerId = await h.core.workers.upsert(id, "device-dirty", h.clock.now());
    h.core.registry.register(workerId, id, "device-dirty");
    const ok = await workerReady(
      h.core,
      workerId,
      {
        type: "ready",
        model: "unsloth/Qwen3.5-4B-GGUF@e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf",
        loadMs: 1,
        gpu: { vendor: "<b>evil</b>\u202e", architecture: "x".repeat(64), shaderF16: true, maxBufferSize: 1 },
      },
      () => true,
    );
    expect(ok).toEqual({ ok: true });
    const stored = (await db("workers").where({ id: workerId }).first())!.gpu as {
      vendor: string;
      architecture: string;
    };
    expect(stored.vendor).toBe("bevilb");
    expect(stored.architecture).toHaveLength(48);
  });
});
