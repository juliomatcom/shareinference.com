import { loadConfig } from "./adapters/config.js";
import { devSession } from "./adapters/devSession.js";
import { createLogger } from "./adapters/logger.js";
import { createCore } from "./adapters/postgres/core.js";
import { createDb } from "./adapters/postgres/db.js";
import type { Deps } from "./core/deps.js";
import { adjustBalance, checkLedger } from "./core/ledger.js";
import type { User } from "./core/types.js";
import { UsageError, parseUsersArgs } from "./usersArgs.js";

// Admin CLI: users, credits and ledger by hand (wiki-llm/setup.md). Results (tables, balances, the dev-session token)
// are plain text on stdout, so `dev-session` can be captured with $(...); only logs (state changes, failures) use the
// logger (module `cli`; credit postings come from module `ledger`).
const bootLog = createLogger("cli");
const out = (text: string) => process.stdout.write(`${text}\n`);
const LIST_LIMIT = 500;

async function findOne(core: Deps, handle: string): Promise<User> {
  const found = await core.users.findByHandle(handle);
  if (found.length === 0) throw new Error(`no user "${handle}"`);
  if (found.length > 1) {
    throw new Error(`"${handle}" is ambiguous (${found.length} users); matches: ${found.map((u) => u.id).join(", ")}`);
  }
  return found[0]!;
}

async function main(): Promise<void> {
  const cmd = parseUsersArgs(process.argv.slice(2));
  const config = loadConfig();
  const log = createLogger("cli", config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, 2, { log: createLogger("db", config.LOG_LEVEL) });
  try {
    const core = createCore(db, config.SIGNUP_GRANT_CREDITS, {}, createLogger("ledger", config.LOG_LEVEL));
    switch (cmd.name) {
      case "list": {
        const users = await core.users.list(LIST_LIMIT);
        out(["LOGIN", "DISPLAY NAME", "BALANCE", "STATUS", "CREATED", "ID"].join("\t"));
        for (const u of users) {
          const status = [u.suspendedAt ? "suspended" : "active", u.rateLimitOverride ? "throttled" : ""]
            .filter(Boolean)
            .join(",");
          out(
            [
              u.githubLogin,
              u.displayName,
              String((await core.ledger.balance(u.id)) ?? 0),
              status,
              u.createdAt.toISOString(),
              u.id,
            ].join("\t"),
          );
        }
        break;
      }
      case "suspend":
      case "unsuspend": {
        const user = await findOne(core, cmd.handle);
        await core.users.setSuspended(user.id, cmd.name === "suspend" ? core.clock.now() : null);
        log.info(cmd.name === "suspend" ? "user suspended" : "user unsuspended", { user_id: user.id });
        out(`${user.githubLogin} ${cmd.name === "suspend" ? "suspended" : "unsuspended"}`);
        break;
      }
      case "throttle": {
        const user = await findOne(core, cmd.handle);
        await core.users.setRateLimit(user.id, { perMin: cmd.perMin, perDay: cmd.perDay });
        log.info("rate limit set", { user_id: user.id, per_min: cmd.perMin, per_day: cmd.perDay });
        out(`${user.githubLogin} limited to ${cmd.perMin}/min, ${cmd.perDay}/day`);
        break;
      }
      case "credit": {
        const user = await findOne(core, cmd.handle);
        const result = await adjustBalance(core, user.id, cmd.amount, cmd.reason);
        if (result.status !== "posted") throw new Error(`adjustment failed (${result.status})`);
        out(`${user.githubLogin} balance ${result.balance} (${cmd.amount > 0 ? "+" : ""}${cmd.amount})`);
        break;
      }
      case "ledger": {
        const user = await findOne(core, cmd.handle);
        out(["ID", "WHEN", "KIND", "AMOUNT", "NOTE"].join("\t"));
        for (const e of await core.ledger.entries(user.id, LIST_LIMIT)) {
          out([e.id, e.createdAt.toISOString(), e.kind, e.amount, e.note ?? ""].join("\t"));
        }
        break;
      }
      case "ledger:check": {
        const bad = await checkLedger(core);
        if (bad.length === 0) {
          out("ledger OK: every balance equals the sum of its entries");
          break;
        }
        for (const b of bad) {
          process.stderr.write(
            `MISMATCH user ${b.userId}: balance ${b.balance ?? "missing"}, entries sum ${b.entriesSum}\n`,
          );
        }
        process.exitCode = 1;
        break;
      }
      case "dev-session":
        out(await devSession(core, cmd.handle));
        break;
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  // A typo is not a failure: usage text alone, plain. Never log more than the message (no stack, no env).
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageError) {
    process.stderr.write(`${message}\n`);
    process.exit(2);
  }
  bootLog.error("command failed", { error: message });
  process.exit(1);
});
