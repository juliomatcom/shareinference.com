import type { Deps } from "./deps.js";
import type { BalanceSum, LedgerKind, NewEntry } from "./types.js";
import type { PostResult } from "./ports.js";
import { printableText } from "./validation.js";

const MAX_NOTE = 200;

/** Largest credit amount of one entry (and so of one adjustment): keeps every balance far inside safe integers. */
export const MAX_ENTRY_AMOUNT = 1_000_000_000_000;

/** grant and earn add, spend subtracts, adjust goes either way; never zero, always an integer. */
export function validAmount(kind: LedgerKind, amount: number): boolean {
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > MAX_ENTRY_AMOUNT) return false;
  if (kind === "grant" || kind === "earn") return amount > 0;
  if (kind === "spend") return amount < 0;
  return true;
}

/** The one way credits move: an entry and the balance change in one transaction (idempotent by key). */
export async function postEntry(deps: Deps, entry: NewEntry): Promise<PostResult | { status: "invalid" }> {
  if (!validAmount(entry.kind, entry.amount)) return { status: "invalid" };
  return deps.ledger.post(entry);
}

/** Admin correction with a reason; each call is its own entry (a fresh idempotency key). */
export async function adjustBalance(
  deps: Deps,
  userId: string,
  amount: number,
  reason: string,
): Promise<PostResult | { status: "invalid" }> {
  // The note can reach users (their ledger): it must read as text.
  const note = printableText(reason, MAX_NOTE);
  if (note === undefined) return { status: "invalid" };
  return postEntry(deps, {
    userId,
    amount,
    kind: "adjust",
    note,
    idempotencyKey: `adjust:${deps.secrets.token()}`,
  });
}

/** Users whose cached balance differs from the sum of their entries (or has no balance row). */
export const findMismatches = (rows: BalanceSum[]): BalanceSum[] =>
  rows.filter((r) => r.balance === null || r.balance !== r.entriesSum);

export async function checkLedger(deps: Deps): Promise<BalanceSum[]> {
  return findMismatches(await deps.ledger.balanceSums());
}
