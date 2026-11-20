import type { Deps } from "./deps.js";
import type { User } from "./types.js";
import { deviceLabel, isDisplayName, isReservedName } from "./validation.js";

export type ProfileError = "invalid_display_name" | "display_name_taken" | "invalid_device_label";

/** The numbered fallbacks (`login-1` ... `login-5`) before the random ones. */
export const NUMBERED_FALLBACKS = 5;

/** A GitHub login as a valid display name (3-32 characters). */
export function defaultDisplayName(login: string): string {
  const base = login.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32);
  return base.length < 3 ? `user-${base}`.slice(0, 32) : base;
}

/**
 * The n-th display name to try for a GitHub login: the login itself, then `login-1` ... `login-5`, then
 * `login-<random 6 hex>` (so a crowd of look-alike logins cannot exhaust the tries).
 */
export function displayNameCandidate(login: string, n: number, randomHex: (bytes: number) => string): string {
  const base = defaultDisplayName(login);
  if (n === 0) return base;
  const suffix = n <= NUMBERED_FALLBACKS ? `-${n}` : `-${randomHex(3)}`;
  return `${base.slice(0, 32 - suffix.length)}${suffix}`;
}

/** Changes the user's public display name and/or device label. A name equal to another user's GitHub login is refused. */
export async function updateProfile(
  deps: Deps,
  user: User,
  patch: { displayName?: string; deviceLabel?: string | null },
): Promise<{ ok: true; user: User } | { ok: false; error: ProfileError }> {
  const change: { displayName?: string; deviceLabel?: string | null } = {};
  if (patch.displayName !== undefined) {
    if (!isDisplayName(patch.displayName)) return { ok: false, error: "invalid_display_name" };
    if (isReservedName(patch.displayName)) return { ok: false, error: "display_name_taken" };
    // Impersonation: a name must not read as someone else's GitHub account.
    if (await deps.users.githubLoginExists(patch.displayName, user.id)) {
      return { ok: false, error: "display_name_taken" };
    }
    change.displayName = patch.displayName;
  }
  if (patch.deviceLabel !== undefined) {
    const label = deviceLabel(patch.deviceLabel);
    if (label === undefined) return { ok: false, error: "invalid_device_label" };
    change.deviceLabel = label;
  }
  if (Object.keys(change).length > 0) {
    const result = await deps.users.setProfile(user.id, change);
    if (result === "display_name_taken") return { ok: false, error: "display_name_taken" };
    if (result === "not_found") throw new Error("user vanished");
  }
  const fresh = await deps.users.findById(user.id);
  if (!fresh) throw new Error("user vanished");
  return { ok: true, user: fresh };
}
