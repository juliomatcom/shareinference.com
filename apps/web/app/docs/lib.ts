import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The repo's `docs/*.md`, read at build time (the pages are statically generated, so the runtime image needs no copy).
// The turbopackIgnore comments tell the file tracer this is build-time only; without them the standalone output
// would pull in the whole project.
const candidates = [
  path.join(/*turbopackIgnore: true*/ process.cwd(), "../../docs"),
  path.join(/*turbopackIgnore: true*/ process.cwd(), "docs"),
];
const dir = candidates.find((c) => existsSync(/*turbopackIgnore: true*/ c)) ?? "";

export interface Doc {
  slug: string;
  title: string;
  body: string;
}

// A friendly reading order; any other file follows alphabetically.
const ORDER = ["setup", "deploy", "api", "contribute", "privacy", "terms"];

export function allDocs(): Doc[] {
  if (!dir) return [];
  const docs = readdirSync(/*turbopackIgnore: true*/ dir)
    .filter((f) => /^[a-z0-9-]+\.md$/.test(f))
    .map((f) => {
      const body = readFileSync(/*turbopackIgnore: true*/ path.join(dir, f), "utf8");
      const slug = f.slice(0, -3);
      return { slug, title: /^#\s+(.+)$/m.exec(body)?.[1] ?? slug, body };
    });
  const rank = (s: string) => (ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length);
  return docs.sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug));
}
