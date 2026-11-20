import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/adapters/postgres/db.js";
import { authenticateApiKey } from "../src/core/auth.js";
import { MAX_ACTIVE_KEYS } from "../src/core/apiKeys.js";
import { REVOKED_LISTED } from "../src/adapters/postgres/apiKeyStore.js";
import {
  createHarness,
  createTestDb,
  profile,
  sameOrigin,
  signInAs,
  testDatabaseUrl,
  type Harness,
} from "./helpers/harness.js";

describe.skipIf(!testDatabaseUrl)("API keys", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let h: Harness;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    h = createHarness(db);
    alice = await signInAs(h, profile(1, "alice"));
    bob = await signInAs(h, profile(2, "bobby"));
  });
  afterAll(() => drop());

  const create = (cookie: string, name: string) =>
    request(h.app).post("/keys").set("Cookie", cookie).set(sameOrigin).send({ name });

  it("creates a key, returns the plaintext once and stores only its hash", async () => {
    const res = await create(alice, "laptop");
    expect(res.status).toBe(201);
    const { key, id, prefix } = res.body;
    expect(key).toMatch(/^si_[A-Za-z0-9_-]{43}$/);
    expect(prefix).toBe(key.slice(0, 11));

    const row = await db("api_keys").where({ id }).first();
    expect(row.key_hash).toBe(h.core.secrets.hash(key));
    expect(JSON.stringify(row)).not.toContain(key);

    const list = await request(h.app).get("/keys").set("Cookie", alice);
    expect(list.status).toBe(200);
    expect(list.body.keys).toHaveLength(1);
    expect(list.body.keys[0]).toMatchObject({ id, name: "laptop", prefix, lastUsedAt: null, revokedAt: null });
    expect(JSON.stringify(list.body)).not.toContain(key);
  });

  it("verifies a key, records last_used_at, and ignores it once revoked", async () => {
    const { key, id } = (await create(alice, "ci")).body;
    const ok = await authenticateApiKey(h.core, key);
    expect(ok).toMatchObject({ ok: true, via: "apiKey" });
    expect((await db("api_keys").where({ id }).first()).last_used_at).not.toBeNull();

    const del = await request(h.app).delete(`/keys/${id}`).set("Cookie", alice).set(sameOrigin).send({});
    expect(del.status).toBe(204);
    expect(await authenticateApiKey(h.core, key)).toEqual({ ok: false, reason: "unauthorized" });
    expect(await authenticateApiKey(h.core, "si_" + "A".repeat(43))).toEqual({ ok: false, reason: "unauthorized" });
    expect(await authenticateApiKey(h.core, "garbage")).toEqual({ ok: false, reason: "unauthorized" });
    // A second revoke finds nothing live.
    const again = await request(h.app).delete(`/keys/${id}`).set("Cookie", alice).set(sameOrigin).send({});
    expect(again.status).toBe(404);
  });

  it("a suspended owner's key is refused as suspended", async () => {
    const { key } = (await create(bob, "b")).body;
    await db("users").where({ github_id: 2 }).update({ suspended_at: new Date() });
    expect(await authenticateApiKey(h.core, key)).toEqual({ ok: false, reason: "suspended" });
    await db("users").where({ github_id: 2 }).update({ suspended_at: null });
  });

  it("an API key is not a session: session routes refuse a Bearer key", async () => {
    const { key } = (await create(alice, "bearer")).body;
    const res = await request(h.app).get("/me").set("Authorization", `Bearer ${key}`);
    expect(res.status).toBe(401);
  });

  it("deletes only the caller's own keys; anything else is 404", async () => {
    const { id } = (await create(alice, "mine")).body;
    for (const target of [id, "not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
      const res = await request(h.app).delete(`/keys/${target}`).set("Cookie", bob).set(sameOrigin).send({});
      expect(res.status, target).toBe(404);
    }
    expect((await db("api_keys").where({ id }).first()).revoked_at).toBeNull();
  });

  it("validates the name and bounds the number of active keys", async () => {
    for (const name of ["", "   ", "x".repeat(61), "bad\u0007name", "\u3164", "\u{1F511}", "k\u0301\u0302\u0303"]) {
      const res = await create(alice, name);
      expect(res.status, JSON.stringify(name)).toBe(400);
    }
    expect((await request(h.app).post("/keys").set("Cookie", alice).set(sameOrigin).send({ nope: 1 })).status).toBe(
      400,
    );
    const carol = await signInAs(h, profile(3, "carol"));
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) expect((await create(carol, `k${i}`)).status).toBe(201);
    const over = await create(carol, "one-too-many");
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe("too_many_keys");
  });

  it("parallel creations never exceed the active-key limit", async () => {
    const dan = await signInAs(h, profile(4, "dan"));
    const results = await Promise.all(Array.from({ length: MAX_ACTIVE_KEYS + 8 }, (_, i) => create(dan, `p${i}`)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(MAX_ACTIVE_KEYS);
    expect(results.filter((r) => r.status === 400).every((r) => r.body.error.code === "too_many_keys")).toBe(true);
    const live = await db("api_keys")
      .whereNull("revoked_at")
      .whereIn("user_id", db("users").select("id").where({ github_id: 4 }));
    expect(live).toHaveLength(MAX_ACTIVE_KEYS);
  });

  it("lists live keys first, then only the most recently revoked ones", async () => {
    const eve = await signInAs(h, profile(5, "eve"));
    for (let i = 0; i < REVOKED_LISTED + 5; i++) {
      const { id } = (await create(eve, `old${i}`)).body;
      await request(h.app).delete(`/keys/${id}`).set("Cookie", eve).set(sameOrigin).send({});
    }
    await create(eve, "live-1");
    await create(eve, "live-2");
    const { keys } = (await request(h.app).get("/keys").set("Cookie", eve)).body;
    expect(keys).toHaveLength(2 + REVOKED_LISTED);
    expect(keys.slice(0, 2).map((k: { name: string }) => k.name)).toEqual(["live-2", "live-1"]);
    expect(keys.slice(2).every((k: { revokedAt: string | null }) => k.revokedAt)).toBe(true);
    expect(keys[2].name).toBe(`old${REVOKED_LISTED + 4}`);
    expect(keys.some((k: { name: string }) => k.name === "old0")).toBe(false);
  });
});
