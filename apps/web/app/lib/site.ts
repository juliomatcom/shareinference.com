import type { Metadata } from "next";

/** Public origin, no trailing slash. Production by default; set `SITE_URL` at build time for a staging or fork. */
export const SITE_URL = (process.env.SITE_URL || "https://shareinference.com").replace(/\/+$/, "");
export const SITE_NAME = "ShareInference";
export const TAGLINE = "Community-powered AI inference";
export const DESCRIPTION =
  "Community-powered AI inference. Share GPU time from a browser tab, use it through an OpenAI-compatible API.";

/** Keeps a page out of search results and link-following (gated pages: the content is a sign-in panel). */
export const NO_INDEX: NonNullable<Metadata["robots"]> = { index: false, follow: false };

/** Absolute URL of a site path ("/" gives the bare origin plus a slash). */
export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path}`;
}

/**
 * Per-page metadata for a public page: title, description, canonical, Open Graph and Twitter in one place.
 * `title` gets the root template ("%s | ShareInference"); `absoluteTitle` replaces it (the landing page).
 * The share image comes from the route's `opengraph-image` file, or from the nearest parent segment's.
 */
export function pageMetadata({
  title,
  absoluteTitle,
  description,
  path,
}: {
  title?: string;
  absoluteTitle?: string;
  description: string;
  path: string;
}): Metadata {
  const shownTitle = absoluteTitle ?? `${title} | ${SITE_NAME}`;
  return {
    title: absoluteTitle ? { absolute: absoluteTitle } : title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      url: path,
      title: shownTitle,
      description,
      locale: "en_US",
    },
    twitter: { card: "summary_large_image", title: shownTitle, description },
  };
}
