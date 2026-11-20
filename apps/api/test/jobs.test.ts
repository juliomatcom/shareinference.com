import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/adapters/postgres/db.js";
import { checkLedger } from "../src/core/ledger.js";
import {
  createHarness,
  createTestDb,
  profile,
  sameOrigin,
  signInAs,
  testDatabaseUrl,
  type Harness,
} from "./helpers/harness.js";

describe.skipIf(!testDatabaseUrl)("jobs: settlement, history, votes", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let h: Harness;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    h = createHarness(db);
    for (const [i, name] of ["alice", "bobby", "carol"].entries()) {
      cookies[name] = await signInAs(h, profile(2000 + i, name));
      ids[name] = (await db("users")
        .where({ github_id: 2000 + i })
        .first())!.id;
    }
  });
  afterAll(() => drop());

  const newJob = (consumer: string) =>
    h.core.jobs.create({ consumerId: ids[consumer]!, modelId: "qwen3.5-4b", lane: "fair", source: "api" });
  const settle = (jobId: string, consumer: string, provider: string, credits: number) =>
    h.core.jobs.settle({
      jobId,
      consumerId: ids[consumer]!,
      providerId: ids[provider]!,
      credits,
      promptTokens: 10,
      completionTokens: credits === 0 ? 0 : 3,
      decodeTps: 12.5,
      at: h.clock.now(),
    });
  const balance = async (name: string) => (await h.core.ledger.balance(ids[name]!))!;

  it("a new job is queued, with no provider and no prompt column anywhere", async () => {
    const id = await newJob("alice");
    expect(await db("jobs").where({ id }).first()).toMatchObject({
      status: "queued",
      consumer_id: ids.alice,
      provider_id: null,
      lane: "fair",
      model_id: "qwen3.5-4b",
    });
    const columns = Object.keys((await db("jobs").where({ id }).first())!);
    expect(columns.filter((c) => /prompt$|message|content|text/.test(c))).toEqual([]);
  });

  it("settle: spend equals earn, balances follow, the job is succeeded; a second settle changes nothing", async () => {
    const id = await newJob("alice");
    const workerId = (await db("workers").insert({ user_id: ids.bobby, device_key: "device-bobby" }).returning("id"))[0]
      .id;
    await h.core.jobs.markRunning(id, ids.bobby!, workerId, h.clock.now());
    expect(await settle(id, "alice", "bobby", 40)).toBe("settled");
    expect(await settle(id, "alice", "bobby", 40)).toBe("duplicate");
    // Balances may go negative: alice had nothing.
    expect(await balance("alice")).toBe(-40);
    expect(await balance("bobby")).toBe(40);
    const entries = await db("ledger_entries").where({ job_id: id }).orderBy("amount");
    expect(entries.map((e) => [e.user_id, Number(e.amount), e.kind, e.idempotency_key])).toEqual([
      [ids.alice, -40, "spend", `job:${id}:spend`],
      [ids.bobby, 40, "earn", `job:${id}:earn`],
    ]);
    expect(await db("jobs").where({ id }).first()).toMatchObject({
      status: "succeeded",
      provider_id: ids.bobby,
      prompt_tokens: 10,
      completion_tokens: 3,
      credits: "40",
      decode_tps: 12.5,
    });
    expect(await checkLedger(h.core)).toEqual([]);
  });

  it("settle with 0 credits writes no entries but still succeeds", async () => {
    const id = await newJob("alice");
    expect(await settle(id, "alice", "bobby", 0)).toBe("settled");
    expect(await db("ledger_entries").where({ job_id: id })).toEqual([]);
    expect((await db("jobs").where({ id }).first())!.status).toBe("succeeded");
  });

  it("a failed or cancelled job cannot be settled, and a late markRunning does not reopen a settled one", async () => {
    const failed = await newJob("alice");
    await h.core.jobs.finish(failed, "failed", "provider_failed", h.clock.now());
    expect(await settle(failed, "alice", "bobby", 9)).toBe("closed");
    expect(await db("ledger_entries").where({ job_id: failed })).toEqual([]);

    const done = await newJob("alice");
    await settle(done, "alice", "bobby", 5);
    const worker = (await db("workers").where({ user_id: ids.bobby }).first())!.id;
    await h.core.jobs.markRunning(done, ids.carol!, worker, h.clock.now());
    await h.core.jobs.finish(done, "cancelled", "x", h.clock.now());
    expect(await db("jobs").where({ id: done }).first()).toMatchObject({ status: "succeeded", provider_id: ids.bobby });
  });

  it("parallel settles stay consistent: crossing pairs do not deadlock, one job settles once", async () => {
    const before = [await balance("alice"), await balance("bobby")];
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      const [consumer, provider] = i % 2 === 0 ? ["alice", "bobby"] : ["bobby", "alice"];
      const id = await newJob(consumer!);
      jobs.push(settle(id, consumer!, provider!, 7), settle(id, consumer!, provider!, 7));
    }
    const results = await Promise.all(jobs);
    expect(results.filter((r) => r === "settled")).toHaveLength(20);
    expect(results.filter((r) => r === "duplicate")).toHaveLength(20);
    // Ten each way, 7 credits: no net change.
    expect([await balance("alice"), await balance("bobby")]).toEqual(before);
    expect(await checkLedger(h.core)).toEqual([]);
  });

  it("history: newest first, provider and own vote shown only once the job ended", async () => {
    const carolConsumer = await newJob("carol");
    const running = await newJob("carol");
    await db("jobs").where({ id: running }).update({ status: "running", provider_id: ids.alice });
    await settle(carolConsumer, "carol", "bobby", 11);

    const res = await request(h.app).get("/jobs").set("Cookie", cookies.carol!);
    expect(res.status).toBe(200);
    const jobs = res.body.jobs as Record<string, unknown>[];
    expect(jobs.map((j) => j.id)).toEqual([running, carolConsumer]);
    expect(jobs[0]).toEqual({
      id: running,
      model: "qwen3.5-4b",
      status: "running",
      promptTokens: null,
      completionTokens: null,
      credits: null,
      createdAt: expect.any(String),
      finishedAt: null,
      servedBy: null,
      source: "api",
      vote: null,
    });
    expect(jobs[1]).toMatchObject({
      status: "succeeded",
      promptTokens: 10,
      completionTokens: 3,
      credits: 11,
      servedBy: "bobby",
      vote: null,
      finishedAt: expect.any(String),
    });
    // Others see none of it.
    expect(
      (await request(h.app).get("/jobs").set("Cookie", cookies.bobby!)).body.jobs.map((j: { id: string }) => j.id),
    ).not.toContain(carolConsumer);
  });

  it("history reveals the provider only for succeeded jobs, not for failed or cancelled ones", async () => {
    const worker = (await db("workers").where({ user_id: ids.bobby }).first())!.id;
    const failed = await newJob("alice");
    await h.core.jobs.markRunning(failed, ids.bobby!, worker, h.clock.now());
    await h.core.jobs.finish(failed, "failed", "provider_failed", h.clock.now());
    const cancelled = await newJob("alice");
    await h.core.jobs.markRunning(cancelled, ids.bobby!, worker, h.clock.now());
    await h.core.jobs.finish(cancelled, "cancelled", "client_cancelled", h.clock.now());
    // A vote for bobby exists (from an earlier succeeded job); it must not show on the unsuccessful rows either.
    await db("votes").insert({ voter_id: ids.alice, provider_id: ids.bobby, value: 1 }).onConflict().ignore();
    const rows = (await request(h.app).get("/jobs").set("Cookie", cookies.alice!)).body.jobs;
    for (const id of [failed, cancelled]) {
      expect(rows.find((j: { id: string }) => j.id === id)).toMatchObject({ servedBy: null, vote: null });
    }
    expect(rows.some((j: { servedBy: string | null }) => j.servedBy === "bobby")).toBe(true);
  });

  it("vote: only the voter's own succeeded job with a provider; latest vote wins; shown on the history row", async () => {
    const mine = await newJob("carol");
    await settle(mine, "carol", "alice", 3);
    const put = (cookie: string, id: string, body: unknown) =>
      request(h.app)
        .put(`/jobs/${id}/vote`)
        .set("Cookie", cookie)
        .set(sameOrigin)
        .send(body as object);

    expect((await put(cookies.carol!, mine, { value: 1 })).status).toBe(200);
    expect((await put(cookies.carol!, mine, { value: -1 })).status).toBe(200);
    expect(await db("votes").where({ voter_id: ids.carol, provider_id: ids.alice })).toEqual([
      expect.objectContaining({ value: -1, job_id: mine }),
    ]);
    const history = (await request(h.app).get("/jobs").set("Cookie", cookies.carol!)).body.jobs;
    expect(history.find((j: { id: string }) => j.id === mine).vote).toBe(-1);

    // Someone else's job, an unknown id, a malformed id, an unfinished job and a failed one are all 404.
    expect((await put(cookies.bobby!, mine, { value: 1 })).status).toBe(404);
    expect((await put(cookies.carol!, "00000000-0000-4000-8000-000000000000", { value: 1 })).status).toBe(404);
    expect((await put(cookies.carol!, "nope", { value: 1 })).status).toBe(404);
    const queued = await newJob("carol");
    expect((await put(cookies.carol!, queued, { value: 1 })).status).toBe(404);
    const failed = await newJob("carol");
    await h.core.jobs.finish(failed, "failed", "provider_failed", h.clock.now());
    expect((await put(cookies.carol!, failed, { value: 1 })).status).toBe(404);
    // Bad bodies are 400; the CSRF headers still apply.
    expect((await put(cookies.carol!, mine, { value: 2 })).status).toBe(400);
    expect((await put(cookies.carol!, mine, {})).status).toBe(400);
    expect(
      (await request(h.app).put(`/jobs/${mine}/vote`).set("Cookie", cookies.carol!).send({ value: 1 })).status,
    ).toBe(403);
  });

  it("provider totals count succeeded jobs only, and /worker/stats reports them", async () => {
    const before = (await h.core.jobs.providerTotals(ids.carol!)).jobsServed;
    const a = await newJob("alice");
    const b = await newJob("alice");
    await settle(a, "alice", "carol", 25);
    await h.core.jobs.finish(b, "failed", "provider_failed", h.clock.now());
    const totals = await h.core.jobs.providerTotals(ids.carol!);
    expect(totals.jobsServed).toBe(before + 1);
    const stats = await request(h.app).get("/worker/stats").set("Cookie", cookies.carol!);
    expect(stats.body.totals).toEqual(totals);
    expect(totals.creditsEarned).toBeGreaterThanOrEqual(25);
  });

  it("abandonUnfinished fails queued and running jobs", async () => {
    const id = await newJob("alice");
    expect(await h.core.jobs.abandonUnfinished(h.clock.now())).toBeGreaterThanOrEqual(1);
    expect(await db("jobs").where({ id }).first()).toMatchObject({ status: "failed", error_code: "api_restart" });
  });

  it("/jobs needs a session: an API key is 401", async () => {
    const key = (await request(h.app).post("/keys").set("Cookie", cookies.alice!).set(sameOrigin).send({ name: "k" }))
      .body.key;
    expect((await request(h.app).get("/jobs").set("Authorization", `Bearer ${key}`)).status).toBe(401);
  });

  it("history is paged: 20 per page, newest first, with the total; a bad page is 400", async () => {
    const get = (q: string) => request(h.app).get(`/jobs${q}`).set("Cookie", cookies.carol!);
    const before = (await get("")).body.total as number;
    const made: string[] = [];
    for (let i = 0; i < 21; i++) {
      h.clock.advance(1_000);
      made.push(await newJob("carol"));
    }
    const first = (await get("")).body;
    expect(first).toMatchObject({ page: 1, pageSize: 20, total: before + 21 });
    expect(first.jobs.map((j: { id: string }) => j.id)).toEqual(made.slice(1).reverse());
    const second = (await get("?page=2")).body.jobs as { id: string }[];
    expect(second[0]!.id).toBe(made[0]);
    expect(second).toHaveLength(before + 1);
    expect((await get("?page=99")).body.jobs).toEqual([]);
    for (const bad of ["0", "x", "2.5"]) expect((await get(`?page=${bad}`)).status).toBe(400);
  });
});
