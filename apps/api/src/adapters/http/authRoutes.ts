import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { SESSION_TTL_MS, endSession, signIn } from "../../core/auth.js";
import { SESSION_COOKIE, STATE_COOKIE, cookieOf, cookieOptions, safeEqual } from "./cookies.js";
import type { AppOptions } from "./app.js";

const COOKIE_STATE_TTL_MS = 10 * 60 * 1000;
const callbackQuery = z.object({ code: z.string().min(1).max(512), state: z.string().min(1).max(512) });

/** Sign-in with GitHub and sign-out (wiki-llm/api.md). Never logs codes, tokens or cookies. */
export function authRoutes(app: Express, opts: AppOptions & { requireSession: RequestHandler }): void {
  const { authLog: log, core, github, webOrigin } = opts;
  const failed = `${webOrigin}/?signin=failed`;

  app.get("/auth/github", (_req, res) => {
    const state = core.secrets.token();
    res.cookie(STATE_COOKIE, state, cookieOptions(webOrigin, COOKIE_STATE_TTL_MS));
    res.redirect(302, github.authorizeUrl(state));
  });

  app.get("/auth/github/callback", async (req, res) => {
    // Whatever goes wrong, the visitor lands on the failure page; the cause goes to the log (never the code or state).
    try {
      const saved = cookieOf(req, STATE_COOKIE);
      // The state is single use, whatever happens next.
      res.clearCookie(STATE_COOKIE, cookieOptions(webOrigin));
      const query = callbackQuery.safeParse(req.query);
      if (!query.success || !saved || !safeEqual(query.data.state, saved)) {
        log.warn("sign-in rejected", { reason: "state" });
        return res.redirect(302, failed);
      }
      const profile = await github.exchangeCode(query.data.code);
      const result = await signIn(core, profile);
      if (!result.ok) {
        log.warn("sign-in rejected", { reason: result.reason, github_id: profile.githubId });
        return res.redirect(302, failed);
      }
      if (result.displaced.length > 0) {
        log.warn("display name released to its GitHub login", { user_id: result.user.id, released: result.displaced });
      }
      res.cookie(SESSION_COOKIE, result.token, cookieOptions(webOrigin, SESSION_TTL_MS));
      log.info("signed in", { user_id: result.user.id, created: result.created });
      res.redirect(302, `${webOrigin}/dashboard`);
    } catch (error) {
      log.error("sign-in failed", { error });
      res.redirect(302, failed);
    }
  });

  app.post("/auth/logout", opts.requireSession, async (req, res) => {
    const token = cookieOf(req, SESSION_COOKIE);
    if (token) await endSession(core, token);
    res.clearCookie(SESSION_COOKIE, cookieOptions(webOrigin));
    res.json({ ok: true });
  });
}
