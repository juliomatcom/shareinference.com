import { describe, expect, it } from "vitest";
import { nodeSecrets } from "../src/adapters/secrets.js";
import {
  MAX_TOKENS_PER_USER,
  MAX_WORKER_TOKENS,
  WORKER_TOKEN_TTL_MS,
  createWorkerTokens,
} from "../src/core/workerTokens.js";
import { FakeClock } from "./helpers/harness.js";

const make = () => {
  const clock = new FakeClock();
  return { clock, tokens: createWorkerTokens({ secrets: nodeSecrets, clock }) };
};

describe("worker tokens", () => {
  it("issues a 32-byte random token tied to the user, valid for 60 s", () => {
    const { tokens } = make();
    const a = tokens.issue("u1");
    const b = tokens.issue("u1");
    expect(a.expiresInS).toBe(60);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(tokens.redeem(a.token)).toBe("u1");
  });

  it("is single use", () => {
    const { tokens } = make();
    const { token } = tokens.issue("u1");
    expect(tokens.redeem(token)).toBe("u1");
    expect(tokens.redeem(token)).toBeUndefined();
  });

  it("expires after the TTL and rejects unknown tokens", () => {
    const { tokens, clock } = make();
    const { token } = tokens.issue("u1");
    clock.advance(WORKER_TOKEN_TTL_MS);
    expect(tokens.redeem(token)).toBeUndefined();
    expect(tokens.redeem("nope")).toBeUndefined();
    const fresh = tokens.issue("u1");
    clock.advance(WORKER_TOKEN_TTL_MS - 1);
    expect(tokens.redeem(fresh.token)).toBe("u1");
  });

  it("is bounded: the oldest token is evicted first, and one user cannot flush the others", () => {
    const { tokens } = make();
    const first = tokens.issue("victim");
    for (let i = 0; i < MAX_TOKENS_PER_USER * 3; i++) tokens.issue("attacker");
    expect(tokens.redeem(first.token)).toBe("victim");

    const all = Array.from({ length: MAX_WORKER_TOKENS + 1 }, (_, i) => tokens.issue(`user-${i}`));
    expect(tokens.redeem(all[0]!.token)).toBeUndefined();
    expect(tokens.redeem(all[MAX_WORKER_TOKENS]!.token)).toBe(`user-${MAX_WORKER_TOKENS}`);
  });
});
