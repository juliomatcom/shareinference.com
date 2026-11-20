import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/adapters/postgres/db.js";
import { WEB_ORIGIN, createHarness, createTestDb, testDatabaseUrl, type Harness } from "./helpers/harness.js";

describe.skipIf(!testDatabaseUrl)("CORS", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let h: Harness;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    h = createHarness(db);
  });
  afterAll(() => drop());

  const page = "https://example.com";

  it("open routes: a preflight from any origin is 204 (never 401), allows Authorization and the asked headers", async () => {
    const res = await request(h.app)
      .options("/v1/chat/completions")
      .set("Origin", page)
      .set("Access-Control-Request-Method", "POST")
      .set(
        "Access-Control-Request-Headers",
        "authorization,content-type,x-stainless-os,x-stainless-retry-count,bad header!",
      );
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
    const allowed = res.headers["access-control-allow-headers"]!.toLowerCase();
    for (const name of ["authorization", "content-type", "x-stainless-os", "x-stainless-retry-count"]) {
      expect(allowed).toContain(name);
    }
    expect(allowed).not.toContain("bad header");
    expect(res.headers["access-control-max-age"]).toBe("600");
  });

  it("open routes: the real responses carry * too, errors included, and stay readable cross-origin", async () => {
    const post = await request(h.app)
      .post("/v1/chat/completions")
      .set("Origin", page)
      .set("Authorization", "Bearer si_nope")
      .send({});
    expect(post.status).toBe(401);
    expect(post.headers["access-control-allow-origin"]).toBe("*");
    expect(post.headers["access-control-expose-headers"]).toContain("Retry-After");
    expect(post.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    for (const path of ["/public/stats", "/public/models", "/healthz"]) {
      const res = await request(h.app).get(path).set("Origin", page);
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    }
  });

  it("/public is open for reads only", async () => {
    const res = await request(h.app).post("/public/stats").set("Origin", page);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("session routes: only WEB_ORIGIN is allowed (no credentials flag); anyone else gets no CORS headers", async () => {
    const preflight = (origin: string) =>
      request(h.app)
        .options("/keys")
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "content-type");
    const ok = await preflight(WEB_ORIGIN);
    expect(ok.status).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(ok.headers["vary"]).toContain("Origin");
    expect(ok.headers["access-control-allow-methods"]).toBe("GET, POST, PUT, PATCH, DELETE");
    expect(ok.headers["access-control-allow-headers"]).toBe("Content-Type, Accept");

    const evil = await preflight("https://evil.example");
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    expect(evil.status).not.toBe(204);

    const real = await request(h.app).get("/me").set("Origin", "https://evil.example");
    expect(real.status).toBe(401);
    expect(real.headers["access-control-allow-origin"]).toBeUndefined();
    const own = await request(h.app).get("/me").set("Origin", WEB_ORIGIN);
    expect(own.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
  });

  it("no route ever sends Access-Control-Allow-Credentials", async () => {
    for (const [method, path, origin] of [
      ["options", "/v1/models", page],
      ["get", "/public/stats", page],
      ["get", "/me", WEB_ORIGIN],
      ["options", "/keys", WEB_ORIGIN],
      ["options", "/playground/chat/completions", WEB_ORIGIN],
    ] as const) {
      const res = await request(h.app)[method](path).set("Origin", origin);
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    }
  });
});
