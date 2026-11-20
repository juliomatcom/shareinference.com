import type { JobStore } from "../../core/ports.js";
import type {
  JobHistoryRow,
  JobSource,
  JobStatus,
  Lane,
  ProviderTotals,
  SettleInput,
  SettleResult,
} from "../../core/types.js";
import type { Db } from "./db.js";
import { safeInt, type Row } from "./rows.js";

const optInt = (v: unknown): number | null => (v === null || v === undefined ? null : safeInt(v));

export class PostgresJobStore implements JobStore {
  constructor(private readonly db: Db) {}

  async create(input: { consumerId: string; modelId: string; lane: Lane; source: JobSource }): Promise<string> {
    const [row] = await this.db("jobs")
      .insert({ consumer_id: input.consumerId, model_id: input.modelId, lane: input.lane, source: input.source })
      .returning("id");
    return row.id as string;
  }

  async markRunning(jobId: string, providerId: string, workerId: string, at: Date): Promise<void> {
    await this.db("jobs")
      .where({ id: jobId })
      .whereIn("status", ["queued", "running"])
      .update({ status: "running", provider_id: providerId, worker_id: workerId, started_at: at });
  }

  async finish(jobId: string, status: "failed" | "cancelled", errorCode: string, at: Date): Promise<void> {
    await this.db("jobs")
      .where({ id: jobId })
      .whereIn("status", ["queued", "running"])
      .update({ status, error_code: errorCode, finished_at: at });
  }

  async settle(input: SettleInput): Promise<SettleResult> {
    return this.db.transaction(async (trx) => {
      // The job row is the per-job lock: two settlements of one job run one after the other.
      const job = await trx("jobs").where({ id: input.jobId }).forUpdate().first("status");
      if (!job) return "closed";
      if (job.status === "succeeded") return "duplicate";
      if (job.status === "failed" || job.status === "cancelled") return "closed";

      if (input.credits > 0) {
        // Both balance rows, always in id order: parallel settlements of crossing pairs cannot deadlock.
        const ids = [...new Set([input.consumerId, input.providerId])].sort();
        const locked = await trx("balances").whereIn("user_id", ids).orderBy("user_id").forUpdate().select("user_id");
        if (locked.length !== ids.length) throw new Error("balance row missing");
        const entries = [
          { user_id: input.consumerId, amount: -input.credits, kind: "spend", key: "spend" },
          { user_id: input.providerId, amount: input.credits, kind: "earn", key: "earn" },
        ];
        for (const e of entries) {
          await trx("ledger_entries").insert({
            user_id: e.user_id,
            amount: e.amount,
            kind: e.kind,
            job_id: input.jobId,
            note: null,
            idempotency_key: `job:${input.jobId}:${e.key}`,
          });
          await trx("balances")
            .where({ user_id: e.user_id })
            .update({ balance: trx.raw("balance + ?", [e.amount]), updated_at: trx.fn.now() });
        }
      }
      await trx("jobs").where({ id: input.jobId }).update({
        status: "succeeded",
        provider_id: input.providerId,
        prompt_tokens: input.promptTokens,
        completion_tokens: input.completionTokens,
        credits: input.credits,
        decode_tps: input.decodeTps,
        finished_at: input.at,
      });
      return "settled";
    });
  }

  async countByConsumer(userId: string): Promise<number> {
    const row = await this.db("jobs").where({ consumer_id: userId }).count({ n: "*" }).first();
    return Number(row?.n ?? 0);
  }

  async listByConsumer(userId: string, limit: number, offset = 0): Promise<JobHistoryRow[]> {
    const rows: Row[] = await this.db("jobs as j")
      .leftJoin("users as p", "p.id", "j.provider_id")
      .leftJoin("votes as v", function () {
        this.on("v.voter_id", "j.consumer_id").andOn("v.provider_id", "j.provider_id");
      })
      .where("j.consumer_id", userId)
      .orderBy([{ column: "j.created_at", order: "desc" }, { column: "j.id" }])
      .limit(limit)
      .offset(offset)
      .select(
        "j.id",
        "j.model_id",
        "j.status",
        "j.source",
        "j.prompt_tokens",
        "j.completion_tokens",
        "j.credits",
        "j.created_at",
        "j.finished_at",
        "p.display_name as served_by",
        "v.value as vote",
      );
    return rows.map((r) => {
      // Only a completed job reveals its provider and carries the vote (the vote is for a provider who served well).
      const finished = r.status === "succeeded";
      return {
        id: r.id as string,
        modelId: r.model_id as string,
        status: r.status as JobStatus,
        source: r.source as JobSource,
        promptTokens: optInt(r.prompt_tokens),
        completionTokens: optInt(r.completion_tokens),
        credits: optInt(r.credits),
        createdAt: r.created_at as Date,
        finishedAt: (r.finished_at as Date | null) ?? null,
        // The provider is revealed only once the job has succeeded.
        servedBy: finished ? ((r.served_by as string | null) ?? null) : null,
        vote: finished && r.vote !== null && r.vote !== undefined ? (Number(r.vote) as 1 | -1) : null,
      };
    });
  }

  async providerTotals(userId: string): Promise<ProviderTotals> {
    const row = await this.db("jobs")
      .where({ provider_id: userId, status: "succeeded" })
      .first(
        this.db.raw("count(*) as jobs"),
        this.db.raw("coalesce(sum(prompt_tokens), 0) as prompt"),
        this.db.raw("coalesce(sum(completion_tokens), 0) as completion"),
        this.db.raw("coalesce(sum(credits), 0) as credits"),
      );
    return {
      jobsServed: safeInt(row.jobs),
      promptTokens: safeInt(row.prompt),
      completionTokens: safeInt(row.completion),
      creditsEarned: safeInt(row.credits),
    };
  }

  async vote(voterId: string, jobId: string, value: 1 | -1): Promise<boolean> {
    const job = await this.db("jobs")
      .where({ id: jobId, consumer_id: voterId, status: "succeeded" })
      .whereNotNull("provider_id")
      .first("provider_id");
    if (!job) return false;
    await this.db("votes")
      .insert({ voter_id: voterId, provider_id: job.provider_id, value, job_id: jobId })
      .onConflict(["voter_id", "provider_id"])
      .merge({ value, job_id: jobId, updated_at: this.db.fn.now() });
    return true;
  }

  async abandonUnfinished(at: Date): Promise<number> {
    return this.db("jobs")
      .whereIn("status", ["queued", "running"])
      .update({ status: "failed", error_code: "api_restart", finished_at: at });
  }
}
