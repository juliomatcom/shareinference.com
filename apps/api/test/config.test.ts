import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/adapters/config.js";

const base = {
  DATABASE_URL: "postgres://u:p@db:5432/x",
  WEB_ORIGIN: "http://localhost:3000",
  API_PUBLIC_URL: "http://localhost:4000",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
};

describe("config", () => {
  it("requires the GitHub OAuth credentials, naming them without their values", () => {
    expect(() => loadConfig({ ...base, GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: undefined })).toThrow(
      /GITHUB_CLIENT_ID: is required but not set; GITHUB_CLIENT_SECRET: is required but not set/,
    );
  });

  it("SIGNUP_GRANT_CREDITS defaults to 0 and must be an integer >= 0", () => {
    expect(loadConfig(base).SIGNUP_GRANT_CREDITS).toBe(0);
    expect(loadConfig({ ...base, SIGNUP_GRANT_CREDITS: "100" }).SIGNUP_GRANT_CREDITS).toBe(100);
    for (const bad of ["-1", "1.5", "lots"]) {
      expect(() => loadConfig({ ...base, SIGNUP_GRANT_CREDITS: bad }), bad).toThrow(/SIGNUP_GRANT_CREDITS: is invalid/);
    }
  });
});
