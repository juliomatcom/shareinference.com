import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../src/adapters/logger.js";
import type { Db } from "../src/adapters/postgres/db.js";
import { attachWorkerServer } from "../src/adapters/ws/workerServer.js";
import { SILENCE_MS } from "../src/core/registry.js";
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

const MODEL = "Qwen3.5-4B-q4f16_1-MLC";
const GPU = { vendor: "apple", architecture: "metal-3", shaderF16: true, maxBufferSize: 4294967296 };

describe.skipIf(!testDatabaseUrl)("provider WebSocket (/v1/worker)", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let h: Harness;
  let server: Server;
  let workerServer: { close(): void };
  let cookie: string;
  let userId: string;
  const sockets: WebSocket[] = [];

  async function start(
    opts: {
      authTimeoutMs?: number;
      sweepEveryMs?: number;
      maxUnauthenticated?: number;
      trustProxy?: boolean;
      upgradesPerMin?: number;
    } = {},
  ) {
    server = h.app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    workerServer = attachWorkerServer({
      server,
      core: h.core,
      log: createLogger("test", "error"),
      webOrigin: WEB_ORIGIN,
      ...opts,
    });
  }
  const stop = async () => {
    workerServer.close();
    await new Promise((r) => server.close(r));
    h.core.registry.sweep();
  };
  const url = () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/worker`;

  /** A worker's socket with helpers; frames received and the close code are recorded. */
  function connect(origin: string | null = WEB_ORIGIN, path = "/v1/worker") {
    const ws = new WebSocket(url().replace("/v1/worker", path), { ...(origin !== null && { origin }) });
    sockets.push(ws);
    const frames: Record<string, unknown>[] = [];
    ws.on("message", (d) => frames.push(JSON.parse(String(d))));
    const closed = new Promise<number>((resolve) => ws.on("close", resolve));
    const rejected = new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => {});
    });
    const opened = new Promise<void>((resolve) => ws.on("open", resolve));
    const next = async (type: string) => {
      for (let i = 0; i < 200; i++) {
        const f = frames.find((x) => x.type === type);
        if (f) return f;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no ${type} frame`);
    };
    const send = (frame: unknown) => ws.send(JSON.stringify(frame));
    return { ws, frames, closed, rejected, opened, next, send };
  }

  const newToken = async (c = cookie) =>
    (await request(h.app).post("/worker-token").set("Cookie", c).set(sameOrigin).send({})).body.token as string;
  const auth = (token: string, deviceKey = "device-aaaa") => ({ type: "auth", token, protocol: 1, deviceKey });

  /** Connected, authenticated and ready. */
  async function readyWorker(c = cookie, deviceKey = "device-aaaa") {
    const w = connect();
    await w.opened;
    w.send(auth(await newToken(c), deviceKey));
    await w.next("welcome");
    w.send({ type: "ready", model: MODEL, gpu: GPU, loadMs: 5 });
    return w;
  }
  const online = async () =>
    (await request(h.app).get("/public/models")).body.models.find((m: { id: string }) => m.id === "qwen3.5-4b")
      .workersOnline as number;
  const eventually = async (check: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("condition not met");
  };

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    h = createHarness(db);
    cookie = await signInAs(h, profile(1001, "alice"));
    userId = (await db("users").where({ github_id: 1001 }).first())!.id;
  });
  afterAll(() => drop());
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await stop();
  });

  describe("routes", () => {
    it("POST /worker-token needs a session and the CSRF headers, and returns a 60 s token", async () => {
      await start();
      expect((await request(h.app).post("/worker-token").set(sameOrigin).send({})).status).toBe(401);
      expect((await request(h.app).post("/worker-token").set("Cookie", cookie).send({})).status).toBe(403);
      const res = await request(h.app).post("/worker-token").set("Cookie", cookie).set(sameOrigin).send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresInS: 60 });
    });

    it("GET /public/config and /public/models are public; models lists the catalog with zeros", async () => {
      await start();
      expect((await request(h.app).get("/public/config")).body).toEqual({ apiPublicUrl: "http://localhost:4000" });
      const res = await request(h.app).get("/public/models");
      expect(res.status).toBe(200);
      const row = (id: string, webllmId: string, priceMultiplier = 1) => ({
        id,
        webllmId,
        contextWindow: 16384,
        priceMultiplier,
        workersOnline: 0,
        queueDepth: 0,
      });
      expect(res.body.models).toEqual([
        row("gemma-4-e2b", "gemma-4-E2B-it-q4f16_1-MLC"),
        row("qwen3.5-2b", "Qwen3.5-2B-q4f16_1-MLC"),
        row("qwen3.5-4b", MODEL),
        row("qwen3.5-9b", "Qwen3.5-9B-q4f16_1-MLC", 2),
      ]);
    });
  });

  it("auth -> welcome -> ready: counts online workers, shows them in /worker/stats, then unregisters on close", async () => {
    await start();
    const w = await readyWorker();
    await eventually(async () => (await online()) === 1);

    const stats = await request(h.app).get("/worker/stats").set("Cookie", cookie);
    expect(stats.body.totals).toEqual({ jobsServed: 0, promptTokens: 0, completionTokens: 0, creditsEarned: 0 });
    expect(stats.body.workers).toEqual([
      { id: expect.any(String), status: "ready", model: "qwen3.5-4b", connectedAt: expect.any(String) },
    ]);
    // Someone else sees none of it.
    const bob = await signInAs(h, profile(1002, "bob"));
    expect((await request(h.app).get("/worker/stats").set("Cookie", bob)).body.workers).toEqual([]);

    const row = (await db("workers").where({ user_id: userId }).first())!;
    expect(row).toMatchObject({ device_key: "device-aaaa", last_model: MODEL, gpu: GPU });
    expect((await w.next("welcome")).workerId).toBe(row.id);

    w.ws.close(1000);
    await eventually(async () => (await online()) === 0);
    expect(h.core.registry.size()).toBe(0);
  });

  it("a token works once: reusing it closes 4401", async () => {
    await start();
    const token = await newToken();
    const first = connect();
    await first.opened;
    first.send(auth(token));
    await first.next("welcome");
    const second = connect();
    await second.opened;
    second.send(auth(token, "device-bbbb"));
    expect(await second.closed).toBe(4401);
    expect(h.core.registry.byUser(userId)).toHaveLength(1);
  });

  it("a bad token closes 4401, an expired one too", async () => {
    await start();
    const bad = connect();
    await bad.opened;
    bad.send(auth("nonsense"));
    expect(await bad.closed).toBe(4401);

    const token = await newToken();
    h.clock.advance(61_000);
    const late = connect();
    await late.opened;
    late.send(auth(token));
    expect(await late.closed).toBe(4401);
  });

  it("closes 4401 when the first frame does not arrive in time", async () => {
    await start({ authTimeoutMs: 100 });
    const w = connect();
    expect(await w.closed).toBe(4401);
  });

  it.each([
    ["not JSON", "{{{"],
    ["an unknown frame", JSON.stringify({ type: "hello" })],
    ["a non-auth first frame", JSON.stringify({ type: "heartbeat" })],
    ["a wrong protocol version", JSON.stringify({ type: "auth", token: "t", protocol: 9, deviceKey: "device-aaaa" })],
  ])("closes 4400 on %s", async (_name, payload) => {
    await start();
    const w = connect();
    await w.opened;
    w.ws.send(payload);
    expect(await w.closed).toBe(4400);
  });

  it("closes 4400 on a binary frame, a second auth, and a frame over 64 KiB (1009)", async () => {
    await start();
    const binary = connect();
    await binary.opened;
    binary.ws.send(Buffer.from([1, 2, 3]));
    expect(await binary.closed).toBe(4400);

    const twice = connect();
    await twice.opened;
    twice.send(auth(await newToken()));
    await twice.next("welcome");
    twice.send(auth(await newToken()));
    expect(await twice.closed).toBe(4400);

    const big = connect();
    await big.opened;
    big.ws.send("x".repeat(70_000));
    expect(await big.closed).toBe(1009);
  });

  it("closes 4404 for a model that is not an enabled catalog row", async () => {
    await start();
    const w = connect();
    await w.opened;
    w.send(auth(await newToken()));
    await w.next("welcome");
    w.send({ type: "ready", model: "Not-A-Model", gpu: GPU, loadMs: 1 });
    expect(await w.closed).toBe(4404);

    await db("models").where({ id: "qwen3.5-4b" }).update({ enabled: false });
    const disabled = connect();
    await disabled.opened;
    disabled.send(auth(await newToken(), "device-bbbb"));
    await disabled.next("welcome");
    disabled.send({ type: "ready", model: MODEL, gpu: GPU, loadMs: 1 });
    expect(await disabled.closed).toBe(4404);
    await db("models").where({ id: "qwen3.5-4b" }).update({ enabled: true });
  });

  it("closes 4429 for a 5th device of one user, and leaves no row for it", async () => {
    await start();
    const carol = await signInAs(h, profile(1003, "carol"));
    const carolId = (await db("users").where({ github_id: 1003 }).first())!.id;
    for (let i = 0; i < 4; i++) await readyWorker(carol, `device-${i}-xxxx`);
    const fifth = connect();
    await fifth.opened;
    fifth.send(auth(await newToken(carol), "device-5th-xxxx"));
    expect(await fifth.closed).toBe(4429);
    expect(await db("workers").where({ user_id: carolId })).toHaveLength(4);
  });

  it("rejects a wrong or missing Origin with 403 and any other path with 404", async () => {
    await start();
    expect(await connect("http://evil.example").rejected).toBe(403);
    expect(await connect(null).rejected).toBe(403);
    expect(await connect(WEB_ORIGIN, "/v1/other").rejected).toBe(404);
  });

  it("a reconnecting device replaces its old socket (4409) instead of counting twice", async () => {
    await start();
    const first = await readyWorker();
    const second = connect();
    await second.opened;
    second.send(auth(await newToken()));
    await second.next("welcome");
    expect(await first.closed).toBe(4409);
    expect(h.core.registry.byUser(userId)).toHaveLength(1);
    // The old socket closing must not unregister the new one.
    expect(h.core.registry.get((await second.next("welcome")).workerId as string)).toBeDefined();
  });

  it("sweeps a silent worker after 15 s and closes its socket", async () => {
    await start({ sweepEveryMs: 20 });
    const w = await readyWorker();
    await eventually(async () => (await online()) === 1);
    h.clock.advance(SILENCE_MS + 1);
    expect(await w.closed).toBe(4408);
    expect(await online()).toBe(0);
  });

  it("a heartbeating worker survives the sweep", async () => {
    await start({ sweepEveryMs: 20 });
    const w = await readyWorker();
    await eventually(async () => (await online()) === 1);
    h.clock.advance(SILENCE_MS - 1);
    w.send({ type: "heartbeat" });
    // The server must process the heartbeat before the clock moves again: generous, because a loaded CI runner can
    // take far longer than the sweep interval (20 ms) to deliver one websocket frame.
    await new Promise((r) => setTimeout(r, 400));
    h.clock.advance(SILENCE_MS - 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(await online()).toBe(1);
  });

  describe("hardening", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    /** Slows one core call down so a frame is "in flight" while the test acts. */
    function slow<K extends "workers" | "models">(store: K, method: string, ms: number) {
      const target = h.core[store] as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      const original = target[method]!;
      target[method] = async (...args) => {
        await sleep(ms);
        return original.apply(target, args);
      };
      return () => {
        target[method] = original;
      };
    }

    it("bounds sockets that have not authenticated yet: the next upgrade is refused 503", async () => {
      await start({ maxUnauthenticated: 2 });
      const a = connect();
      const b = connect();
      await Promise.all([a.opened, b.opened]);
      expect(await connect().rejected).toBe(503);
      // Authenticating frees a slot, and so does closing.
      a.send(auth(await newToken(), "device-slot-a"));
      await a.next("welcome");
      const c = connect();
      await c.opened;
      b.ws.close(1000);
      await b.closed;
      const d = connect();
      await d.opened;
    });

    it("refuses upgrades past the per-IP limit with 429; X-Real-IP only counts with trustProxy", async () => {
      await start({ upgradesPerMin: 2 });
      const open = (headers: Record<string, string> = {}) => {
        const ws = new WebSocket(url(), { origin: WEB_ORIGIN, headers });
        sockets.push(ws);
        ws.on("error", () => {});
        return new Promise<number>((resolve) => {
          ws.on("open", () => resolve(101));
          ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        });
      };
      // Without trustProxy a spoofed header does not give a fresh allowance: the socket address counts.
      expect(await open({ "X-Real-IP": "203.0.113.1" })).toBe(101);
      expect(await open({ "X-Real-IP": "203.0.113.2" })).toBe(101);
      expect(await open({ "X-Real-IP": "203.0.113.3" })).toBe(429);
      await stop();

      await start({ upgradesPerMin: 1, trustProxy: true });
      expect(await open({ "X-Real-IP": "203.0.113.1" })).toBe(101);
      expect(await open({ "X-Real-IP": "203.0.113.1" })).toBe(429);
      expect(await open({ "X-Real-IP": "203.0.113.2" })).toBe(101);
    });

    it("a socket that dies mid-auth never reaches the registry, so it cannot unseat the live one", async () => {
      await start();
      const live = await readyWorker();
      await eventually(async () => (await online()) === 1);
      const restore = slow("workers", "upsert", 250);
      const zombie = connect();
      await zombie.opened;
      zombie.send(auth(await newToken()));
      zombie.ws.terminate();
      await sleep(500);
      restore();
      expect(live.ws.readyState).toBe(WebSocket.OPEN);
      expect(h.core.registry.byUser(userId).map((w) => w.state)).toEqual(["ready"]);
      expect(await online()).toBe(1);
    });

    it("what a replaced socket still has in flight does not touch the new connection", async () => {
      await start();
      const old = connect();
      await old.opened;
      old.send(auth(await newToken()));
      await old.next("welcome");
      const restore = slow("models", "findEnabledByWebllmId", 300);
      old.send({ type: "ready", model: MODEL, gpu: GPU, loadMs: 1 });
      const fresh = connect();
      await fresh.opened;
      fresh.send(auth(await newToken()));
      await fresh.next("welcome");
      expect(await old.closed).toBe(4409);
      await sleep(500);
      restore();
      // The new connection has not announced a model: the old socket's `ready` must not have counted for it.
      expect(h.core.registry.byUser(userId).map((w) => w.state)).toEqual(["connected"]);
      expect(await online()).toBe(0);
    });

    it("closes 4403 at the heartbeat check once the owner is suspended, and stops offering the worker", async () => {
      await start({ sweepEveryMs: 3_600_000 });
      const dave = await signInAs(h, profile(1004, "dave"));
      const daveId = (await db("users").where({ github_id: 1004 }).first())!.id;
      const w = await readyWorker(dave, "device-dave-1");
      await eventually(async () => (await online()) === 1);
      expect(h.core.registry.pickRandomIdle(MODEL, "someone-else")).toBeDefined();
      await h.core.users.setSuspended(daveId, h.clock.now());
      h.clock.advance(61_000); // the owner check rides on the once-a-minute persist
      w.send({ type: "heartbeat" });
      expect(await w.closed).toBe(4403);
      expect(h.core.registry.byUser(daveId)).toEqual([]);
      expect(h.core.registry.pickRandomIdle(MODEL, "someone-else")).toBeUndefined();
    });

    it("closes 4413 (retryable) when more than 1 MiB of frames queue up behind a slow one", async () => {
      await start();
      const restore = slow("workers", "upsert", 400);
      const w = connect();
      await w.opened;
      w.send(auth(await newToken()));
      const chunk = JSON.stringify({ type: "chunk", id: "j", delta: "x".repeat(16_000) });
      for (let i = 0; i < 90; i++) w.ws.send(chunk); // ~1.4 MB
      expect(await w.closed).toBe(4413);
      restore();
    });
  });

  describe("workers rows", () => {
    it("keeps at most 20 per user: a new device replaces the least recently seen one", async () => {
      await start();
      const erin = await signInAs(h, profile(1005, "erin"));
      void erin;
      const erinId = (await db("users").where({ github_id: 1005 }).first())!.id;
      const t0 = new Date("2026-02-01T00:00:00Z").getTime();
      for (let i = 0; i < 21; i++) {
        await h.core.workers.upsert(erinId, `device-${String(i).padStart(2, "0")}-erin`, new Date(t0 + i * 1000));
      }
      const keys = (await db("workers").where({ user_id: erinId }).orderBy("device_key")).map((r) => r.device_key);
      expect(keys).toHaveLength(20);
      expect(keys).not.toContain("device-00-erin"); // the oldest went
      expect(keys).toContain("device-20-erin");
      // A known device only refreshes its row; nothing else is deleted.
      await h.core.workers.upsert(erinId, "device-05-erin", new Date(t0 + 99_000));
      expect(await db("workers").where({ user_id: erinId })).toHaveLength(20);
    });
  });
});
