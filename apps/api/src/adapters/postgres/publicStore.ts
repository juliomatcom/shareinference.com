import type { PublicStore, ProviderRank } from "../../core/ports.js";
import { MAX_DECODE_TPS } from "../../core/gpu.js";
import { gpuSchema } from "../../core/protocol.js";
import type { Db } from "./db.js";
import type { Row } from "./rows.js";

/** Decode speed is averaged over this many of a provider's latest succeeded jobs. */
const TPS_WINDOW = 50;

// Public aggregates are clamped, never thrown on: a huge total must not take the landing page down.
const clampInt = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 0), Number.MAX_SAFE_INTEGER) : 0;
};

export class PostgresPublicStore implements PublicStore {
  constructor(private readonly db: Db) {}

  async totals(): Promise<{ tokensServed: number; jobsServed: number }> {
    const row = await this.db("jobs")
      .where({ status: "succeeded" })
      .first(
        this.db.raw("count(*) as jobs"),
        this.db.raw("coalesce(sum(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0)), 0) as tokens"),
      );
    return { tokensServed: clampInt(row.tokens), jobsServed: clampInt(row.jobs) };
  }

  async topProviders(limit: number): Promise<ProviderRank[]> {
    // Suspended users are left out: a public page should not advertise an account the operator shut down.
    const top: Row[] = await this.db("jobs as j")
      .join("users as u", "u.id", "j.provider_id")
      .where("j.status", "succeeded")
      .whereNull("u.suspended_at")
      .groupBy("u.id", "u.display_name", "u.device_label")
      .orderByRaw("sum(coalesce(j.prompt_tokens, 0) + coalesce(j.completion_tokens, 0)) desc, u.id")
      .limit(limit)
      .select(
        "u.id",
        "u.display_name",
        "u.device_label",
        this.db.raw("sum(coalesce(j.prompt_tokens, 0) + coalesce(j.completion_tokens, 0)) as tokens"),
        this.db.raw("coalesce(sum(j.credits), 0) as credits"),
      );
    if (top.length === 0) return [];
    const ids = top.map((r) => r.id as string);

    // The most recently seen device that announced a GPU, with the public id of its last model.
    const devices: Row[] = await this.db("workers as w")
      .leftJoin("models as m", "m.webllm_id", "w.last_model")
      .whereIn("w.user_id", ids)
      .whereNotNull("w.gpu")
      .distinctOn("w.user_id")
      .orderBy([{ column: "w.user_id" }, { column: "w.last_seen_at", order: "desc" }, { column: "w.id" }])
      .select("w.user_id", "w.gpu", "m.id as model");
    const deviceOf = new Map(devices.map((d) => [d.user_id as string, d]));

    // Index-assisted: for each provider the latest TPS_WINDOW succeeded jobs (jobs_provider_finished_idx).
    const speeds: Row[] = await this.db("users as u")
      .joinRaw(
        `cross join lateral (
           select j.decode_tps from jobs j
           where j.provider_id = u.id and j.status = 'succeeded' and j.decode_tps is not null
           order by j.finished_at desc
           limit ${TPS_WINDOW}
         ) r`,
      )
      .whereIn("u.id", ids)
      .groupBy("u.id")
      .select("u.id as provider_id", this.db.raw("avg(least(r.decode_tps, ?)) as tps", [MAX_DECODE_TPS]));
    const tpsOf = new Map(speeds.map((s) => [s.provider_id as string, Number(s.tps)]));

    return top.map((r) => {
      const device = deviceOf.get(r.id as string);
      // The column is jsonb written by this api; a row that no longer parses simply shows no GPU.
      const gpu = device ? gpuSchema.safeParse(device.gpu) : undefined;
      return {
        userId: r.id as string,
        displayName: r.display_name as string,
        deviceLabel: (r.device_label as string | null) ?? null,
        gpu: gpu?.success ? gpu.data : null,
        model: (device?.model as string | null) ?? null,
        tokensServed: clampInt(r.tokens),
        creditsEarned: clampInt(r.credits),
        tokensPerS: tpsOf.get(r.id as string) ?? null,
      };
    });
  }
}
