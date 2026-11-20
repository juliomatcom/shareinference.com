import { randomInt } from "node:crypto";
import { createSession, signIn } from "../core/auth.js";
import type { Deps } from "../core/deps.js";

const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * DEV/TEST ONLY (`users dev-session`): a session token for the local test user with this GitHub login, creating it
 * when missing. Test users have a negative github_id; a real GitHub user is never given a session this way.
 */
export async function devSession(core: Deps, handle: string): Promise<string> {
  const matches = (await core.users.findByHandle(handle)).filter(
    (u) => u.githubLogin.toLowerCase() === handle.toLowerCase(),
  );
  if (matches.length > 1) throw new Error(`"${handle}" is ambiguous`);
  const existing = matches[0];
  if (existing) {
    if (existing.githubId >= 0)
      throw new Error(`${handle} is a real GitHub account: dev-session only serves test users`);
    if (existing.suspendedAt) throw new Error(`${handle} is suspended`);
    return (await createSession(core, existing.id)).token;
  }
  if (!GITHUB_LOGIN.test(handle)) throw new Error("a new test user's login must be 1-39 letters, digits or -");
  // Negative github_id marks a local test user (real GitHub ids are positive).
  let githubId = -randomInt(1, 2 ** 40);
  while (await core.users.findByGithubId(githubId)) githubId = -randomInt(1, 2 ** 40);
  const result = await signIn(core, {
    githubId,
    login: handle,
    createdAt: new Date(core.clock.now().getTime() - 365 * DAY_MS),
    avatarUrl: null,
  });
  if (!result.ok) throw new Error("could not sign in the test user");
  return result.token;
}
