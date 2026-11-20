import type { Express, RequestHandler } from "express";
import type { Deps } from "../../core/deps.js";
import { ownWorkerStats, publicModels } from "../../core/workers.js";
import { userOf } from "./principal.js";

/** Provider-side routes: worker tokens and own stats (session), plus the two public ones the Share page reads. */
export function workerRoutes(
  app: Express,
  opts: { core: Deps; requireSession: RequestHandler; apiPublicUrl: string },
): void {
  const { core, requireSession, apiPublicUrl } = opts;
  // Public routes are cached a few seconds (wiki-llm/api.md); the global default is no-store.
  const cachePublic: RequestHandler = (_req, res, next) => {
    res.set("Cache-Control", "public, max-age=5");
    next();
  };

  app.post("/worker-token", requireSession, (_req, res) => {
    res.json(core.workerTokens.issue(userOf(res).id));
  });

  app.get("/worker/stats", requireSession, async (_req, res) => {
    res.json(await ownWorkerStats(core, userOf(res).id));
  });

  // D39: the web learns where the api lives at runtime (no rebuild per deployment).
  app.get("/public/config", cachePublic, (_req, res) => {
    res.json({ apiPublicUrl });
  });

  app.get("/public/models", cachePublic, async (_req, res) => {
    res.json({ models: await publicModels(core) });
  });
}
