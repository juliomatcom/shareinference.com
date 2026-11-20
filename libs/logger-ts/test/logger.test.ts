import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, startTimer } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

function spies() {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const raw = (spy: typeof out) => spy.mock.calls.map((c) => String(c[0]));
  const lines = (spy: typeof out) => raw(spy).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { out, err, raw, lines };
}

describe("createLogger", () => {
  it("writes one line per event with the keys in envelope order", () => {
    const s = spies();
    createLogger("api", "http").info("hello", { a: 1 });
    const [line] = s.raw(s.out);
    expect(line!.endsWith("\n")).toBe(true);
    const event = JSON.parse(line!);
    expect(Object.keys(event)).toEqual(["timestamp", "severity", "app", "module", "message", "context"]);
    expect(event).toMatchObject({ severity: "INFO", app: "api", module: "http", message: "hello", context: { a: 1 } });
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("omits context when none is given", () => {
    const s = spies();
    createLogger("api", "http").info("bare");
    expect(Object.keys(s.lines(s.out)[0]!)).toEqual(["timestamp", "severity", "app", "module", "message"]);
  });

  it("maps levels to severities and splits streams: debug and info to stdout, warn and error to stderr", () => {
    const s = spies();
    const log = createLogger("api", "db", { level: "debug" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(s.lines(s.out).map((e) => e.severity)).toEqual(["DEBUG", "INFO"]);
    expect(s.lines(s.err).map((e) => e.severity)).toEqual(["WARNING", "ERROR"]);
  });

  it("filters below the level (default info)", () => {
    const s = spies();
    const info = createLogger("api", "db");
    info.debug("hidden");
    info.info("shown");
    const warn = createLogger("api", "db", { level: "warn" });
    warn.info("hidden");
    warn.warn("shown");
    const error = createLogger("api", "db", { level: "error" });
    error.warn("hidden");
    error.error("shown");
    expect(s.lines(s.out).map((e) => e.message)).toEqual(["shown"]);
    expect(s.lines(s.err).map((e) => e.message)).toEqual(["shown", "shown"]);
  });

  it("serializes errors, nested causes and bigints", () => {
    const s = spies();
    const error = new Error("fetch failed", { cause: new TypeError("connect", { cause: { code: "ECONNREFUSED" } }) });
    createLogger("api", "ws").error("failed", { error, n: 10n, list: [new Error("in array")] });
    const { context } = s.lines(s.err)[0] as { context: Record<string, any> };
    expect(context.error).toMatchObject({ name: "Error", message: "fetch failed" });
    expect(typeof context.error.stack).toBe("string");
    expect(context.error.cause).toMatchObject({ name: "TypeError", message: "connect" });
    expect(context.error.cause.cause).toEqual({ code: "ECONNREFUSED" });
    expect(context.n).toBe("10");
    expect(context.list[0]).toMatchObject({ name: "Error", message: "in array" });
  });

  it("survives circular references and bounds depth", () => {
    const s = spies();
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const shared = { x: 1 };
    const selfCause = new Error("a");
    selfCause.cause = selfCause;
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 50; i++) deep = { next: deep };
    createLogger("api", "http").info("odd", { cyclic, twice: [shared, shared], selfCause, deep });
    const text = s.raw(s.out)[0]!;
    const { context } = JSON.parse(text) as { context: Record<string, any> };
    expect(context.cyclic).toEqual({ name: "loop", self: "[Circular]" });
    expect(context.twice).toEqual([{ x: 1 }, { x: 1 }]);
    expect(context.selfCause.cause).toBe("[Circular]");
    expect(text).toContain("[MaxDepth]");
  });

  it("never throws, whatever the context", () => {
    const s = spies();
    const hostile = {
      get boom(): string {
        throw new Error("getter");
      },
    };
    expect(() => createLogger("api", "http").info("x", hostile)).not.toThrow();
    expect(s.lines(s.out)[0]!.context).toEqual({ serializationError: "getter" });
  });
});

describe("startTimer", () => {
  it("returns elapsed milliseconds", async () => {
    const elapsed = startTimer();
    await new Promise((r) => setTimeout(r, 20));
    expect(elapsed()).toBeGreaterThanOrEqual(15);
  });
});
