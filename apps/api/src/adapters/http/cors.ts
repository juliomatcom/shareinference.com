import type { RequestHandler } from "express";

// CORS (wiki-llm/api.md "CORS"). Runs before authentication so a preflight, which carries no credentials, is answered
// instead of hitting deny-by-default. Credentials are never allowed cross-origin: the web app reaches the session
// routes same-origin through its /api rewrite.

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Routes that only a Bearer key or nothing authenticates: any page may call them. */
const isOpen = (path: string, method: string): boolean =>
  path.startsWith("/v1/") || ((path.startsWith("/public/") || path === "/healthz") && READ_METHODS.has(method));

// A header-name token; anything else in a requested list is dropped.
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const OPEN_HEADERS = ["Authorization", "Content-Type", "Accept", "OpenAI-Organization", "OpenAI-Project"];

/** Open routes accept the headers the preflight asks for: the OpenAI SDKs send many `x-stainless-*` ones that change. */
function openAllowedHeaders(requested: string | undefined): string {
  const asked = (requested ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => HEADER_NAME.test(h));
  const known = new Set(OPEN_HEADERS.map((h) => h.toLowerCase()));
  return [...OPEN_HEADERS, ...asked.filter((h) => !known.has(h.toLowerCase()))].join(", ");
}

export function cors(webOrigin: string): RequestHandler {
  return (req, res, next) => {
    const origin = req.get("origin");
    const preflight = req.method === "OPTIONS";
    if (isOpen(req.path, req.method)) {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Expose-Headers", "Retry-After");
      // Helmet's default would stop other origins from reading these responses.
      res.set("Cross-Origin-Resource-Policy", "cross-origin");
      if (preflight) {
        res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.set("Access-Control-Allow-Headers", openAllowedHeaders(req.get("access-control-request-headers")));
        res.set("Access-Control-Max-Age", "600");
        res.sendStatus(204);
        return;
      }
    } else if (origin === webOrigin) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Expose-Headers", "Retry-After");
      if (preflight) {
        res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE");
        res.set("Access-Control-Allow-Headers", "Content-Type, Accept");
        res.set("Access-Control-Max-Age", "600");
        res.sendStatus(204);
        return;
      }
    }
    next();
  };
}
