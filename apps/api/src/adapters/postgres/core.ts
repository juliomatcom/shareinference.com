import type { Logger } from "../../core/ports.js";
import { nodeSecrets, systemClock, timerScheduler } from "../secrets.js";
import type { Deps } from "../../core/deps.js";
import { PostgresApiKeyStore } from "./apiKeyStore.js";
import type { Db } from "./db.js";
import { createDispatcher } from "../../core/dispatcher.js";
import { createRateLimiter } from "../../core/rateLimiter.js";
import { createRegistry } from "../../core/registry.js";
import { createWorkerTokens } from "../../core/workerTokens.js";
import { PostgresJobStore } from "./jobStore.js";
import { PostgresLedgerStore } from "./ledgerStore.js";
import { PostgresModelStore } from "./modelStore.js";
import { PostgresPublicStore } from "./publicStore.js";
import { createPublicStats } from "../../core/publicStats.js";
import { PostgresSessionStore } from "./sessionStore.js";
import { PostgresUserStore } from "./userStore.js";
import { PostgresWorkerStore } from "./workerStore.js";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * The core's dependencies on Postgres (shared by main.ts, the CLI and tests). `log` (module `ledger`) records postings;
 * `inferenceLog` (module `inference`) records dispatch and settlement.
 */
export function createCore(
  db: Db,
  signupGrant: number,
  overrides: Partial<Deps> = {},
  log?: Logger,
  inferenceLog: Logger = silent,
): Deps {
  const clock = overrides.clock ?? systemClock;
  const secrets = overrides.secrets ?? nodeSecrets;
  const scheduler = overrides.scheduler ?? timerScheduler;
  const registry = overrides.registry ?? createRegistry({ clock, secrets });
  const models = new PostgresModelStore(db);
  return {
    users: new PostgresUserStore(db),
    sessions: new PostgresSessionStore(db),
    apiKeys: new PostgresApiKeyStore(db),
    ledger: new PostgresLedgerStore(db, log),
    models,
    workers: new PostgresWorkerStore(db),
    jobs: new PostgresJobStore(db),
    publicStats: createPublicStats({ store: new PostgresPublicStore(db), models, registry, clock }),
    registry,
    workerTokens: createWorkerTokens({ clock, secrets }),
    dispatcher: overrides.dispatcher ?? createDispatcher({ registry, scheduler, clock, log: inferenceLog }),
    limiter: createRateLimiter({ clock }),
    scheduler,
    log: inferenceLog,
    secrets,
    clock,
    signupGrant,
    ...overrides,
  };
}
