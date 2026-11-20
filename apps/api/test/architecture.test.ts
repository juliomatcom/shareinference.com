import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Dependency rule (wiki-llm/conventions.md): dependencies point inwards only.
const src = fileURLToPath(new URL("../src", import.meta.url));
const coreDir = join(src, "core");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|mts|js)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function imports(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
}

// core may import its own modules (relative paths that stay inside src/core) and zod; nothing else.
it("core imports only core modules and zod", () => {
  const violations: string[] = [];
  for (const file of files(coreDir)) {
    for (const spec of imports(stripComments(readFileSync(file, "utf8")))) {
      if (spec === "zod") continue;
      const inside = spec.startsWith(".") && resolve(dirname(file), spec).startsWith(coreDir + sep);
      if (!inside) violations.push(`${file}: ${spec}`);
    }
  }
  expect(violations).toEqual([]);
});

it("core never touches process, fetch, globalThis, require, crypto, Buffer or timers", () => {
  const violations: string[] = [];
  for (const file of files(coreDir)) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const re of [
      /\bprocess\b/,
      /\bfetch\s*\(/,
      /\bglobalThis\b/,
      /\brequire\s*\(/,
      /\bcrypto\b/,
      /\bBuffer\b/,
      /\bset(Timeout|Interval)\b/,
    ]) {
      if (re.test(code)) violations.push(`${file}: ${re}`);
    }
  }
  expect(violations).toEqual([]);
});

it("adapters never import main (only main.ts and migrate.ts wire)", () => {
  const violations: string[] = [];
  for (const file of files(join(src, "adapters"))) {
    for (const spec of imports(stripComments(readFileSync(file, "utf8")))) {
      if (/(^|\/)(main|migrate)(\.js)?$/.test(spec)) violations.push(`${file}: ${spec}`);
    }
  }
  expect(violations).toEqual([]);
});
