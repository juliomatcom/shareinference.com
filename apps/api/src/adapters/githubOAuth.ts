import { z } from "zod";
import type { GithubOAuth } from "../core/ports.js";
import type { GithubProfile } from "../core/types.js";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const TIMEOUT_MS = 10_000;

const tokenResponse = z.object({ access_token: z.string().min(1) });
const userResponse = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1).max(100),
  created_at: z.string(),
  avatar_url: z.string().nullable().optional(),
});

/** GitHub OAuth web flow over fetch. The access token lives only inside `exchangeCode` and is never logged. */
export class GithubOAuthClient implements GithubOAuth {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    /** `${WEB_ORIGIN}/api/auth/github/callback`: must match the callback URL registered on the OAuth app. */
    private readonly redirectUri: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: "read:user",
      state,
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  async exchangeCode(code: string): Promise<GithubProfile> {
    const tokenRes = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.redirectUri,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // GitHub answers 200 with an `error` field when it refuses the code; only the status is reported.
    if (!tokenRes.ok) throw new Error(`github token exchange failed (${tokenRes.status})`);
    const token = tokenResponse.safeParse(await tokenRes.json().catch(() => ({})));
    if (!token.success) throw new Error("github refused the code");

    const userRes = await this.fetchFn(USER_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token.data.access_token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "shareinference",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!userRes.ok) throw new Error(`github user lookup failed (${userRes.status})`);
    const user = userResponse.safeParse(await userRes.json().catch(() => ({})));
    if (!user.success) throw new Error("malformed github user");
    const createdAt = new Date(user.data.created_at);
    if (Number.isNaN(createdAt.getTime())) throw new Error("malformed github user");
    const avatar = user.data.avatar_url;
    return {
      githubId: user.data.id,
      login: user.data.login,
      createdAt,
      avatarUrl: avatar?.startsWith("https://") ? avatar : null,
    };
  }
}
