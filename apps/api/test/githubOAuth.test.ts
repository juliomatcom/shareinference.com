import { describe, expect, it } from "vitest";
import { GithubOAuthClient } from "../src/adapters/githubOAuth.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("GithubOAuthClient", () => {
  const redirect = "https://share.example.com/api/auth/github/callback";

  it("authorizes with the web callback as redirect_uri, read:user scope and the state", () => {
    const url = new URL(new GithubOAuthClient("cid", "secret", redirect).authorizeUrl("st4te"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cid",
      redirect_uri: redirect,
      scope: "read:user",
      state: "st4te",
    });
    expect(url.toString()).not.toContain("secret");
  });

  it("exchanges the code, reads /user and keeps only https avatars", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/access_token")) return json({ access_token: "gho_secret_token" });
      return json({
        id: 42,
        login: "octo",
        created_at: "2011-01-25T18:44:36Z",
        avatar_url: "https://avatars.githubusercontent.com/u/42",
      });
    }) as typeof fetch;
    const p = await new GithubOAuthClient("cid", "secret", redirect, fetchFn).exchangeCode("the-code");
    expect(p).toEqual({
      githubId: 42,
      login: "octo",
      createdAt: new Date("2011-01-25T18:44:36Z"),
      avatarUrl: "https://avatars.githubusercontent.com/u/42",
    });
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ code: "the-code", redirect_uri: redirect });
    expect((calls[1]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer gho_secret_token");
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses an error answer, a failing lookup and a malformed user without echoing the token", async () => {
    const make = (token: unknown, user: Response) =>
      new GithubOAuthClient("cid", "secret", redirect, (async (url: string) =>
        url.endsWith("/access_token") ? json(token) : user) as typeof fetch);
    await expect(make({ error: "bad_verification_code" }, json({})).exchangeCode("c")).rejects.toThrow("refused");
    const failure = make({ access_token: "gho_secret_token" }, json({}, 500)).exchangeCode("c");
    await expect(failure).rejects.toThrow("(500)");
    await expect(failure).rejects.not.toThrow(/gho_secret_token/);
    await expect(make({ access_token: "t" }, json({ id: "x" })).exchangeCode("c")).rejects.toThrow("malformed");
    const noAvatar = await make(
      { access_token: "t" },
      json({ id: 1, login: "a", created_at: "2020-01-01T00:00:00Z", avatar_url: "http://insecure/x.png" }),
    ).exchangeCode("c");
    expect(noAvatar.avatarUrl).toBeNull();
  });
});
