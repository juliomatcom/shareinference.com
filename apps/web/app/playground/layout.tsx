import type { Metadata } from "next";
import { NO_INDEX } from "../lib/site";

// Gated page: a client component cannot export metadata, so this layout does. Not indexed, not in the sitemap.
export const metadata: Metadata = { title: "Playground", robots: NO_INDEX };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
