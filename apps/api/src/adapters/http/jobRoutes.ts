import type { Express, RequestHandler } from "express";
import { z } from "zod";
import type { Deps } from "../../core/deps.js";
import { apiError } from "./errors.js";
import { PAGE_SIZE, parsePage } from "./paging.js";
import { userOf } from "./principal.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const voteBody = z.object({ value: z.union([z.literal(1), z.literal(-1)]) }).strict();

/** The consumer's own request history and the vote on the provider that served a job (session routes). */
export function jobRoutes(app: Express, opts: { core: Deps; requireSession: RequestHandler }): void {
  const { core, requireSession } = opts;

  app.get("/jobs", requireSession, async (req, res) => {
    const page = parsePage(req);
    if (page === undefined)
      return res.status(400).json(apiError(400, "page must be a whole number from 1", "invalid_request"));
    const userId = userOf(res).id;
    const [rows, total] = await Promise.all([
      core.jobs.listByConsumer(userId, PAGE_SIZE, (page - 1) * PAGE_SIZE),
      core.jobs.countByConsumer(userId),
    ]);
    res.json({
      page,
      pageSize: PAGE_SIZE,
      total,
      jobs: rows.map((j) => ({
        id: j.id,
        model: j.modelId,
        status: j.status,
        source: j.source,
        promptTokens: j.promptTokens,
        completionTokens: j.completionTokens,
        credits: j.credits,
        createdAt: j.createdAt,
        finishedAt: j.finishedAt,
        servedBy: j.servedBy,
        vote: j.vote,
      })),
    });
  });

  app.put("/jobs/:id/vote", requireSession, async (req, res) => {
    const body = voteBody.safeParse(req.body);
    if (!body.success) return res.status(400).json(apiError(400, "Send value: 1 or -1", "invalid_request"));
    const id = String(req.params.id);
    const ok = UUID.test(id) && (await core.jobs.vote(userOf(res).id, id, body.data.value));
    if (!ok) return res.status(404).json(apiError(404, "Job not found", "not_found"));
    res.json({ ok: true, value: body.data.value });
  });
}
