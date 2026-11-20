import type { CookieOptions, Request } from "express";
import { timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "si_session";
export const STATE_COOKIE = "si_oauth_state";

export function cookieOf(req: Request, name: string): string | undefined {
  for (const part of (req.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

/** HttpOnly, Lax, whole site; `Secure` when the web origin is https. */
export function cookieOptions(webOrigin: string, maxAgeMs?: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: webOrigin.startsWith("https:"),
    ...(maxAgeMs !== undefined && { maxAge: maxAgeMs }),
  };
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
