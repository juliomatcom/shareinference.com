import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/adapters/postgres/db.js";
import { IP_LIMITS, createIpLimiter } from "../src/core/ipLimiter.js";
import {
  FakeClock,
  createHarness,
  createTestDb,
  profile,
  sameOrigin,
  signInAs,
  testDatabaseUrl,
  type Harness,
} from "./helpers/harness.js";

describe("per-IP limiter", () => {
  it("allows `max` hits per sliding window, per IP, then recovers", () => {
    const clock = new FakeClock();
    const limiter = createIpLimiter({ clock }, 3);
    expect([1, 2, 3, 4].map(() => limiter.hit("a"))).toEqual([true, true, true, false]);
    expect(limiter.hit("b")).toBe(true);
    clock.advance(30_000);
    expect(limiter.hit("a")).toBe(false);
    clock.advance(30_000);
    expect(limiter.hit("a")).toBe(true);
  });

  it("refused hits are not counted: the window slides from the allowed ones", () => {
    const clock = new FakeClock();
    const limiter = createIpLimiter({ clock }, 2);
    limiter.hit("a");
    limiter.hit("a");
    for (let i = 0; i < 50; i++) expect(limiter.hit("a")).toBe(false);
    clock.advance(60_000);
    expect(limiter.hit("a")).toBe(true);
  });

  it("stays bounded: past 10 000 addresses the stalest are evicted", () => {
    const clock = new FakeClock();
    const limiter = createIpLimiter({ clock }, 1);
    for (let i = 0; i < 10_000; i++) limiter.hit(`10.${i}`);
    expect(limiter.hit("10.0")).toBe(false);
    limiter.hit("new");
    expect(limiter.hit("10.0")).toBe(true); // evicted: forgotten
    expect(limiter.hit("10.9999")).toBe(false);
  });
});

describe.skipIf(!testDatabaseUrl)("per-IP limits on the api", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  });
  afterAll(() => drop());

  const status = async (h: Harness, path: string, headers: Record<string, string> = {}) =>
    (await request(h.app).get(path).set(headers)).status;

  it("defaults are 600 public, 20 auth, 60 failed auth, 30 upgrades per minute", () => {
    expect(IP_LIMITS).toMatchObject({ publicPerMin: 600, authPerMin: 20, failedAuthPerMin: 60, upgradePerMin: 30 });
  });

  it("public routes: over the limit is 429 in the OpenAI error shape, and it recovers", async () => {
    const h = createHarness(db, { app: { ipLimits: { publicPerMin: 3 } } });
    for (let i = 0; i < 3; i++) expect(await status(h, "/public/stats")).toBe(200);
    const res = await request(h.app).get("/public/models");
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      error: { message: expect.any(String), type: "rate_limit_error", code: "rate_limited" },
    });
    expect(res.headers["retry-after"]).toBe("60");
    expect(await status(h, "/healthz")).toBe(200); // never limited: probes and the compose healthcheck
    h.clock.advance(60_000);
    expect(await status(h, "/public/stats")).toBe(200);
  });

  it("/auth/* has its own, lower limit", async () => {
    const h = createHarness(db, { app: { ipLimits: { authPerMin: 2 } } });
    expect(await status(h, "/auth/github")).toBe(302);
    expect(await status(h, "/auth/github")).toBe(302);
    expect(await status(h, "/auth/github")).toBe(429);
    expect(await status(h, "/healthz")).toBe(200); // other public routes unaffected
  });

  it("failed authentication: bad credentials count and past the allowance the 401 becomes 429; valid ones are never limited", async () => {
    const h = createHarness(db, { app: { ipLimits: { failedAuthPerMin: 2 } } });
    const cookie = await signInAs(h, profile(7001, "dora"));
    const created = await request(h.app).post("/keys").set("Cookie", cookie).set(sameOrigin).send({ name: "k" });
    const good = { Authorization: `Bearer ${created.body.key}` };
    const bad = { Authorization: "Bearer si_nope" };
    expect(await status(h, "/v1/models", bad)).toBe(401);
    expect(await status(h, "/me", { Cookie: "si_session=nope" })).toBe(401);
    expect(await status(h, "/v1/models", bad)).toBe(429);
    expect(await status(h, "/me", { Cookie: "si_session=nope" })).toBe(429);
    // The same address with valid credentials still works, and a request without credentials is a plain 401.
    expect(await status(h, "/v1/models", good)).not.toBe(429);
    expect(await status(h, "/v1/models", good)).not.toBe(401);
    expect(await status(h, "/me", { Cookie: cookie })).toBe(200);
    expect(await status(h, "/me")).toBe(401);
  });

  it("X-Real-IP is ignored without TRUST_PROXY and used with it", async () => {
    const spoof = (n: number) => ({ "X-Real-IP": `203.0.113.${n}` });
    const direct = createHarness(db, { app: { ipLimits: { publicPerMin: 2 } } });
    expect(await status(direct, "/public/stats", spoof(1))).toBe(200);
    expect(await status(direct, "/public/stats", spoof(2))).toBe(200);
    expect(await status(direct, "/public/stats", spoof(3))).toBe(429); // one socket address, however many spoofed IPs

    const proxied = createHarness(db, { app: { ipLimits: { publicPerMin: 2 }, trustProxy: true } });
    expect(await status(proxied, "/public/stats", spoof(1))).toBe(200);
    expect(await status(proxied, "/public/stats", spoof(1))).toBe(200);
    expect(await status(proxied, "/public/stats", spoof(1))).toBe(429);
    expect(await status(proxied, "/public/stats", spoof(2))).toBe(200);
    expect(await status(proxied, "/public/stats")).toBe(200); // no header: falls back to the socket address
  });
});
