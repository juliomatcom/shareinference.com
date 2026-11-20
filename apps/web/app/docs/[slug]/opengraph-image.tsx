import { ogImage } from "../../lib/og";
import { allDocs, seoDescription, seoTitle } from "../lib";

export const alt = "ShareInference documentation";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export function generateStaticParams() {
  return allDocs().map((d) => ({ slug: d.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = allDocs().find((d) => d.slug === slug);
  return ogImage({
    title: doc ? seoTitle(doc) : "Documentation",
    subtitle: doc ? seoDescription(doc) : "Guides for ShareInference.",
    eyebrow: "Docs",
  });
}
