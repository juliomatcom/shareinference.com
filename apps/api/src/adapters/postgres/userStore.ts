import { randomBytes } from "node:crypto";
import type { Knex } from "knex";
import type { CreateUserResult, UserStore } from "../../core/ports.js";
import { defaultDisplayName } from "../../core/users.js";
import { isReservedName } from "../../core/validation.js";
import type { NewUser, RateLimitOverride, User } from "../../core/types.js";
import type { Db } from "./db.js";
import { isUniqueViolation, toUser } from "./rows.js";

export class PostgresUserStore implements UserStore {
  constructor(private readonly db: Db) {}

  /**
   * Gives users whose display name equals `login` (while their GitHub login is another) their default name back:
   * their login, or login-<4 hex> when that is taken. Runs inside the caller's transaction; returns their ids.
   */
  private async releaseDisplayName(trx: Knex.Transaction, login: string, exceptId?: string): Promise<string[]> {
    const holders = trx("users")
      .whereRaw("lower(display_name) = lower(?)", [login])
      .whereRaw("lower(github_login) <> lower(?)", [login]);
    if (exceptId) holders.whereNot({ id: exceptId });
    const rows = await holders.forUpdate().select("id", "github_login");
    for (const holder of rows) {
      const base = defaultDisplayName(holder.github_login as string);
      let chosen: string | undefined;
      for (let i = 0; i < 5 && chosen === undefined; i++) {
        const candidate = i === 0 ? base : `${base.slice(0, 27)}-${randomBytes(2).toString("hex")}`;
        if (isReservedName(candidate) || candidate.toLowerCase() === login.toLowerCase()) continue;
        const taken = await trx("users")
          .whereRaw("lower(display_name) = lower(?)", [candidate])
          .whereNot({ id: holder.id })
          .first("id");
        if (!taken) chosen = candidate;
      }
      if (chosen === undefined) throw new Error("could not find a display name to release");
      await trx("users").where({ id: holder.id }).update({ display_name: chosen });
    }
    return rows.map((r) => r.id as string);
  }

  async create(input: NewUser, grant: number): Promise<CreateUserResult> {
    try {
      const { user, displaced } = await this.db.transaction(async (trx) => {
        // A default display name is the GitHub login: it outranks someone else's display name equal to it.
        const displaced =
          input.displayName.toLowerCase() === input.githubLogin.toLowerCase()
            ? await this.releaseDisplayName(trx, input.githubLogin)
            : [];
        const [row] = await trx("users")
          .insert({
            github_id: input.githubId,
            github_login: input.githubLogin,
            github_created_at: input.githubCreatedAt,
            avatar_url: input.avatarUrl,
            display_name: input.displayName,
          })
          .returning("*");
        const created = toUser(row);
        await trx("balances").insert({ user_id: created.id, balance: grant });
        if (grant > 0) {
          await trx("ledger_entries").insert({
            user_id: created.id,
            amount: grant,
            kind: "grant",
            note: "sign-up grant",
            idempotency_key: `grant:signup:${created.id}`,
          });
        }
        return { user: created, displaced };
      });
      return { status: "created", user, displaced };
    } catch (error) {
      if (isUniqueViolation(error, "users_display_name_lower_key")) return { status: "display_name_taken" };
      if (isUniqueViolation(error, "users_github_id_key")) return { status: "exists" };
      throw error;
    }
  }

  async findById(id: string): Promise<User | undefined> {
    const row = await this.db("users").where({ id }).first();
    return row && toUser(row);
  }

  async findByGithubId(githubId: number): Promise<User | undefined> {
    const row = await this.db("users").where({ github_id: githubId }).first();
    return row && toUser(row);
  }

  async findByHandle(handle: string): Promise<User[]> {
    const rows = await this.db("users")
      .whereRaw("lower(github_login) = lower(?)", [handle])
      .orWhereRaw("lower(display_name) = lower(?)", [handle])
      .orderBy("created_at");
    return rows.map(toUser);
  }

  async list(limit: number): Promise<User[]> {
    return (await this.db("users").orderBy("created_at").limit(limit)).map(toUser);
  }

  async updateGithub(id: string, fields: { githubLogin: string; avatarUrl: string | null }): Promise<string[]> {
    return this.db.transaction(async (trx) => {
      const displaced = await this.releaseDisplayName(trx, fields.githubLogin, id);
      await trx("users").where({ id }).update({ github_login: fields.githubLogin, avatar_url: fields.avatarUrl });
      return displaced;
    });
  }

  async setProfile(
    id: string,
    patch: { displayName?: string; deviceLabel?: string | null },
  ): Promise<"ok" | "display_name_taken" | "not_found"> {
    const update: Record<string, unknown> = {};
    if (patch.displayName !== undefined) update.display_name = patch.displayName;
    if (patch.deviceLabel !== undefined) update.device_label = patch.deviceLabel;
    if (Object.keys(update).length === 0) return (await this.findById(id)) ? "ok" : "not_found";
    try {
      return (await this.db("users").where({ id }).update(update)) === 1 ? "ok" : "not_found";
    } catch (error) {
      if (isUniqueViolation(error, "users_display_name_lower_key")) return "display_name_taken";
      throw error;
    }
  }

  async githubLoginExists(login: string, exceptId?: string): Promise<boolean> {
    const query = this.db("users").whereRaw("lower(github_login) = lower(?)", [login]);
    if (exceptId) query.whereNot({ id: exceptId });
    return (await query.first("id")) !== undefined;
  }

  async setSuspended(id: string, at: Date | null): Promise<void> {
    await this.db("users").where({ id }).update({ suspended_at: at });
  }

  async setRateLimit(id: string, override: RateLimitOverride): Promise<void> {
    await this.db("users")
      .where({ id })
      .update({ rate_limit_override: JSON.stringify(override) });
  }
}
