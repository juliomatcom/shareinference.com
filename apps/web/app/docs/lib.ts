import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  /** The H1 of the file. */
  title: string;
  body: string;
  modified: Date;
}

// Search-friendly page titles where the H1 is too short to say what the page is about (<title>, share card).
const SEO_TITLES: Record<string, string> = {
  api: "Using the OpenAI-Compatible API",
  contribute: "Share Your GPU and Earn Credits",
  faq: "FAQ: Credits, Sharing a GPU and the API",
};

// Hand-written meta descriptions where the first paragraph is a poor summary (links, paths, one short sentence).
// Every other doc gets its first paragraph (`docDescription`).
const SEO_DESCRIPTIONS: Record<string, string> = {
  api: "Use the ShareInference OpenAI-compatible API: create an API key, set the base URL in any OpenAI client and stream chat completions from open-weight models.",
  contribute:
    "Share your GPU from a Chrome or Edge tab with WebGPU. Your browser serves an open-weight LLM for others and earns you credits to use on the API.",
};

export const seoTitle = (d: Doc): string => SEO_TITLES[d.slug] ?? d.title;
export const seoDescription = (d: Doc): string => SEO_DESCRIPTIONS[d.slug] ?? docDescription(d.body);

// A friendly reading order; any other file follows alphabetically.
const ORDER = ["api", "contribute", "faq", "privacy", "terms"];

// Operator guides (self-hosting, deployment) are technical details for the repository on GitHub, not for the website:
// they stay in `docs/` but are never rendered, listed, linked or put in the sitemap.
const REPO_ONLY = new Set(["setup", "deploy"]);

export function allDocs(): Doc[] {
  if (!dir) return [];
  const docs = readdirSync(/*turbopackIgnore: true*/ dir)
    .filter((f) => /^[a-z0-9-]+\.md$/.test(f) && !REPO_ONLY.has(f.slice(0, -3)))
    .map((f) => {
      const body = readFileSync(/*turbopackIgnore: true*/ path.join(dir, f), "utf8");
      const slug = f.slice(0, -3);
      const modified = statSync(/*turbopackIgnore: true*/ path.join(dir, f)).mtime;
      return { slug, title: /^#\s+(.+)$/m.exec(body)?.[1] ?? slug, body, modified };
    });
  const rank = (s: string) => (ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length);
  return docs.sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug));
}

/** Markdown to plain text for meta descriptions and JSON-LD: links keep their text, emphasis and code ticks go. */
function plain(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Longest run of whole sentences within `max` characters; a single over-long sentence is cut at a word. */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const s of sentences) {
    if ((out ? `${out} ${s}` : s).length > max) break;
    out = out ? `${out} ${s}` : s;
  }
  if (out.length >= 60) return out;
  return text.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

/** Meta description from the first real paragraph: skips the H1, headings, lists, tables, code and `_italic_` notes. */
export function docDescription(body: string): string {
  const paragraph = body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .find((b) => b && !/^(#|[-*+]\s|\d+\.\s|\||```|>|_[^_]+_$)/.test(b));
  return clamp(plain(paragraph ?? ""), 160);
}

/** Question and answer pairs from `### Question` headings and the text under them (the FAQ page's structure). */
export function faqEntries(body: string): { question: string; answer: string }[] {
  const entries: { question: string; answer: string }[] = [];
  let current: { question: string; lines: string[] } | null = null;
  const flush = () => {
    const answer = current ? plain(current.lines.join("\n")) : "";
    if (current && answer) entries.push({ question: plain(current.question), answer });
    current = null;
  };
  for (const line of body.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      flush();
      const q = /^###\s+(.+)$/.exec(line);
      if (q) current = { question: q[1]!, lines: [] };
    } else if (current) current.lines.push(line);
  }
  flush();
  return entries;
}
