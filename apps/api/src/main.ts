import { loadConfig } from "./adapters/config.js";
import { GithubOAuthClient } from "./adapters/githubOAuth.js";
import { createApp } from "./adapters/http/app.js";
import { createLogger } from "./adapters/logger.js";
import { createCore } from "./adapters/postgres/core.js";
import { createDb, migrate } from "./adapters/postgres/db.js";
import { drainInflightWrites } from "./core/inference.js";
import { attachWorkerServer } from "./adapters/ws/workerServer.js";

/** Where the database is, for logs: host, port and name only (never the user or password). */
function databaseTarget(url: string): Record<string, string> {
  try {
    const u = new URL(url);
    return { db_host: u.hostname, db_port: u.port || "5432", db_name: u.pathname.slice(1) };
  } catch {
    return {};
  }
}

/** A startup stage that failed: `main` logs it with the stage name. */
class StartupError extends Error {
  constructor(
    readonly step: string,
    readonly fields: Record<string, unknown>,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  // One logger per module; the level is the only thing config decides.
  const logger = (module: string) => createLogger(module, config.LOG_LEVEL);
  const log = logger("main");
  log.info("config loaded", {
    port: config.PORT,
    log_level: config.LOG_LEVEL,
    web_origin: config.WEB_ORIGIN,
    api_public_url: config.API_PUBLIC_URL,
    trust_proxy: config.TRUST_PROXY,
  });

  /** Runs one startup stage: an info line when it is ready, a `StartupError` naming it when it fails. */
  const step = async <T>(name: string, fields: Record<string, unknown>, fn: () => Promise<T> | T): Promise<T> => {
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      throw new StartupError(name, fields, error);
    }
    log.info(`${name} ready`, fields);
    return result;
  };

  const target = databaseTarget(config.DATABASE_URL);
  const db = createDb(config.DATABASE_URL, config.DB_POOL_MAX, { log: logger("db") });
  await step("database", target, () => db.raw("SELECT 1"));
  await step("migrations", {}, () => migrate(db, logger("migrate")));

  const github = await step(
    "github oauth",
    { callback: `${config.WEB_ORIGIN}/api/auth/github/callback` },
    () =>
      new GithubOAuthClient(
        config.GITHUB_CLIENT_ID,
        config.GITHUB_CLIENT_SECRET,
        `${config.WEB_ORIGIN}/api/auth/github/callback`,
      ),
  );
  const core = await step("core", { signup_grant: config.SIGNUP_GRANT_CREDITS }, () =>
    createCore(db, config.SIGNUP_GRANT_CREDITS, {}, logger("ledger"), logger("inference")),
  );
  // A previous process may have died mid-request: nothing can be in flight now.
  const abandoned = await step("job recovery", {}, () => core.jobs.abandonUnfinished(core.clock.now()));
  if (abandoned > 0) log.warn("unfinished jobs abandoned", { count: abandoned });
  const app = createApp({
    log: logger("http"),
    authLog: logger("auth"),
    core,
    github,
    webOrigin: config.WEB_ORIGIN,
    apiPublicUrl: config.API_PUBLIC_URL,
    trustProxy: config.TRUST_PROXY,
  });
  const server = await step(
    "http",
    { port: config.PORT },
    () =>
      new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
        const s = app.listen(config.PORT, (error?: Error) => (error ? reject(error) : resolve(s)));
      }),
  );
  const workerServer = await step("worker websocket", { path: "/v1/worker" }, () =>
    attachWorkerServer({
      server,
      core,
      log: logger("ws"),
      webOrigin: config.WEB_ORIGIN,
      trustProxy: config.TRUST_PROXY,
    }),
  );
  log.info("api started", { port: config.PORT });

  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    workerServer.close();
    setTimeout(() => server.closeAllConnections(), 5_000).unref();
    setTimeout(() => process.exit(1), 8_000).unref();
    server.close(() => {
      // Settlements still writing must land before the pool closes (the 8 s timer above bounds the wait).
      void drainInflightWrites()
        .then(() => db.destroy())
        .then(() => {
          log.info("shutdown complete");
          process.exit(0);
        });
    });
    server.closeIdleConnections();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  // Config may have failed before its log level is known: log at the default level. Message only, never the stack.
  const fields =
    error instanceof StartupError
      ? { step: error.step, ...error.fields, error: error.message }
      : { step: "config", error: String(error?.message ?? error) };
  createLogger("main").error(error instanceof StartupError ? `${error.step} failed` : "startup failed", fields);
  process.exit(1);
});
