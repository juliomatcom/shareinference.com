import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/core/rateLimiter.js";
import { FakeClock } from "./helpers/harness.js";

function setup() {
  const clock = new FakeClock();
  return { clock, limiter: createRateLimiter({ clock }) };
}

describe("rate limiter", () => {
  it("fair lane: 1 concurrent request", () => {
    const { limiter } = setup();
    const release = limiter.acquire("u", "fair", null)!;
    expect(release).toBeTypeOf("function");
    expect(limiter.acquire("u", "fair", null)).toBeUndefined();
    release();
    release(); // twice changes nothing
    expect(limiter.acquire("u", "fair", null)).toBeTypeOf("function");
  });

  it("fair lane: 10 per minute, then the window slides", () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 10; i++) limiter.acquire("u", "fair", null)!();
    expect(limiter.acquire("u", "fair", null)).toBeUndefined();
    clock.advance(60_000);
    expect(limiter.acquire("u", "fair", null)).toBeTypeOf("function");
  });

  it("fair lane: 500 per day", () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 500; i++) {
      limiter.acquire("u", "fair", null)!();
      clock.advance(61_000); // never the per-minute limit
    }
    expect(clock.now().getTime() - new Date("2026-01-01T00:00:00Z").getTime()).toBeLessThan(24 * 3600_000);
    expect(limiter.acquire("u", "fair", null)).toBeUndefined();
    clock.advance(24 * 3600_000);
    expect(limiter.acquire("u", "fair", null)).toBeTypeOf("function");
  });

  it("priority lane: 60 per minute and 4 concurrent", () => {
    const { limiter } = setup();
    const held = [1, 2, 3, 4].map(() => limiter.acquire("u", "priority", null)!);
    expect(held.every((r) => typeof r === "function")).toBe(true);
    expect(limiter.acquire("u", "priority", null)).toBeUndefined();
    held.forEach((r) => r());
    for (let i = 4; i < 60; i++) limiter.acquire("u", "priority", null)!();
    expect(limiter.acquire("u", "priority", null)).toBeUndefined();
  });

  it("users do not share limits", () => {
    const { limiter } = setup();
    expect(limiter.acquire("a", "fair", null)).toBeTypeOf("function");
    expect(limiter.acquire("b", "fair", null)).toBeTypeOf("function");
  });

  it("an override replaces the per-minute and per-day numbers", () => {
    const { limiter } = setup();
    const o = { perMin: 2, perDay: 3 };
    limiter.acquire("u", "priority", o)!();
    limiter.acquire("u", "priority", o)!();
    expect(limiter.acquire("u", "priority", o)).toBeUndefined();
  });
});
