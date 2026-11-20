import type { Metadata } from "next";
import { CookieNote } from "./components/CookieNote";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { MeProvider } from "./components/MeProvider";
import { PageArt } from "./components/PageArt";
import { ShareBar } from "./components/ShareBar";
import { SharingProvider } from "./components/SharingProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ShareInference", template: "%s | ShareInference" },
  description:
    "Community-powered AI inference. Share GPU time from a browser tab, spend it through an OpenAI-compatible API.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-neutral-950 text-neutral-100">
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
