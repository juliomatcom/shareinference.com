import type { MetadataRoute } from "next";
import { absoluteUrl } from "./lib/site";

// Gated pages are also `noindex` (their layouts); `/api/` is the proxy to the api and also sends `X-Robots-Tag`.
const GATED_PATHS = ["/dashboard", "/settings", "/playground", "/share", "/signin"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: [...GATED_PATHS, "/api/"] },
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
