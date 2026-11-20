import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, PUBLIC_ROUTES } from "../src/adapters/http/app.js";
import { createLogger } from "../src/adapters/logger.js";
import { nodeSecrets, systemClock } from "../src/adapters/secrets.js";
import type { Deps } from "../src/core/deps.js";
import { API_PUBLIC_URL, FakeGithub, WEB_ORIGIN } from "./helpers/harness.js";

// Stores that fail loudly: a request without credentials must be refused before touching any of them.
const explode = new Proxy(
  {},
  {
    get() {
      throw new Error("a store was used");
    },
  },
);
const core = {
  users: explode,
  sessions: explode,
  apiKeys: explode,
  ledger: explode,
  models: explode,
  workers: explode,
  jobs: explode,
  publicStats: {
    stats: async () => ({ tokensServed: 0, activeWorkers: 0, modelsOnline: 0, jobsServed: 0 }),
    leaderboard: async () => ({ providers: [] }),
  },
  dispatcher: explode,
  limiter: explode,
  registry: explode,
  workerTokens: explode,
  secrets: nodeSecrets,
  clock: systemClock,
  signupGrant: 0,
} as unknown as Deps;
const app = createApp({
  log: createLogger("test", "error"),
  authLog: createLogger("test", "error"),
  core,
  github: new FakeGithub(),
  webOrigin: WEB_ORIGIN,
  apiPublicUrl: API_PUBLIC_URL,
});

// Every route registered on the app (top-level Express 5 router stack), with params filled in.
interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}
function registeredRoutes(): { method: string; path: string }[] {
  const stack = (app.router as unknown as { stack: Layer[] }).stack;
  return stack.flatMap((l) =>
    l.route
      ? Object.keys(l.route.methods).map((method) => ({ method, path: l.route!.path.replace(/:\w+/g, "1") }))
      : [],
  );
}

describe("deny by default", () => {
  it("serves /healthz without credentials", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("sends no HSTS and no upgrade-insecure-requests (the TLS terminator owns both)", async () => {
    const res = await request(app).get("/healthz");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");
  });

  it("every registered route that is not public returns 401 without credentials", async () => {
    const routes = registeredRoutes();
    for (const route of [
      "get /healthz",
      "get /auth/github",
      "get /auth/github/callback",
      "post /auth/logout",
      "get /me",
      "patch /me",
      "get /keys",
      "post /keys",
      "delete /keys/1",
      "get /ledger",
      "post /worker-token",
      "get /worker/stats",
      "get /jobs",
      "put /jobs/1/vote",
      "get /v1/models",
      "post /v1/chat/completions",
      "post /playground/chat/completions",
      "get /public/config",
      "get /public/models",
      "get /public/stats",
      "get /public/leaderboard",
    ]) {
      const [method, path] = route.split(" ");
      expect(routes, route).toContainEqual({ method, path });
    }
    const checked: string[] = [];
    for (const { method, path } of routes) {
      if (PUBLIC_ROUTES.has(`${method.toUpperCase()} ${path}`)) continue;
      const res = await request(app)[method as "get"](path);
      expect(res.status, `${method} ${path}`).toBe(401);
      checked.push(`${method} ${path}`);
    }
    expect(checked.length).toBe(14);
  });

  it("the aggregate public routes answer 200 without credentials", async () => {
    for (const path of ["/public/stats", "/public/leaderboard"]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers["cache-control"]).toBe("public, max-age=5");
    }
  });

  it("the public allowlist is exactly what wiki-llm/api.md names for this phase", () => {
    expect([...PUBLIC_ROUTES].sort()).toEqual([
      "GET /auth/github",
      "GET /auth/github/callback",
      "GET /healthz",
      "GET /public/config",
      "GET /public/leaderboard",
      "GET /public/models",
      "GET /public/stats",
    ]);
  });

  it.each([
    ["get", "/me"],
    ["post", "/v1/chat/completions"],
    ["post", "/playground/chat/completions"],
    ["get", "/random"],
    ["delete", "/keys/1"],
    ["post", "/healthz"],
  ] as const)("%s %s without credentials is 401", async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { message: expect.any(String), type: "authentication_error", code: "unauthorized" },
    });
  });

  it("malformed Authorization headers are 401", async () => {
    const bearer = await request(app).get("/me").set("Authorization", "Basic abc");
    expect(bearer.status).toBe(401);
    const shape = await request(app).get("/me").set("Authorization", "Bearer not-a-key");
    expect(shape.status).toBe(401);
  });

  it("the callback without a state cookie redirects to the failure page and touches no store", async () => {
    const res = await request(app).get("/auth/github/callback?code=x&state=y");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/?signin=failed`);
  });
});
