import type { Express, RequestHandler } from "express";
import type { Deps } from "../../core/deps.js";

/** Read-only aggregates for the landing page: no ids, no private data. Cached 5 s in core. */
export function publicRoutes(app: Express, opts: { core: Deps }): void {
  const { core } = opts;
  // The global default is no-store; these may be shared by browsers and proxies for the cache window.
  const cachePublic: RequestHandler = (_req, res, next) => {
    res.set("Cache-Control", "public, max-age=5");
    next();
  };

  app.get("/public/stats", cachePublic, async (_req, res) => {
    res.json(await core.publicStats.stats());
  });

  app.get("/public/leaderboard", cachePublic, async (_req, res) => {
    res.json(await core.publicStats.leaderboard());
  });
}
