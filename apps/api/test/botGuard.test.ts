import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ROBOTS_TAG, ROBOTS_TXT, blockBots, robotsTag, robotsTxt } from "../src/adapters/http/botGuard.js";

function app() {
  const a = express();
  a.use(robotsTag);
  a.get("/robots.txt", robotsTxt);
  a.use(blockBots);
  a.get("/healthz", (_req, res) => res.json({ ok: true }));
  a.get("/public/stats", (_req, res) => res.json({ ok: true }));
  return a;
}

const UAS = ["Googlebot/2.1", "GPTBot/1.1", "ClaudeBot/1.0", "CCBot/2.0", "PerplexityBot", "Bytespider", "AhrefsBot/7"];

describe("api crawler guard", () => {
  it("serves a disallow-all robots.txt to everyone, bots included", async () => {
    const res = await request(app()).get("/robots.txt").set("User-Agent", "Googlebot/2.1");
    expect(res.status).toBe(200);
    expect(res.text).toBe(ROBOTS_TXT);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
  });

  it("marks every response noindex", async () => {
    expect((await request(app()).get("/public/stats")).headers["x-robots-tag"]).toBe(ROBOTS_TAG);
    expect((await request(app()).get("/nope")).headers["x-robots-tag"]).toBe(ROBOTS_TAG);
  });

  it("refuses self-identified bots without credentials, with the 403 also marked noindex", async () => {
    for (const ua of UAS) {
      const res = await request(app()).get("/public/stats").set("User-Agent", ua);
      expect(res.status, ua).toBe(403);
      expect(res.body.error.code).toBe("bots_not_allowed");
      expect(res.headers["x-robots-tag"]).toBe(ROBOTS_TAG);
    }
  });

  it("does not catch ordinary browsers and SDKs whose User-Agent merely contains `bot`", async () => {
    const ok = [
      "Mozilla/5.0 (Linux; Android 10; CUBOT_X30) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
      "Boto3/1.34 Python/3.12",
      "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0 Safari/537.36",
      "OpenAI/Python 1.40",
    ];
    for (const ua of ok) expect((await request(app()).get("/public/stats").set("User-Agent", ua)).status, ua).toBe(200);
  });

  it("never blocks the health check, normal clients, or anything that carries credentials", async () => {
    expect((await request(app()).get("/healthz").set("User-Agent", "Googlebot/2.1")).status).toBe(200);
    expect((await request(app()).get("/public/stats").set("User-Agent", "OpenAI/JS 4.0")).status).toBe(200);
    expect((await request(app()).get("/public/stats")).status).toBe(200);
    const keyed = await request(app())
      .get("/public/stats")
      .set("User-Agent", "MyDiscordBot/1.0")
      .set("Authorization", "Bearer si_x");
    expect(keyed.status).toBe(200);
  });
});
