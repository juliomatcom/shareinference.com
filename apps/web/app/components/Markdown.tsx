import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { REPO_URL } from "../lib/api";

/** Doc links are written for the repo (`../wiki-llm/api.md`, `setup.md`): map them to site pages or GitHub. */
function resolveHref(href: string, slugs: Set<string>): { href: string; external: boolean } {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { href, external: true };
  if (href.startsWith("#")) return { href, external: false };
  const sibling = /^(?:\.\/)?([a-z0-9-]+)\.md(#.*)?$/.exec(href);
  if (sibling && slugs.has(sibling[1]!)) return { href: `/docs/${sibling[1]}${sibling[2] ?? ""}`, external: false };
  // Anything else points at a repo file (relative to docs/): open it on GitHub.
  const file = href.replace(/^(\.\.\/)+/, "").replace(/^\.\//, "");
  const inDocs = !href.startsWith("../");
  return { href: `${REPO_URL}/blob/main/${inDocs ? "docs/" : ""}${file}`, external: true };
}

const code = "rounded bg-neutral-800 px-1 py-0.5 font-mono text-[0.85em] text-neutral-200";

// react-markdown passes its AST `node` to every override; it must not reach the DOM.
function components(slugs: Set<string>): Components {
  return {
    h1: ({ node: _node, ...p }) => <h1 className="mt-2 mb-4 text-2xl font-bold" {...p} />,
    h2: ({ node: _node, ...p }) => (
      <h2 className="mt-8 mb-3 border-b border-neutral-800 pb-1 text-xl font-semibold" {...p} />
    ),
    h3: ({ node: _node, ...p }) => <h3 className="mt-6 mb-2 text-lg font-semibold" {...p} />,
    p: ({ node: _node, ...p }) => <p className="my-3 leading-relaxed text-neutral-300" {...p} />,
    ul: ({ node: _node, ...p }) => <ul className="my-3 list-disc space-y-1 pl-6 text-neutral-300" {...p} />,
    ol: ({ node: _node, ...p }) => <ol className="my-3 list-decimal space-y-1 pl-6 text-neutral-300" {...p} />,
    li: ({ node: _node, ...p }) => <li {...p} />,
    blockquote: ({ node: _node, ...p }) => (
      <blockquote className="my-3 border-l-2 border-neutral-700 pl-4 text-neutral-400" {...p} />
    ),
    hr: ({ node: _node }) => <hr className="my-6 border-neutral-800" />,
    // Fenced code arrives as <pre><code class="language-x">; inline code has no language class.
    pre: ({ node: _node, ...p }) => (
      <pre className="my-4 overflow-x-auto rounded-md border border-neutral-800 bg-neutral-900 p-4 text-sm" {...p} />
    ),
    code: ({ node: _node, className, ...p }) =>
      className?.startsWith("language-") ? (
        <code className={`${className} font-mono`} {...p} />
      ) : (
        <code className={code} {...p} />
      ),
    table: ({ node: _node, ...p }) => (
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm" {...p} />
      </div>
    ),
    th: ({ node: _node, ...p }) => (
      <th className="border-b border-neutral-700 px-3 py-2 font-medium text-neutral-200" {...p} />
    ),
    td: ({ node: _node, ...p }) => (
      <td className="border-b border-neutral-800 px-3 py-2 align-top text-neutral-300" {...p} />
    ),
    a: ({ node: _node, href = "", children }) => {
      const r = resolveHref(href, slugs);
      const cls = "text-accent hover:opacity-80";
      return r.external ? (
        <a href={r.href} className={cls} rel="noopener noreferrer">
          {children}
        </a>
      ) : (
        <Link href={r.href} className={cls}>
          {children}
        </Link>
      );
    },
  };
}

/** Markdown without raw HTML (react-markdown drops it unless a rehype-raw plugin is added, which we do not). */
export function Markdown({ source, slugs }: { source: string; slugs: string[] }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components(new Set(slugs))}>
      {source}
    </ReactMarkdown>
  );
}
