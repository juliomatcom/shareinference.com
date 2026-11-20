import { z } from "zod";

/** http(s) origin only: no path, query or trailing slash. */
const origin = z.string().refine((v) => {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin === v;
  } catch {
    return false;
  }
});

// The only place that reads process.env. Every key here must be documented in .env.example (a test checks it).
export const envSchema = z.object({
  DATABASE_URL: z.string().refine((v) => /^postgres(ql)?:\/\//.test(v)),
  // At least 2: migrations hold an advisory lock on one connection and work on another.
  DB_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
  WEB_ORIGIN: origin,
  API_PUBLIC_URL: origin,
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  // Credits written as a `grant` entry at sign-up.
  SIGNUP_GRANT_CREDITS: z.coerce.number().int().min(0).max(1_000_000_000).default(0),
  // Listen port: 4000 in the container (compose publishes it); `pnpm dev` runs the api on the host at 4401.
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // True only behind a reverse proxy that sets X-Real-IP itself (overwriting any client value): per-IP limits then use it.
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Config = z.infer<typeof envSchema>;

/** Fail fast: throws one error naming every missing or invalid variable (never its value). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty value (e.g. `DATABASE_URL=` in .env) counts as unset.
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = envSchema.safeParse(clean);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => {
      const name = String(i.path[0]);
      return `${name}: ${clean[name] === undefined ? "is required but not set" : "is invalid"}`;
    });
    throw new Error(`Invalid configuration (see .env.example): ${problems.join("; ")}`);
  }
  return parsed.data;
}
