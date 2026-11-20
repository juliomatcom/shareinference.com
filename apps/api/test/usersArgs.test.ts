import { describe, expect, it } from "vitest";
import { UsageError, parseUsersArgs } from "../src/usersArgs.js";

describe("users CLI arguments", () => {
  it("parses each command", () => {
    expect(parseUsersArgs(["list"])).toEqual({ name: "list" });
    expect(parseUsersArgs(["ledger:check"])).toEqual({ name: "ledger:check" });
    expect(parseUsersArgs(["suspend", "alice"])).toEqual({ name: "suspend", handle: "alice" });
    expect(parseUsersArgs(["dev-session", "alice"])).toEqual({ name: "dev-session", handle: "alice" });
    expect(parseUsersArgs(["throttle", "alice", "5", "100"])).toEqual({
      name: "throttle",
      handle: "alice",
      perMin: 5,
      perDay: 100,
    });
    expect(parseUsersArgs(["credit", "alice", "-50", "refund", "for", "outage"])).toEqual({
      name: "credit",
      handle: "alice",
      amount: -50,
      reason: "refund for outage",
    });
  });

  it.each([
    [[]],
    [["nope"]],
    [["suspend"]],
    [["throttle", "alice", "0", "10"]],
    [["throttle", "alice", "x", "10"]],
    [["credit", "alice", "10"]],
    [["credit", "alice", "0", "why"]],
    [["credit", "alice", "1.5", "why"]],
    [["credit", "alice", "1000000000001", "why"]],
    [["credit", "alice", "10", "x".repeat(201)]],
  ])("rejects %j with the usage text", (argv) => {
    expect(() => parseUsersArgs(argv)).toThrow(UsageError);
  });

  it("the usage labels dev-session as a dev/test tool", () => {
    expect(() => parseUsersArgs([])).toThrow(/DEV\/TEST ONLY/);
  });
});
