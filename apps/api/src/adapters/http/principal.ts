import type { Response } from "express";
import type { Authn } from "../../core/auth.js";
import type { User } from "../../core/types.js";

export type Principal = Extract<Authn, { ok: true }>;

/** The authenticated caller of this request (set by the deny-by-default middleware in app.ts). */
export const principalOf = (res: Response): Principal => res.locals.auth as Principal;
export const userOf = (res: Response): User => principalOf(res).user;
