import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/adapters/postgres/db.js";
import { safeInt } from "../src/adapters/postgres/rows.js";
import {
  MAX_ENTRY_AMOUNT,
  adjustBalance,
  checkLedger,
  findMismatches,
  postEntry,
  validAmount,
} from "../src/core/ledger.js";
import { createHarness, createTestDb, profile, signInAs, testDatabaseUrl, type Harness } from "./helpers/harness.js";

describe("ledger rules", () => {
  it("amount signs follow the entry kind and must be non-zero integers", () => {
    expect(validAmount("grant", 10)).toBe(true);
    expect(validAmount("grant", -10)).toBe(false);
    expect(validAmount("earn", 5)).toBe(true);
    expect(validAmount("earn", -5)).toBe(false);
    expect(validAmount("spend", -5)).toBe(true);
    expect(validAmount("spend", 5)).toBe(false);
    expect(validAmount("adjust", 5)).toBe(true);
    expect(validAmount("adjust", -5)).toBe(true);
    for (const kind of ["grant", "spend", "earn", "adjust"] as const) {
      expect(validAmount(kind, 0)).toBe(false);
      expect(validAmount(kind, 1.5)).toBe(false);
      expect(validAmount(kind, Number.NaN)).toBe(false);
      expect(validAmount(kind, Number.MAX_SAFE_INTEGER + 2)).toBe(false);
    }
  });

  it("an entry amount is capped at 10^12 either way", () => {
    expect(validAmount("adjust", MAX_ENTRY_AMOUNT)).toBe(true);
    expect(validAmount("adjust", -MAX_ENTRY_AMOUNT)).toBe(true);
    expect(validAmount("adjust", MAX_ENTRY_AMOUNT + 1)).toBe(false);
    expect(validAmount("spend", -MAX_ENTRY_AMOUNT - 1)).toBe(false);
    expect(validAmount("grant", Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("database integers outside the safe range throw instead of losing precision", () => {
    expect(safeInt("42")).toBe(42);
    expect(safeInt("-9007199254740991")).toBe(-9007199254740991);
    expect(() => safeInt("9007199254740993")).toThrow(/safe range/);
    expect(() => safeInt("abc")).toThrow();
    expect(() => safeInt(null)).toThrow();
  });

  it("findMismatches flags differing balances and users without a balance row", () => {
    expect(
      findMismatches([
        { userId: "a", balance: 5, entriesSum: 5 },
        { userId: "b", balance: 6, entriesSum: 5 },
        { userId: "c", balance: null, entriesSum: 0 },
        { userId: "d", balance: 0, entriesSum: 0 },
      ]).map((m) => m.userId),
    ).toEqual(["b", "c"]);
  });
});

describe.skipIf(!testDatabaseUrl)("ledger on Postgres", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let h: Harness;
  let userId: string;

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    h = createHarness(db);
    const cookie = await signInAs(h, profile(1, "alice"));
    userId = (await request(h.app).get("/me").set("Cookie", cookie)).body.id;
  });
  afterAll(() => drop());

  const balance = async (id = userId) => Number((await db("balances").where({ user_id: id }).first())!.balance);
  const sum = async (id = userId) =>
    Number((await db("ledger_entries").where({ user_id: id }).sum({ s: "amount" }).first())!.s ?? 0);

  it("posts an entry and moves the balance together", async () => {
    const r = await postEntry(h.core, { userId, amount: 40, kind: "earn", note: null, idempotencyKey: "t:earn:1" });
    expect(r).toMatchObject({ status: "posted", balance: 40, entry: { amount: 40, kind: "earn" } });
    expect(await balance()).toBe(40);
  });

  it("the same idempotency key posts only once", async () => {
    const entry = { userId, amount: -15, kind: "spend", note: null, idempotencyKey: "job:1:spend" } as const;
    expect(await postEntry(h.core, entry)).toMatchObject({ status: "posted", balance: 25 });
    expect(await postEntry(h.core, entry)).toEqual({ status: "duplicate" });
    expect(await balance()).toBe(25);
    expect(await db("ledger_entries").where({ idempotency_key: "job:1:spend" })).toHaveLength(1);
    // Parallel retries too.
    const racing = await Promise.all(
      Array.from({ length: 5 }, () => postEntry(h.core, { ...entry, idempotencyKey: "job:2:spend" })),
    );
    expect(racing.filter((x) => x.status === "posted")).toHaveLength(1);
    expect(await balance()).toBe(10);
  });

  it("adjustment notes must read as text", async () => {
    for (const reason of ["", "\u3164", "\u{1F600}", "a\u0007b"]) {
      expect(await adjustBalance(h.core, userId, 1, reason), JSON.stringify(reason)).toEqual({ status: "invalid" });
    }
    expect(await adjustBalance(h.core, userId, 1, MAX_ENTRY_AMOUNT + "")).toMatchObject({ status: "posted" });
    expect(await adjustBalance(h.core, userId, MAX_ENTRY_AMOUNT + 1, "too much")).toEqual({ status: "invalid" });
    await adjustBalance(h.core, userId, -1, "undo");
  });

  it("refuses wrong-signed, zero and unknown-user postings without writing", async () => {
    expect(await postEntry(h.core, { userId, amount: 5, kind: "spend", note: null, idempotencyKey: "bad:1" })).toEqual({
      status: "invalid",
    });
    expect(await adjustBalance(h.core, userId, 0, "nothing")).toEqual({ status: "invalid" });
    expect(
      await postEntry(h.core, {
        userId: "00000000-0000-4000-8000-000000000000",
        amount: 5,
        kind: "grant",
        note: null,
        idempotencyKey: "bad:2",
      }),
    ).toEqual({ status: "no_user" });
    expect(await balance()).toBe(10);
  });

  it("parallel adjustments and spends leave balance = sum of entries (no lost update)", async () => {
    const before = await balance();
    const amounts = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? -(i + 1) : i + 1));
    const results = await Promise.all(
      amounts.map((amount, i) =>
        i % 2 === 0
          ? adjustBalance(h.core, userId, amount, `p${i}`)
          : postEntry(h.core, {
              userId,
              amount: -Math.abs(amount),
              kind: "spend",
              note: null,
              idempotencyKey: `par:${i}`,
            }),
      ),
    );
    expect(results.every((r) => r.status === "posted")).toBe(true);
    const expected = amounts.reduce((acc, amount, i) => acc + (i % 2 === 0 ? amount : -Math.abs(amount)), before);
    expect(await balance()).toBe(expected);
    expect(await balance()).toBe(await sum());
    expect(await checkLedger(h.core)).toEqual([]);
  });

  it("the sign-up grant is a ledger entry when configured, and nothing when 0", async () => {
    expect(await db("ledger_entries").where({ kind: "grant" })).toHaveLength(0);
    const granting = createHarness(db, { signupGrant: 250 });
    const cookie = await signInAs(granting, profile(2, "bobby"));
    const me = await request(granting.app).get("/me").set("Cookie", cookie);
    expect(me.body.balance).toBe(250);
    const entries = await request(granting.app).get("/ledger").set("Cookie", cookie);
    expect(entries.body.entries).toEqual([
      expect.objectContaining({ amount: 250, kind: "grant", note: "sign-up grant" }),
    ]);
    // Signing in again does not grant twice.
    await signInAs(granting, profile(2, "bobby"));
    expect(await balance(me.body.id)).toBe(250);
    expect(await checkLedger(granting.core)).toEqual([]);
  });

  it("GET /ledger lists the caller's entries newest first, 20 per page, with the total", async () => {
    const cookie = await signInAs(h, profile(3, "carol"));
    const me = (await request(h.app).get("/me").set("Cookie", cookie)).body;
    for (let i = 0; i < 105; i++) await adjustBalance(h.core, me.id, 1, `n${i}`);
    const res = await request(h.app).get("/ledger").set("Cookie", cookie);
    expect(res.body).toMatchObject({ page: 1, pageSize: 20, total: 105 });
    expect(res.body.entries).toHaveLength(20);
    expect(res.body.entries[0].note).toBe("n104");
    expect(res.body.entries[0]).toEqual({
      id: expect.any(Number),
      amount: 1,
      kind: "adjust",
      note: "n104",
      jobId: null,
      createdAt: expect.any(String),
    });
    // Other users' entries never appear.
    expect(res.body.entries.every((e: { note: string }) => /^n\d+$/.test(e.note))).toBe(true);

    // Pages continue where the previous one ended; the last one is short; one past the end is empty.
    const page2 = (await request(h.app).get("/ledger?page=2").set("Cookie", cookie)).body.entries;
    expect(page2[0].note).toBe("n84");
    const last = (await request(h.app).get("/ledger?page=6").set("Cookie", cookie)).body.entries;
    expect(last).toHaveLength(5);
    expect((await request(h.app).get("/ledger?page=7").set("Cookie", cookie)).body.entries).toEqual([]);
    for (const bad of ["0", "-1", "1.5", "abc", "1000000"])
      expect((await request(h.app).get(`/ledger?page=${bad}`).set("Cookie", cookie)).status).toBe(400);
  });

  it("the database refuses bad kinds, zero amounts and any change to existing entries", async () => {
    const base = { user_id: userId, idempotency_key: "raw:1", amount: 1 };
    await expect(db("ledger_entries").insert({ ...base, kind: "burn" })).rejects.toThrow(/kind_check/);
    await expect(db("ledger_entries").insert({ ...base, kind: "grant", amount: 0 })).rejects.toThrow(/amount_check/);
    await expect(db("ledger_entries").update({ note: "rewritten" })).rejects.toThrow(/append-only/);
    await expect(db("ledger_entries").delete()).rejects.toThrow(/append-only/);
    await expect(db.raw("TRUNCATE ledger_entries")).rejects.toThrow(/append-only/);
    expect(Number((await db("ledger_entries").count({ n: "*" }).first())!.n)).toBeGreaterThan(0);
  });

  it("ledger:check detects a tampered balance and a missing balance row", async () => {
    expect(await checkLedger(h.core)).toEqual([]);
    await db("balances")
      .where({ user_id: userId })
      .update({ balance: db.raw("balance + 7") });
    const bad = await checkLedger(h.core);
    expect(bad).toEqual([{ userId, balance: await balance(), entriesSum: await sum() }]);
    expect(bad[0]!.balance! - bad[0]!.entriesSum).toBe(7);
    await db("balances")
      .where({ user_id: userId })
      .update({ balance: db.raw("balance - 7") });
    expect(await checkLedger(h.core)).toEqual([]);

    await db("balances").where({ user_id: userId }).delete();
    expect((await checkLedger(h.core)).map((m) => [m.userId, m.balance])).toEqual([[userId, null]]);
  });
});
