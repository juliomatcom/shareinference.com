import type { Metadata, Viewport } from "next";
import { CookieNote } from "./components/CookieNote";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { JsonLd } from "./components/JsonLd";
import { MeProvider } from "./components/MeProvider";
import { PageArt } from "./components/PageArt";
import { ShareBar } from "./components/ShareBar";
import { SharingProvider } from "./components/SharingProvider";
import { REPO_URL } from "./lib/api";
import { DESCRIPTION, SITE_NAME, SITE_URL, TAGLINE, absoluteUrl } from "./lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${SITE_NAME} | ${TAGLINE}`, template: `%s | ${SITE_NAME}` },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  category: "technology",
  keywords: [
    "open-source LLM inference",
    "OpenAI-compatible API",
    "run AI models in the browser",
    "WebGPU",
    "share GPU earn credits",
    "open-weight models",
    "community GPU network",
    "free LLM API",
  ],
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    url: "/",
    title: `${SITE_NAME} | ${TAGLINE}`,
    description: DESCRIPTION,
    locale: "en_US",
  },
  twitter: { card: "summary_large_image", title: `${SITE_NAME} | ${TAGLINE}`, description: DESCRIPTION },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 },
  },
};

export const viewport: Viewport = { themeColor: "#0a0a0a", colorScheme: "dark" };

// Site-wide structured data: who runs the site and what it is. Page-specific entries live on their pages.
const siteSchema = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": absoluteUrl("/#organization"),
      name: SITE_NAME,
      url: SITE_URL,
      logo: absoluteUrl("/logo-512.png"),
      description: DESCRIPTION,
      sameAs: [REPO_URL],
    },
    {
      "@type": "WebSite",
      "@id": absoluteUrl("/#website"),
      name: SITE_NAME,
      url: SITE_URL,
      description: DESCRIPTION,
      inLanguage: "en",
      publisher: { "@id": absoluteUrl("/#organization") },
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-neutral-950 text-neutral-100">
        <JsonLd data={siteSchema} />
        <MeProvider>
          <SharingProvider>
            <PageArt />
            <Header />
            <div className="flex-1">{children}</div>
            <CookieNote />
            <ShareBar />
            <Footer />
          </SharingProvider>
        </MeProvider>
      </body>
    </html>
  );
}
