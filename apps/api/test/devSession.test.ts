import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devSession } from "../src/adapters/devSession.js";
import type { Db } from "../src/adapters/postgres/db.js";
import { authenticateSession } from "../src/core/auth.js";
import { createHarness, createTestDb, profile, signInAs, testDatabaseUrl, type Harness } from "./helpers/harness.js";

describe.skipIf(!testDatabaseUrl)("users dev-session (dev/test tool)", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let h: Harness;

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    h = createHarness(db);
  });
  afterAll(() => drop());

  it("creates a negative-id test user with a year-old GitHub account and returns a working session", async () => {
    const token = await devSession(h.core, "tester");
    const user = (await db("users").where({ github_login: "tester" }).first())!;
    expect(Number(user.github_id)).toBeLessThan(0);
    const age = h.clock.now().getTime() - new Date(user.github_created_at).getTime();
    expect(age).toBeGreaterThan(360 * 86_400_000);
    expect(await authenticateSession(h.core, token)).toMatchObject({ ok: true, via: "session" });
    // A second call reuses the user.
    await devSession(h.core, "TESTER");
    expect(await db("users").where({ github_login: "tester" })).toHaveLength(1);
  });

  it("refuses real GitHub accounts, by login, and does not match display names", async () => {
    const cookie = await signInAs(h, profile(777, "realperson"));
    await expect(devSession(h.core, "realperson")).rejects.toThrow(/real GitHub account/);
    await h.core.users.setProfile((await db("users").where({ github_id: 777 }).first())!.id, {
      displayName: "Shown_Name",
    });
    // "Shown_Name" is only a display name: a new test user with that login is created instead of reusing the real one.
    await devSession(h.core, "Shown-Name");
    expect(cookie).toBeTruthy();
    expect(await db("users").where({ github_login: "Shown-Name" })).toHaveLength(1);
    await expect(devSession(h.core, "bad login!")).rejects.toThrow(/1-39/);
  });
});
