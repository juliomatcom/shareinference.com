import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { envSchema } from "../src/adapters/config.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const src = join(root, "apps/api/src");

it("every variable in the config schema is documented in .env.example", () => {
  const example = readFileSync(join(root, ".env.example"), "utf8");
  const missing = Object.keys(envSchema.shape).filter((k) => !new RegExp(`^#?\\s*${k}=`, "m").test(example));
  expect(missing).toEqual([]);
});

// process.env, destructuring or aliasing process, process["env"], or node:process.
const READS_ENV = /\bprocess\.env\b|\bprocess\s*\[|=\s*process\b(?!\.)|node:process/;

it("only adapters/config.ts reads process.env", () => {
  const offenders = (readdirSync(src, { recursive: true }) as string[])
    .filter((f) => /\.(ts|mts|js)$/.test(f) && f !== join("adapters", "config.ts"))
    .filter((f) => READS_ENV.test(readFileSync(join(src, f), "utf8")));
  expect(offenders).toEqual([]);
});
