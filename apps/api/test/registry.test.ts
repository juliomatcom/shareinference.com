import { describe, expect, it } from "vitest";
import type { Secrets } from "../src/core/ports.js";
import { MAX_WORKERS_PER_USER, PERSIST_EVERY_MS, SILENCE_MS, createRegistry } from "../src/core/registry.js";
import { nodeSecrets } from "../src/adapters/secrets.js";
import { FakeClock } from "./helpers/harness.js";

const GPU = { vendor: "apple", architecture: "metal-3", shaderF16: true, maxBufferSize: 1 };
const MODEL = { id: "qwen3.5-4b", webllmId: "Qwen3.5-4B-q4f16_1-MLC" };

function setup(secrets: Secrets = nodeSecrets) {
  const clock = new FakeClock();
  return { clock, registry: createRegistry({ clock, secrets }) };
}
type Registry = ReturnType<typeof setup>["registry"];

function readyWorker(registry: Registry, id: string, userId: string, model = MODEL) {
  expect(registry.register(id, userId, `device-${id}`).ok).toBe(true);
  expect(registry.markReady(id, model, GPU)).toBe(true);
}

describe("worker registry", () => {
  it("moves connected -> ready (idle) -> busy -> ready", () => {
    const { registry } = setup();
    registry.register("w1", "u1", "device-one");
    expect(registry.get("w1")!.state).toBe("connected");
    expect(registry.onlineCount(MODEL.webllmId)).toBe(0);
    expect(registry.markBusy("w1", "j1")).toBe(false); // not ready yet
    expect(registry.markReady("w1", MODEL, GPU)).toBe(true);
    expect(registry.markReady("w1", MODEL, GPU)).toBe(false); // only once
    expect(registry.onlineCount(MODEL.webllmId)).toBe(1);
    expect(registry.markBusy("w1", "j1")).toBe(true);
    expect(registry.markBusy("w1", "j2")).toBe(false);
    expect(registry.get("w1")).toMatchObject({ state: "busy", jobId: "j1" });
    expect(registry.onlineCount(MODEL.webllmId)).toBe(1); // busy still counts as online
    expect(registry.markIdle("w1")).toBe(true);
    expect(registry.get("w1")).toMatchObject({ state: "ready", jobId: null });
  });

  it("onlineCount can leave out one user's own workers", () => {
    const { registry } = setup();
    readyWorker(registry, "mine", "u1");
    expect(registry.onlineCount(MODEL.webllmId, "u1")).toBe(0);
    readyWorker(registry, "theirs", "u2");
    expect(registry.onlineCount(MODEL.webllmId, "u1")).toBe(1);
    expect(registry.onlineCount(MODEL.webllmId)).toBe(2);
  });

  it("drops a worker silent for more than 15 s, keeps one that heartbeats", () => {
    const { registry, clock } = setup();
    readyWorker(registry, "silent", "u1");
    readyWorker(registry, "alive", "u2");
    clock.advance(10_000);
    registry.heartbeat("alive");
    clock.advance(SILENCE_MS - 10_000); // silent: exactly 15 s -> still there
    expect(registry.sweep()).toEqual([]);
    clock.advance(1);
    expect(registry.sweep().map((w) => w.id)).toEqual(["silent"]);
    expect(registry.get("silent")).toBeUndefined();
    expect(registry.get("alive")).toBeDefined();
    expect(registry.onlineCount(MODEL.webllmId)).toBe(1);
  });

  it("asks to persist last_seen_at at most once a minute", () => {
    const { registry, clock } = setup();
    registry.register("w1", "u1", "device-one");
    clock.advance(5_000);
    expect(registry.heartbeat("w1")).toBe(false);
    clock.advance(PERSIST_EVERY_MS);
    expect(registry.heartbeat("w1")).toBe(true);
    clock.advance(5_000);
    expect(registry.heartbeat("w1")).toBe(false);
    expect(registry.heartbeat("unknown")).toBe(false);
  });

  it(`refuses a user's ${MAX_WORKERS_PER_USER + 1}th device, but not other users or a reconnecting device`, () => {
    const { registry } = setup();
    for (let i = 0; i < MAX_WORKERS_PER_USER; i++) {
      expect(registry.canRegister("u1", `device-${i}`)).toBe(true);
      expect(registry.register(`w${i}`, "u1", `device-${i}`)).toEqual({ ok: true, replaced: false });
    }
    expect(registry.canRegister("u1", "device-new")).toBe(false);
    expect(registry.register("w-new", "u1", "device-new")).toEqual({ ok: false });
    expect(registry.canRegister("u1", "device-2")).toBe(true);
    expect(registry.register("w2", "u1", "device-2")).toEqual({ ok: true, replaced: true });
    expect(registry.byUser("u1")).toHaveLength(MAX_WORKERS_PER_USER);
    expect(registry.register("other", "u2", "device-x").ok).toBe(true);
    registry.unregister("w0");
    expect(registry.register("w-new", "u1", "device-new").ok).toBe(true);
  });

  it("caps the total number of workers", () => {
    const clock = new FakeClock();
    const registry = createRegistry({ clock, secrets: nodeSecrets, maxTotal: 2 });
    expect(registry.register("a", "u1", "device-a").ok).toBe(true);
    expect(registry.register("b", "u2", "device-b").ok).toBe(true);
    expect(registry.register("c", "u3", "device-c").ok).toBe(false);
  });

  describe("pickRandomIdle", () => {
    it("never returns the owner's worker (D21), a busy one, a connected one or another model's", () => {
      const { registry } = setup();
      readyWorker(registry, "mine1", "owner");
      readyWorker(registry, "mine2", "owner");
      readyWorker(registry, "other-model", "u2", { id: "x", webllmId: "Other-MLC" });
      readyWorker(registry, "busy", "u3");
      registry.markBusy("busy", "j");
      registry.register("loading", "u4", "device-loading");
      for (let i = 0; i < 200; i++) expect(registry.pickRandomIdle(MODEL.webllmId, "owner")).toBeUndefined();
      readyWorker(registry, "theirs", "u5");
      for (let i = 0; i < 200; i++) expect(registry.pickRandomIdle(MODEL.webllmId, "owner")!.id).toBe("theirs");
    });

    it("skips workers whose owner was flagged suspended", () => {
      const { registry } = setup();
      readyWorker(registry, "bad1", "badguy");
      readyWorker(registry, "bad2", "badguy");
      readyWorker(registry, "good", "goodguy");
      registry.markSuspended("badguy");
      for (let i = 0; i < 100; i++) expect(registry.pickRandomIdle(MODEL.webllmId, "owner")!.id).toBe("good");
      registry.unregister("good");
      expect(registry.pickRandomIdle(MODEL.webllmId, "owner")).toBeUndefined();
    });

    it("is random across every eligible worker", () => {
      const { registry } = setup();
      for (const [i, u] of ["a", "b", "c", "d"].entries()) readyWorker(registry, `w${i}`, u);
      readyWorker(registry, "own", "owner");
      const seen = new Set<string>();
      for (let i = 0; i < 400; i++) seen.add(registry.pickRandomIdle(MODEL.webllmId, "owner")!.id);
      expect([...seen].sort()).toEqual(["w0", "w1", "w2", "w3"]);
    });

    it("draws through the Secrets port (index into the eligible list)", () => {
      const fixed: Secrets = { ...nodeSecrets, int: () => 1 };
      const { registry } = setup(fixed);
      readyWorker(registry, "w0", "a");
      readyWorker(registry, "w1", "b");
      readyWorker(registry, "w2", "c");
      expect(registry.pickRandomIdle(MODEL.webllmId, "owner")!.id).toBe("w1");
    });
  });
});

describe("worker registry: loaded context window", () => {
  it("only offers and counts workers whose window fits the job; a tab that does not say has 4096", () => {
    const { registry } = setup();
    readyWorker(registry, "old", "u1"); // no window announced
    expect(registry.get("old")!.contextWindow).toBe(4096);
    registry.register("new", "u2", "device-new");
    expect(registry.markReady("new", MODEL, GPU, 16_384)).toBe(true);

    expect(registry.onlineCount(MODEL.webllmId)).toBe(2);
    expect(registry.onlineCount(MODEL.webllmId, undefined, 8_000)).toBe(1);
    expect(registry.onlineCount(MODEL.webllmId, undefined, 20_000)).toBe(0);
    for (let i = 0; i < 20; i++) {
      expect(registry.pickRandomIdle(MODEL.webllmId, "consumer", undefined, 8_000)?.id).toBe("new");
    }
    expect(registry.pickRandomIdle(MODEL.webllmId, "consumer", undefined, 20_000)).toBeUndefined();
  });
});
