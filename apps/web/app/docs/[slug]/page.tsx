import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "../../components/Markdown";
import { allDocs } from "../lib";

// Only the files that exist at build time; anything else is a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return allDocs().map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: allDocs().find((d) => d.slug === slug)?.title ?? "Docs" };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const docs = allDocs();
  const doc = docs.find((d) => d.slug === slug);
  if (!doc) notFound();
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Link href="/docs" className="text-sm text-neutral-400 hover:text-white">
        &larr; All docs
      </Link>
      <article className="mt-4 break-words">
        <Markdown source={doc.body} slugs={docs.map((d) => d.slug)} />
      </article>
    </main>
  );
}
