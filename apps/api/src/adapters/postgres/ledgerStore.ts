import type { Logger } from "../../core/ports.js";
import type { LedgerStore, PostResult } from "../../core/ports.js";
import type { BalanceSum, LedgerEntry, NewEntry } from "../../core/types.js";
import type { Db } from "./db.js";
import { safeInt, toEntry } from "./rows.js";

export class PostgresLedgerStore implements LedgerStore {
  constructor(
    private readonly db: Db,
    private readonly log?: Logger,
  ) {}

  async post(entry: NewEntry): Promise<PostResult> {
    const result = await this.postInTransaction(entry);
    // After the commit, so a rolled-back posting is never reported. Ids and numbers only: the note is free text.
    if (result.status === "posted") {
      this.log?.info("ledger entry posted", {
        user_id: entry.userId,
        entry_id: result.entry.id,
        kind: entry.kind,
        amount: entry.amount,
        balance: result.balance,
        ...(entry.jobId && { job_id: entry.jobId }),
      });
    } else {
      this.log?.debug("ledger entry not posted", { user_id: entry.userId, kind: entry.kind, status: result.status });
    }
    return result;
  }

  private async postInTransaction(entry: NewEntry): Promise<PostResult> {
    return this.db.transaction(async (trx) => {
      // The balance row is the per-user lock: concurrent postings for one user run one after the other.
      const locked = await trx("balances").where({ user_id: entry.userId }).forUpdate().first("user_id");
      if (!locked) return { status: "no_user" } as const;
      const inserted = await trx("ledger_entries")
        .insert({
          user_id: entry.userId,
          amount: entry.amount,
          kind: entry.kind,
          job_id: entry.jobId ?? null,
          note: entry.note,
          idempotency_key: entry.idempotencyKey,
        })
        .onConflict("idempotency_key")
        .ignore()
        .returning("*");
      const row = inserted[0];
      if (!row) return { status: "duplicate" } as const;
      const [updated] = await trx("balances")
        .where({ user_id: entry.userId })
        .update({ balance: trx.raw("balance + ?", [entry.amount]), updated_at: trx.fn.now() })
        .returning("balance");
      return { status: "posted", entry: toEntry(row), balance: safeInt(updated.balance) } as const;
    });
  }

  async balance(userId: string): Promise<number | undefined> {
    const row = await this.db("balances").where({ user_id: userId }).first("balance");
    return row === undefined ? undefined : safeInt(row.balance);
  }

  async entries(userId: string, limit: number, offset = 0): Promise<LedgerEntry[]> {
    const rows = await this.db("ledger_entries")
      .where({ user_id: userId })
      .orderBy("id", "desc")
      .limit(limit)
      .offset(offset);
    return rows.map(toEntry);
  }

  async countEntries(userId: string): Promise<number> {
    const row = await this.db("ledger_entries").where({ user_id: userId }).count({ n: "*" }).first();
    return safeInt(row?.n ?? 0);
  }

  async balanceSums(): Promise<BalanceSum[]> {
    const { rows } = await this.db.raw(`
      SELECT COALESCE(b.user_id, s.user_id) AS user_id, b.balance, COALESCE(s.total, 0) AS total
      FROM balances b
      FULL JOIN (SELECT user_id, SUM(amount) AS total FROM ledger_entries GROUP BY user_id) s ON s.user_id = b.user_id
      ORDER BY 1
    `);
    return rows.map((r: { user_id: string; balance: string | null; total: string }) => ({
      userId: r.user_id,
      balance: r.balance === null ? null : safeInt(r.balance),
      entriesSum: safeInt(r.total),
    }));
  }
}
