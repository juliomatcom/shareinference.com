import type { MetadataRoute } from "next";
import { allDocs } from "./docs/lib";
import { SITE_URL, absoluteUrl } from "./lib/site";

// Public pages only; gated ones (dashboard, settings, playground, share, signin) are left out on purpose.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const pages: MetadataRoute.Sitemap = [
    { url: SITE_URL, lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: absoluteUrl("/how-it-works"), lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: absoluteUrl("/models"), lastModified: now, changeFrequency: "daily", priority: 0.7 },
    { url: absoluteUrl("/leaderboard"), lastModified: now, changeFrequency: "daily", priority: 0.6 },
    { url: absoluteUrl("/docs"), lastModified: now, changeFrequency: "weekly", priority: 0.8 },
  ];
  const core = new Set(["api", "contribute", "faq"]);
  const docs: MetadataRoute.Sitemap = allDocs().map((d) => ({
    url: absoluteUrl(`/docs/${d.slug}`),
    lastModified: d.modified,
    changeFrequency: "monthly",
    priority: core.has(d.slug) ? 0.7 : 0.4,
  }));
  return [...pages, ...docs];
}
