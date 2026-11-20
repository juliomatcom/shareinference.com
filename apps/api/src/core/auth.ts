import type { Deps } from "./deps.js";
import type { GithubProfile, User } from "./types.js";
import { displayNameCandidate } from "./users.js";
import { isReservedName } from "./validation.js";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_NAME_TRIES = 12;
const API_KEY_RE = /^si_[A-Za-z0-9_-]{43}$/;

export type Authn =
  { ok: true; user: User; via: "session" | "apiKey" } | { ok: false; reason: "unauthorized" | "suspended" };

/** A new session for the user; the plaintext token is returned once and only its hash is stored. */
export async function createSession(deps: Deps, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const now = deps.clock.now();
  const token = deps.secrets.token();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await deps.sessions.purgeExpired(now);
  await deps.sessions.create(deps.secrets.hash(token), userId, expiresAt);
  return { token, expiresAt };
}

export async function endSession(deps: Deps, token: string): Promise<void> {
  await deps.sessions.delete(deps.secrets.hash(token));
}

export async function authenticateSession(deps: Deps, token: string): Promise<Authn> {
  const hash = deps.secrets.hash(token);
  const session = await deps.sessions.find(hash);
  if (!session) return { ok: false, reason: "unauthorized" };
  if (session.expiresAt.getTime() <= deps.clock.now().getTime()) {
    await deps.sessions.delete(hash);
    return { ok: false, reason: "unauthorized" };
  }
  return resolveUser(deps, session.userId, "session");
}

/** Bearer API key: revoked keys never match; a use is recorded in `last_used_at`. */
export async function authenticateApiKey(deps: Deps, key: string): Promise<Authn> {
  // Cheap shape check first: garbage never reaches the database.
  if (!API_KEY_RE.test(key)) return { ok: false, reason: "unauthorized" };
  const found = await deps.apiKeys.findByHash(deps.secrets.hash(key));
  if (!found || found.revokedAt) return { ok: false, reason: "unauthorized" };
  const result = await resolveUser(deps, found.userId, "apiKey");
  if (result.ok) await deps.apiKeys.touch(found.id, deps.clock.now());
  return result;
}

async function resolveUser(deps: Deps, userId: string, via: "session" | "apiKey"): Promise<Authn> {
  const user = await deps.users.findById(userId);
  if (!user) return { ok: false, reason: "unauthorized" };
  if (user.suspendedAt) return { ok: false, reason: "suspended" };
  return { ok: true, user, via };
}

/**
 * Sign-in with a GitHub account: the user holding that GitHub id (login and avatar refreshed), or a new one (display
 * name = login, falling back to `login-<n>` when taken). Suspended users get no session.
 */
export async function signIn(
  deps: Deps,
  profile: GithubProfile,
): Promise<
  { ok: true; user: User; token: string; created: boolean; displaced: string[] } | { ok: false; reason: "suspended" }
> {
  let user = await deps.users.findByGithubId(profile.githubId);
  let created = false;
  let displaced: string[] = [];
  if (user) {
    // Every sign-in refreshes login and avatar, and frees a display name that equals the (possibly new) login.
    displaced = await deps.users.updateGithub(user.id, { githubLogin: profile.login, avatarUrl: profile.avatarUrl });
    user = { ...user, githubLogin: profile.login, avatarUrl: profile.avatarUrl };
  } else {
    for (let n = 0; n < MAX_NAME_TRIES && !user; n++) {
      const displayName = displayNameCandidate(profile.login, n, deps.secrets.hex);
      if (isReservedName(displayName)) continue;
      // A name another account's GitHub login reads as is off limits, like in PATCH /me.
      if (await deps.users.githubLoginExists(displayName)) continue;
      const result = await deps.users.create(
        {
          githubId: profile.githubId,
          githubLogin: profile.login,
          githubCreatedAt: profile.createdAt,
          avatarUrl: profile.avatarUrl,
          displayName,
        },
        deps.signupGrant,
      );
      if (result.status === "created") {
        user = result.user;
        created = true;
        displaced = result.displaced;
      } else if (result.status === "exists") {
        // A parallel sign-in of the same account won the insert.
        user = await deps.users.findByGithubId(profile.githubId);
        break;
      }
    }
    if (!user) throw new Error("could not allocate a display name");
  }
  if (user.suspendedAt) return { ok: false, reason: "suspended" };
  const session = await createSession(deps, user.id);
  return { ok: true, user, token: session.token, created, displaced };
}
