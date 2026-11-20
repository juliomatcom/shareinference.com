import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/adapters/postgres/db.js";
import {
  WEB_ORIGIN,
  createHarness,
  createTestDb,
  profile,
  signInAs,
  testDatabaseUrl,
  type Harness,
} from "./helpers/harness.js";

describe.skipIf(!testDatabaseUrl)("CSRF on cookie-authenticated writes", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let h: Harness;
  let cookie: string;

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    h = createHarness(db);
    cookie = await signInAs(h, profile(1, "alice"));
  });
  afterAll(() => drop());

  const attempts: [string, Record<string, string>][] = [
    ["no Origin", { "Content-Type": "application/json" }],
    ["wrong Origin", { Origin: "https://evil.example", "Content-Type": "application/json" }],
    ["Origin with a path", { Origin: `${WEB_ORIGIN}/`, "Content-Type": "application/json" }],
    ["not JSON", { Origin: WEB_ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }],
    ["no content type", { Origin: WEB_ORIGIN }],
  ];

  it.each(attempts)("POST /keys with %s is 403 and creates nothing", async (_name, headers) => {
    const res = await request(h.app).post("/keys").set("Cookie", cookie).set(headers).send("name=x");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ type: "permission_error", code: "csrf" });
    expect(await db("api_keys").count({ n: "*" }).first()).toMatchObject({ n: "0" });
  });

  it.each(["patch", "delete", "post"] as const)("%s is checked too, including logout", async (method) => {
    const path =
      method === "post" ? "/auth/logout" : method === "patch" ? "/me" : "/keys/00000000-0000-4000-8000-000000000000";
    const res = await request(h.app)[method](path).set("Cookie", cookie).set("Origin", "https://evil.example");
    expect(res.status).toBe(403);
    expect((await request(h.app).get("/me").set("Cookie", cookie)).status).toBe(200);
  });

  it("an unauthenticated write is 401, not 403 (no information about the check)", async () => {
    const res = await request(h.app).post("/keys").set("Origin", "https://evil.example");
    expect(res.status).toBe(401);
  });

  it("GET needs no Origin and a same-origin JSON write passes", async () => {
    expect((await request(h.app).get("/keys").set("Cookie", cookie)).status).toBe(200);
    const ok = await request(h.app)
      .post("/keys")
      .set("Cookie", cookie)
      .set({ Origin: WEB_ORIGIN, "Content-Type": "application/json; charset=utf-8" })
      .send({ name: "ok" });
    expect(ok.status).toBe(201);
  });
});
