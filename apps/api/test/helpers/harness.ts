import { randomBytes } from "node:crypto";
import request from "supertest";
import { createApp, type AppOptions } from "../../src/adapters/http/app.js";
import { createLogger } from "../../src/adapters/logger.js";
import { createCore } from "../../src/adapters/postgres/core.js";
import { createDb, migrate, type Db } from "../../src/adapters/postgres/db.js";
import type { Deps } from "../../src/core/deps.js";
import type { Clock, GithubOAuth } from "../../src/core/ports.js";
import type { GithubProfile } from "../../src/core/types.js";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;
export const WEB_ORIGIN = "http://localhost:3000";
export const API_PUBLIC_URL = "http://localhost:4000";

export class FakeClock implements Clock {
  constructor(private time = new Date("2026-01-01T00:00:00Z")) {}
  now(): Date {
    return new Date(this.time);
  }
  advance(ms: number): void {
    this.time = new Date(this.time.getTime() + ms);
  }
}

/** GitHub stand-in: a code maps to the profile it signs in; anything else is refused. */
export class FakeGithub implements GithubOAuth {
  readonly profiles = new Map<string, GithubProfile>();
  authorizeUrl(state: string): string {
    return `https://github.test/authorize?state=${state}`;
  }
  async exchangeCode(code: string): Promise<GithubProfile> {
    const profile = this.profiles.get(code);
    if (!profile) throw new Error("github refused the code");
    return profile;
  }
}

export const profile = (githubId: number, login: string, over: Partial<GithubProfile> = {}): GithubProfile => ({
  githubId,
  login,
  createdAt: new Date("2020-01-01T00:00:00Z"),
  avatarUrl: `https://avatars.test/${githubId}`,
  ...over,
});

/** A migrated database in its own schema, so test files can run in parallel on one test database. */
export async function createTestDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = createDb(testDatabaseUrl!, 2);
  await admin.raw(`CREATE SCHEMA ${schema}`);
  const db = createDb(testDatabaseUrl!, 10, { searchPath: schema });
  await migrate(db);
  return {
    db,
    drop: async () => {
      await db.destroy();
      await admin.raw(`DROP SCHEMA ${schema} CASCADE`);
      await admin.destroy();
    },
  };
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  core: Deps;
  clock: FakeClock;
  github: FakeGithub;
}

export function createHarness(
  db: Db,
  opts: { signupGrant?: number; webOrigin?: string; core?: Partial<Deps>; app?: Partial<AppOptions> } = {},
): Harness {
  const clock = new FakeClock();
  const github = new FakeGithub();
  const core = createCore(db, opts.signupGrant ?? 0, { clock, ...opts.core });
  const app = createApp({
    log: createLogger("test", "error"),
    authLog: createLogger("test", "error"),
    core,
    github,
    webOrigin: opts.webOrigin ?? WEB_ORIGIN,
    apiPublicUrl: API_PUBLIC_URL,
    // The fake clock never advances, so the per-IP limits would trip on long tests; ipLimits.test.ts covers them.
    ipLimits: { publicPerMin: 1e9, authPerMin: 1e9, failedAuthPerMin: 1e9 },
    ...opts.app,
  });
  return { app, core, clock, github };
}

export const cookieValue = (setCookie: string[] | string | undefined, name: string): string | undefined => {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0]
    ?.slice(name.length + 1);
};

/** Full sign-in through the HTTP routes; returns the session cookie header to send afterwards. */
export async function signInAs(h: Harness, p: GithubProfile): Promise<string> {
  h.github.profiles.set(`code-${p.githubId}`, p);
  const start = await request(h.app).get("/auth/github");
  const state = cookieValue(start.headers["set-cookie"], "si_oauth_state")!;
  const done = await request(h.app)
    .get(`/auth/github/callback?code=code-${p.githubId}&state=${state}`)
    .set("Cookie", `si_oauth_state=${state}`);
  const token = cookieValue(done.headers["set-cookie"], "si_session");
  if (!token) throw new Error(`sign-in failed: ${done.status} ${done.headers.location}`);
  return `si_session=${token}`;
}

/** Headers of a same-origin JSON call from the web app. */
export const sameOrigin = { Origin: WEB_ORIGIN, "Content-Type": "application/json" };
