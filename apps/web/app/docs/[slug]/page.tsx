import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FaqAccordion } from "../../components/FaqAccordion";
import { JsonLd } from "../../components/JsonLd";
import { Markdown } from "../../components/Markdown";
import { ScrollToTop } from "../../components/ScrollToTop";
import { absoluteUrl, pageMetadata } from "../../lib/site";
import { allDocs, faqEntries, seoDescription, seoTitle } from "../lib";

// Only the files that exist at build time; anything else is a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return allDocs().map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const doc = allDocs().find((d) => d.slug === slug);
  if (!doc) return { title: "Docs" };
  return pageMetadata({ title: seoTitle(doc), description: seoDescription(doc), path: `/docs/${slug}` });
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const docs = allDocs();
  const doc = docs.find((d) => d.slug === slug);
  if (!doc) notFound();
  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Docs", item: absoluteUrl("/docs") },
      { "@type": "ListItem", position: 2, name: doc.title, item: absoluteUrl(`/docs/${slug}`) },
    ],
  };
  // Only the FAQ page has question headings; the answers are the visible page text.
  const faq =
    slug === "faq"
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: faqEntries(doc.body).map((e) => ({
            "@type": "Question",
            name: e.question,
            acceptedAnswer: { "@type": "Answer", text: e.answer },
          })),
        }
      : null;
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <JsonLd data={breadcrumbs} />
      {faq && <JsonLd data={faq} />}
      <Link href="/docs" className="text-sm text-neutral-400 hover:text-white">
        &larr; All docs
      </Link>
      <article className="mt-4 break-words">
        {slug === "faq" ? (
          <FaqAccordion source={doc.body} slugs={docs.map((d) => d.slug)} />
        ) : (
          <Markdown source={doc.body} slugs={docs.map((d) => d.slug)} />
        )}
      </article>
      <ScrollToTop />
    </main>
  );
}
