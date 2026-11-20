import type { RequestHandler } from "express";
import { apiError } from "./errors.js";

// Keeps crawlers out of the api (wiki-llm/api.md "Crawlers"). Three layers: a `noindex` header on every response, a
// robots.txt that disallows everything, and a refusal of self-identified bots that present no credentials. The last is
// courtesy enforcement only: a bot that lies about its User-Agent is stopped by authentication and the per-IP limits,
// like any anonymous caller.
export const ROBOTS_TAG = "noindex, nofollow, noarchive, nosnippet, noimageindex";
export const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

// Self-identified crawlers, AI trainers and scrapers, matched on bot-like tokens rather than loose substrings (so
// `CUBOT` phones or `Boto3` are not caught). Keep in step with `botpattern` in ops/caddy/Caddyfile. Anything that
// sends credentials (an API key or a session cookie) is a customer, whatever its User-Agent says.
const BOT_UA =
  /[a-z]bot\b|\bbot\b|bot\/|crawl|spider|scrapy|scraper|slurp|gptbot|chatgpt|oai-searchbot|claudebot|claude-web|claude-user|claude-searchbot|anthropic-ai|perplexitybot|perplexity-user|bytespider|ccbot|ahrefs|semrush|mj12|diffbot|facebookexternalhit|embedly/i;

export const robotsTag: RequestHandler = (_req, res, next) => {
  res.set("X-Robots-Tag", ROBOTS_TAG);
  next();
};

export const robotsTxt: RequestHandler = (_req, res) => {
  res.type("text/plain").send(ROBOTS_TXT);
};

export const blockBots: RequestHandler = (req, res, next) => {
  const exempt = req.path === "/robots.txt" || req.path === "/healthz";
  const credentialed = req.get("authorization") !== undefined || req.get("cookie") !== undefined;
  if (!exempt && !credentialed && BOT_UA.test(req.get("user-agent") ?? "")) {
    res.status(403).json(apiError(403, "Automated clients without credentials are not served", "bots_not_allowed"));
    return;
  }
  next();
};
