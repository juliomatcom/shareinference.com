import { MAX_ENTRY_AMOUNT } from "./core/ledger.js";

export const USAGE = `usage: users <command>

  list                                      all users with balance and status
  suspend <login>                           block the user everywhere (403 suspended)
  unsuspend <login>                         lift the block
  throttle <login> <perMin> <perDay>        store a rate limit override (enforced from Phase 5)
  credit <login> <amount> <reason>          adjust the balance (negative amount debits)
  ledger <login>                            the user's ledger entries, newest first
  ledger:check                              verify every balance equals the sum of its entries
  dev-session <login>                       DEV/TEST ONLY: create a local test user if missing (never serves a real
                                            GitHub account) and print a session token, to test signed-in flows without GitHub. Never use it on a
                                            public server: anyone with the token is signed in as that user.

<login> is a GitHub login or a display name (case-insensitive).`;

export class UsageError extends Error {}

export type Command =
  | { name: "list" | "ledger:check" }
  | { name: "suspend" | "unsuspend" | "ledger" | "dev-session"; handle: string }
  | { name: "throttle"; handle: string; perMin: number; perDay: number }
  | { name: "credit"; handle: string; amount: number; reason: string };

const integer = (text: string | undefined, what: string): number => {
  if (text === undefined || !/^-?\d+$/.test(text)) throw new UsageError(`${what} must be an integer\n\n${USAGE}`);
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new UsageError(`${what} is out of range\n\n${USAGE}`);
  return n;
};

export function parseUsersArgs(argv: string[]): Command {
  const [name, handle, ...rest] = argv;
  const need = (value: string | undefined): string => {
    if (!value) throw new UsageError(USAGE);
    return value;
  };
  switch (name) {
    case "list":
    case "ledger:check":
      return { name };
    case "suspend":
    case "unsuspend":
    case "ledger":
    case "dev-session":
      return { name, handle: need(handle) };
    case "throttle": {
      const perMin = integer(rest[0], "perMin");
      const perDay = integer(rest[1], "perDay");
      if (perMin < 1 || perDay < 1) throw new UsageError(`perMin and perDay must be at least 1\n\n${USAGE}`);
      return { name, handle: need(handle), perMin, perDay };
    }
    case "credit": {
      const amount = integer(rest[0], "amount");
      if (amount === 0 || Math.abs(amount) > MAX_ENTRY_AMOUNT) {
        throw new UsageError(`amount must be non-zero and at most ${MAX_ENTRY_AMOUNT} either way\n\n${USAGE}`);
      }
      const reason = rest.slice(1).join(" ").trim();
      if (!reason || reason.length > 200)
        throw new UsageError(`reason is required (at most 200 characters)\n\n${USAGE}`);
      return { name, handle: need(handle), amount, reason };
    }
    default:
      throw new UsageError(USAGE);
  }
}
