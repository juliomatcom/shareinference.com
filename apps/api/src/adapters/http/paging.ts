import type { Request } from "express";

/** Rows per page on the paged account lists (`/ledger`, `/jobs`); the web dashboard shows the same number. */
export const PAGE_SIZE = 10;
const MAX_PAGE = 100_000;

/** `?page=N` (1-based, default 1), or `undefined` when it is not a whole number in range. */
export function parsePage(req: Request): number | undefined {
  const raw = req.query.page;
  if (raw === undefined) return 1;
  if (typeof raw !== "string" || !/^[0-9]{1,6}$/.test(raw)) return undefined;
  const page = Number(raw);
  return page >= 1 && page <= MAX_PAGE ? page : undefined;
}
