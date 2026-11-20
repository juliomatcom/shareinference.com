import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import helmet from "helmet";
import { authenticateApiKey, authenticateSession, type Authn } from "../../core/auth.js";
import type { Deps } from "../../core/deps.js";
import { IP_LIMITS, createIpLimiter } from "../../core/ipLimiter.js";
import type { GithubOAuth, Logger } from "../../core/ports.js";
import { accountRoutes } from "./accountRoutes.js";
import { authRoutes } from "./authRoutes.js";
import { clientIp } from "./clientIp.js";
import { cors } from "./cors.js";
import { SESSION_COOKIE, cookieOf } from "./cookies.js";
import { apiError } from "./errors.js";
import { jobRoutes } from "./jobRoutes.js";
import { principalOf } from "./principal.js";
import { publicRoutes } from "./publicRoutes.js";
import { v1Routes } from "./v1Routes.js";
import { workerRoutes } from "./workerRoutes.js";

/** Routes reachable without credentials ("METHOD /path"). Everything else is denied. Mirrors wiki-llm/api.md. */
export const PUBLIC_ROUTES = new Set([
  "GET /healthz",
  "GET /auth/github",
  "GET /auth/github/callback",
  "GET /public/config",
  "GET /public/models",
  "GET /public/stats",
  "GET /public/leaderboard",
]);

export interface AppOptions {
  /** Logger of module `http`. */
  log: Logger;
  /** Logger of module `auth`: sign-in and API keys. */
  authLog: Logger;
  core: Deps;
  github: GithubOAuth;
  /** The web app's origin: cookie `Secure` flag, post-login redirects and the CSRF `Origin` check. */
  webOrigin: string;
  /** The api's public URL, handed to the Share page (`GET /public/config`). */
  apiPublicUrl: string;
  /** Per-IP limits read `X-Real-IP` (set by the reverse proxy) instead of the socket address. Default false. */
  trustProxy?: boolean;
  /** Per-IP limit overrides (tests); defaults in `IP_LIMITS`. */
  ipLimits?: Partial<Record<keyof typeof IP_LIMITS, number>>;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const JSON_TYPE = /^application\/json\s*(;|$)/i;

/** Session-only routes: an API key is not a browser session. */
const requireSession: RequestHandler = (_req, res, next) => {
  if (principalOf(res).via !== "session") {
    res.status(401).json(apiError(401, "A signed-in session is required", "unauthorized"));
    return;
  }
  next();
};

export function createApp(opts: AppOptions): express.Express {
  const { log, core, webOrigin } = opts;
  const app = express();
  app.disable("x-powered-by");
  // A JSON api: HSTS belongs to the TLS terminator (it would also pin plain-http local hosts), and the default CSP's
  // upgrade-insecure-requests would break plain-http use (localhost, a VM).
  app.use(
    helmet({
      hsts: false,
      contentSecurityPolicy: { useDefaults: true, directives: { "upgrade-insecure-requests": null } },
    }),
  );

  // Per-IP limits on the anonymous surface (wiki-llm/api.md "Limits"); consumer limits are per user.
  const limits = { ...IP_LIMITS, ...opts.ipLimits };
  const publicLimiter = createIpLimiter(core, limits.publicPerMin);
  const authLimiter = createIpLimiter(core, limits.authPerMin);
  const failedAuthLimiter = createIpLimiter(core, limits.failedAuthPerMin);
  const tooMany = (res: express.Response) => {
    res.set("Retry-After", "60");
    res.status(429).json(apiError(429, "Too many requests from this address; try again later", "rate_limited"));
  };

  // Deny by default: a request needs a valid session cookie or API key unless its route is public. Runs before body
  // parsing so unauthenticated requests never get their body read.
  const authenticate: RequestHandler = async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const ip = clientIp(req, opts.trustProxy ?? false);
    if (req.path.startsWith("/auth/") && !authLimiter.hit(ip)) return tooMany(res);
    if (PUBLIC_ROUTES.has(`${req.method} ${req.path}`)) {
      // The compose healthcheck and uptime probes must never be refused.
      if (req.path !== "/healthz" && !publicLimiter.hit(ip)) return tooMany(res);
      return next();
    }

    const header = req.get("authorization");
    const cookie = header === undefined ? cookieOf(req, SESSION_COOKIE) : undefined;
    // Valid credentials are never limited here; only an address that keeps presenting bad ones is (below).
    const credentialed = header !== undefined || cookie !== undefined;
    let result: Authn;
    if (header !== undefined) {
      const key = /^Bearer (\S+)$/.exec(header)?.[1];
      result = key ? await authenticateApiKey(core, key) : { ok: false, reason: "unauthorized" };
    } else {
      result = cookie ? await authenticateSession(core, cookie) : { ok: false, reason: "unauthorized" };
    }
    if (!result.ok) {
      if (result.reason === "suspended") {
        res.status(403).json(apiError(403, "Account suspended", "suspended"));
      } else if (credentialed && !failedAuthLimiter.hit(ip)) {
        tooMany(res); // guessing keys or sessions: past the allowance the 401 becomes a 429
      } else {
        res.status(401).json(apiError(401, "Authentication required", "unauthorized"));
      }
      return;
    }
    // CSRF: a cookie is sent along with cross-site requests, so state-changing calls must prove they come from our
    // own page (JSON content type cannot be sent by a plain cross-site form; Origin must be the web app).
    if (result.via === "session" && !SAFE_METHODS.has(req.method)) {
      if (!JSON_TYPE.test(req.get("content-type") ?? "") || req.get("origin") !== webOrigin) {
        res.status(403).json(apiError(403, "Cross-site request rejected", "csrf"));
        return;
      }
    }
    res.locals.auth = result;
    next();
  };
  app.use(cors(webOrigin));
  app.use(authenticate);
  app.use(express.json({ limit: "256kb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  authRoutes(app, { ...opts, requireSession });
  accountRoutes(app, { core, log: opts.authLog, requireSession });
  workerRoutes(app, { core, requireSession, apiPublicUrl: opts.apiPublicUrl });
  publicRoutes(app, { core });
  jobRoutes(app, { core, requireSession });
  v1Routes(app, { core, requireSession });

  // Reachable only once authenticated (everything unauthenticated is already 401).
  app.use((_req, res) => {
    res.status(404).json(apiError(404, "Not found", "not_found"));
  });

  const onError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) log.error("unhandled error", { error: err });
    // Never leak internals or stack traces.
    res
      .status(status)
      .json(
        status === 500
          ? apiError(500, "Internal server error", "internal_error")
          : apiError(status, "Invalid request", "invalid_request"),
      );
  };
  app.use(onError);
  return app;
}
