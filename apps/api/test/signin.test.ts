import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/adapters/postgres/db.js";
import { SESSION_TTL_MS } from "../src/core/auth.js";
import {
  cookieValue,
  createHarness,
  createTestDb,
  profile,
  sameOrigin,
  signInAs,
  testDatabaseUrl,
  type Harness,
} from "./helpers/harness.js";

describe.skipIf(!testDatabaseUrl)("GitHub sign-in and sessions", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let h: Harness;

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    h = createHarness(db);
  });
  afterAll(() => drop());

  it("GET /auth/github redirects to GitHub with a state cookie that matches", async () => {
    const res = await request(h.app).get("/auth/github");
    expect(res.status).toBe(302);
    const state = cookieValue(res.headers["set-cookie"], "si_oauth_state")!;
    expect(state).toHaveLength(43);
    expect(res.headers.location).toBe(`https://github.test/authorize?state=${state}`);
    const flags = (res.headers["set-cookie"] as unknown as string[])[0]!;
    expect(flags).toMatch(/HttpOnly/i);
    expect(flags).toMatch(/SameSite=Lax/i);
    expect(flags).not.toMatch(/Secure/i);
  });

  it("rejects a callback whose state does not match the cookie, and creates nothing", async () => {
    h.github.profiles.set("c1", profile(101, "mallory"));
    const res = await request(h.app)
      .get("/auth/github/callback?code=c1&state=forged")
      .set("Cookie", "si_oauth_state=other");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://localhost:3000/?signin=failed");
    expect(cookieValue(res.headers["set-cookie"], "si_session")).toBeUndefined();
    expect(await db("users").where({ github_id: 101 }).first()).toBeUndefined();
  });

  it("rejects a callback when GitHub refuses the code", async () => {
    const res = await request(h.app).get("/auth/github/callback?code=nope&state=s").set("Cookie", "si_oauth_state=s");
    expect(res.headers.location).toBe("http://localhost:3000/?signin=failed");
  });

  it("upserts the user, sets the session cookie and redirects to the dashboard", async () => {
    h.github.profiles.set("c2", profile(202, "alice"));
    const res = await request(h.app).get("/auth/github/callback?code=c2&state=s").set("Cookie", "si_oauth_state=s");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://localhost:3000/dashboard");
    const cookies = res.headers["set-cookie"] as unknown as string[];
    const session = cookies.find((c) => c.startsWith("si_session="))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Path=\//);
    expect(session).toMatch(new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`));
    // The state cookie is single use.
    expect(cookies.find((c) => c.startsWith("si_oauth_state="))).toMatch(/Expires=Thu, 01 Jan 1970/);

    const token = cookieValue(cookies, "si_session")!;
    const me = await request(h.app).get("/me").set("Cookie", `si_session=${token}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      githubLogin: "alice",
      displayName: "alice",
      deviceLabel: null,
      balance: 0,
      avatarUrl: "https://avatars.test/202",
    });
    // Only the hash of the token is stored.
    const rows = await db("sessions").select("token_hash");
    expect(rows.map((r) => r.token_hash)).not.toContain(token);
    expect(await db("balances").where({ user_id: me.body.id }).first()).toMatchObject({ balance: "0" });
  });

  it("signing in again reuses the user and refreshes login and avatar", async () => {
    await signInAs(h, profile(303, "bob"));
    await signInAs(h, profile(303, "bobby", { avatarUrl: null }));
    const rows = await db("users").where({ github_id: 303 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ github_login: "bobby", avatar_url: null, display_name: "bob" });
  });

  it("falls back to login-<n> when the display name is taken (case-insensitively)", async () => {
    await signInAs(h, profile(401, "Carol"));
    const second = await signInAs(h, profile(402, "carol"));
    const third = await signInAs(h, profile(403, "CAROL"));
    const names = await db("users").whereIn("github_id", [401, 402, 403]).orderBy("github_id").pluck("display_name");
    expect(names).toEqual(["Carol", "carol-1", "CAROL-2"]);
    expect((await request(h.app).get("/me").set("Cookie", second)).body.displayName).toBe("carol-1");
    expect(third).toBeTruthy();
  });

  it("a short or odd login still gets a valid display name", async () => {
    await signInAs(h, profile(501, "ab"));
    expect(await db("users").where({ github_id: 501 }).pluck("display_name")).toEqual(["user-ab"]);
  });

  it("a new user cannot take a display name that another account's GitHub login reads as", async () => {
    await signInAs(h, profile(602, "frank-orig"));
    await db("users").where({ github_id: 602 }).update({ github_login: "frank-zz" });
    await signInAs(h, profile(603, "frank-zz"));
    // 603's default would be "frank-zz", which is 602's GitHub login: it falls back.
    expect(await db("users").where({ github_id: 603 }).pluck("display_name")).toEqual(["frank-zz-1"]);
  });

  it("a reserved login does not get its own name as display name", async () => {
    await signInAs(h, profile(510, "Admin"));
    expect(await db("users").where({ github_id: 510 }).pluck("display_name")).toEqual(["Admin-1"]);
  });

  it("after five numbered fallbacks the display name gets a random suffix", async () => {
    for (let i = 0; i < 7; i++) await signInAs(h, profile(520 + i, "dupe"));
    const names = await db("users").whereBetween("github_id", [520, 526]).orderBy("github_id").pluck("display_name");
    expect(names.slice(0, 6)).toEqual(["dupe", "dupe-1", "dupe-2", "dupe-3", "dupe-4", "dupe-5"]);
    expect(names[6]).toMatch(/^dupe-[0-9a-f]{6}$/);
  });

  it("a new account's GitHub login takes back a display name that squats on it", async () => {
    const holder = await signInAs(h, profile(610, "holder-a"));
    expect(
      (await request(h.app).patch("/me").set("Cookie", holder).set(sameOrigin).send({ displayName: "Starlord" }))
        .status,
    ).toBe(200);
    await signInAs(h, profile(611, "starlord"));
    const rows = await db("users").whereIn("github_id", [610, 611]).orderBy("github_id");
    // The impersonator is back to their own login; the real "starlord" has the name.
    expect(rows.map((r) => r.display_name)).toEqual(["holder-a", "starlord"]);
  });

  it("the released name falls back to login-<4 hex> when the login is itself a display name", async () => {
    const c = await signInAs(h, profile(620, "cee"));
    await request(h.app).patch("/me").set("Cookie", c).set(sameOrigin).send({ displayName: "Nova" });
    await signInAs(h, profile(621, "dee"));
    await db("users").where({ github_id: 621 }).update({ display_name: "cee" });
    await signInAs(h, profile(622, "nova"));
    const [released] = await db("users").where({ github_id: 620 }).pluck("display_name");
    expect(released).toMatch(/^cee-[0-9a-f]{4}$/);
    expect(await db("users").where({ github_id: 622 }).pluck("display_name")).toEqual(["nova"]);
  });

  it("an existing account that renames itself on GitHub also takes the name back at sign-in", async () => {
    await signInAs(h, profile(630, "fff"));
    const g = await signInAs(h, profile(631, "ggg"));
    await request(h.app).patch("/me").set("Cookie", g).set(sameOrigin).send({ displayName: "HolderZ" });
    await signInAs(h, profile(630, "holderz"));
    const rows = await db("users").whereIn("github_id", [630, 631]).orderBy("github_id");
    expect(rows.map((r) => [r.github_login, r.display_name])).toEqual([
      ["holderz", "fff"],
      ["ggg", "ggg"],
    ]);
  });

  it("any failure inside the callback lands on the failure page, with no session", async () => {
    const broken = (over: Record<string, unknown>) =>
      createHarness(db, {
        core: { users: new Proxy(h.core.users, { get: (t, k, r) => over[k as string] ?? Reflect.get(t, k, r) }) },
      });
    for (const over of [
      {
        findByGithubId: async () => {
          throw new Error("db down");
        },
      },
      { githubLoginExists: async () => true }, // every display name candidate refused: allocation gives up
    ]) {
      const b = broken(over);
      b.github.profiles.set("c", profile(990, "newbie"));
      const res = await request(b.app).get("/auth/github/callback?code=c&state=s").set("Cookie", "si_oauth_state=s");
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("http://localhost:3000/?signin=failed");
      expect(cookieValue(res.headers["set-cookie"], "si_session")).toBeUndefined();
    }
    expect(await db("users").where({ github_id: 990 }).first()).toBeUndefined();
  });

  it("sessions expire after 30 days and the expired row is dropped", async () => {
    const cookie = await signInAs(h, profile(701, "grace"));
    expect((await request(h.app).get("/me").set("Cookie", cookie)).status).toBe(200);
    h.clock.advance(SESSION_TTL_MS - 1000);
    expect((await request(h.app).get("/me").set("Cookie", cookie)).status).toBe(200);
    h.clock.advance(2000);
    expect((await request(h.app).get("/me").set("Cookie", cookie)).status).toBe(401);
    expect(
      await db("sessions").where({ token_hash: h.core.secrets.hash(cookie.slice("si_session=".length)) }),
    ).toHaveLength(0);
  });

  it("logout ends the session and clears the cookie", async () => {
    const cookie = await signInAs(h, profile(801, "heidi"));
    const res = await request(h.app).post("/auth/logout").set("Cookie", cookie).set(sameOrigin).send({});
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]![0]).toMatch(/si_session=;/);
    expect((await request(h.app).get("/me").set("Cookie", cookie)).status).toBe(401);
  });

  it("a suspended user gets 403 suspended, and cannot sign in", async () => {
    const cookie = await signInAs(h, profile(901, "ivan"));
    await db("users").where({ github_id: 901 }).update({ suspended_at: new Date() });
    const res = await request(h.app).get("/me").set("Cookie", cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ type: "permission_error", code: "suspended" });

    h.github.profiles.set("again", profile(901, "ivan"));
    const login = await request(h.app)
      .get("/auth/github/callback?code=again&state=s")
      .set("Cookie", "si_oauth_state=s");
    expect(login.headers.location).toBe("http://localhost:3000/?signin=failed");
    expect(cookieValue(login.headers["set-cookie"], "si_session")).toBeUndefined();
  });

  it("marks cookies Secure when the web origin is https", async () => {
    const secure = createHarness(db, { webOrigin: "https://share.example.com" });
    const res = await request(secure.app).get("/auth/github");
    expect((res.headers["set-cookie"] as unknown as string[])[0]).toMatch(/Secure/i);
  });
});
