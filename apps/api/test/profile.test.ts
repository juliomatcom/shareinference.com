import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/adapters/postgres/db.js";
import { deviceLabel, isDisplayName, isReservedName, printableText } from "../src/core/validation.js";
import {
  createHarness,
  createTestDb,
  profile,
  sameOrigin,
  signInAs,
  testDatabaseUrl,
  type Harness,
} from "./helpers/harness.js";

describe("validation", () => {
  it.each([
    ["abc", true],
    ["a".repeat(32), true],
    ["Name_with-dash9", true],
    ["ab", false],
    ["a".repeat(33), false],
    ["has space", false],
    ["café", false],
    ["", false],
  ])("display name %j -> %s", (name, ok) => expect(isDisplayName(name)).toBe(ok));

  it("device label: empty clears, 40 printable characters max, no control characters", () => {
    expect(deviceLabel("")).toBeNull();
    expect(deviceLabel("   ")).toBeNull();
    expect(deviceLabel(null)).toBeNull();
    expect(deviceLabel("  MacBook Pro M5  ")).toBe("MacBook Pro M5");
    expect(deviceLabel("x".repeat(40))).toBe("x".repeat(40));
    expect(deviceLabel("x".repeat(41))).toBeUndefined();
    expect(deviceLabel("a\nb")).toBeUndefined();
    expect(deviceLabel("a‮b")).toBeUndefined();
    expect(printableText("\u{1F600}".repeat(39) + "a", 40)).toBeDefined();
  });

  it("text must show something and avoid blank-looking or stacked marks", () => {
    expect(printableText("\u{1F600}\u{1F600}", 40)).toBeUndefined(); // no letter or digit
    expect(printableText("---", 40)).toBeUndefined();
    expect(printableText("RTX 4090", 40)).toBe("RTX 4090");
    expect(printableText("M\u00fcnchen \u65e5\u672c", 40)).toBeDefined();
    for (const blank of ["\u3164", "\u2800", "\u115F", "\u1160", "\uFFA0"]) {
      expect(printableText(`a${blank}b`, 40), blank.codePointAt(0)!.toString(16)).toBeUndefined();
      expect(printableText(blank, 40)).toBeUndefined();
    }
    expect(printableText("a\u200Bb", 40)).toBeUndefined(); // Cf
    expect(printableText("a\u0301\u0302b", 40)).toBeDefined(); // two marks are fine
    expect(printableText("a\u0301\u0302\u0303b", 40)).toBeUndefined(); // three are a stack
  });

  it("reserved names are matched case-insensitively", () => {
    for (const name of ["admin", "ADMIN", "Root", "ShareInference", "undefined", "mod", "staff"]) {
      expect(isReservedName(name), name).toBe(true);
    }
    expect(isReservedName("moderator1")).toBe(false);
    expect(isReservedName("alice")).toBe(false);
  });
});

describe.skipIf(!testDatabaseUrl)("PATCH /me", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let h: Harness;
  let alice: string;

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    h = createHarness(db);
    alice = await signInAs(h, profile(1, "alice"));
    await signInAs(h, profile(2, "torvalds"));
    await signInAs(h, profile(3, "someone"));
    await db("users").where({ github_id: 3 }).update({ display_name: "TakenName" });
  });
  afterAll(() => drop());

  const patch = (body: unknown) =>
    request(h.app)
      .patch("/me")
      .set("Cookie", alice)
      .set(sameOrigin)
      .send(body as object);

  it("updates display name and device label", async () => {
    const res = await patch({ displayName: "Alice_GPU", deviceLabel: "  Gaming PC " });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ displayName: "Alice_GPU", deviceLabel: "Gaming PC", githubLogin: "alice" });
    const cleared = await patch({ deviceLabel: "" });
    expect(cleared.body.deviceLabel).toBeNull();
    expect((await request(h.app).get("/me").set("Cookie", alice)).body.displayName).toBe("Alice_GPU");
  });

  it.each([
    [{ displayName: "ab" }, "invalid_display_name"],
    [{ displayName: "has space" }, "invalid_display_name"],
    [{ displayName: "x".repeat(33) }, "invalid_display_name"],
    [{ deviceLabel: "x".repeat(41) }, "invalid_device_label"],
    [{ deviceLabel: "bell\u0007" }, "invalid_device_label"],
  ])("rejects %j with %s", async (body, code) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ type: "invalid_request_error", code });
  });

  it("rejects a display name that is another user's display name, in any case", async () => {
    for (const name of ["TakenName", "takenname"]) {
      const res = await patch({ displayName: name });
      expect(res.status, name).toBe(400);
      expect(res.body.error.code).toBe("display_name_taken");
    }
  });

  it("rejects a display name equal to another user's GitHub login (impersonation), but allows your own", async () => {
    for (const name of ["torvalds", "Torvalds"]) {
      const res = await patch({ displayName: name });
      expect(res.status, name).toBe(400);
      expect(res.body.error.code).toBe("display_name_taken");
    }
    expect((await patch({ displayName: "alice" })).status).toBe(200);
  });

  it("rejects reserved display names in any case", async () => {
    for (const name of ["admin", "Support", "SHAREINFERENCE", "null"]) {
      const res = await patch({ displayName: name });
      expect(res.status, name).toBe(400);
      expect(res.body.error.code).toBe("display_name_taken");
    }
  });

  it("rejects device labels that show nothing", async () => {
    for (const label of ["\u3164", "\u2800\u2800", "\u{1F600}", "a\u0301\u0302\u0303"]) {
      const res = await patch({ deviceLabel: label });
      expect(res.status, JSON.stringify(label)).toBe(400);
      expect(res.body.error.code).toBe("invalid_device_label");
    }
  });

  it("rejects empty, unknown and mistyped bodies", async () => {
    for (const body of [{}, { nope: 1 }, { displayName: 5 }, { displayName: "abc", extra: true }]) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
  });
});
