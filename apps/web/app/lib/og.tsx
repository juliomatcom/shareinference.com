import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { SITE_NAME } from "./site";

// Share cards (Open Graph / Twitter), drawn at build time by the `opengraph-image` files. No network and no remote
// fonts: ImageResponse brings its own default font, and the logo is read from `public/` and inlined as a data URL.
const logo = `data:image/png;base64,${await readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), "public/logo-512.png"), "base64")}`;

const GREEN = "#22c55e";
/** Cuts at a word boundary so a clamped line never ends mid-word. */
const clip = (text: string, max: number) =>
  text.length > max
    ? `${text
        .slice(0, max - 1)
        .replace(/\s+\S*$/, "")
        .replace(/[,;:.\s]+$/, "")}…`
    : text;

/** Shrinks the headline as it grows so up to ~100 characters still fit in three lines. */
function titleSize(title: string): number {
  const n = title.length;
  return n <= 18 ? 108 : n <= 34 ? 88 : n <= 56 ? 72 : 58;
}

export function ogImage({ title, subtitle, eyebrow }: { title: string; subtitle: string; eyebrow?: string }) {
  const headline = clip(title, 100);
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        backgroundColor: "#0a0a0a",
        color: "#f5f5f5",
      }}
    >
      {/* Faint circuit-board grid, brightest toward the top right where the glow sits. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 1200,
          height: 630,
          display: "flex",
          backgroundImage:
            "linear-gradient(rgba(34,197,94,0.11) 1px, transparent 1px), linear-gradient(90deg, rgba(34,197,94,0.11) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 1200,
          height: 630,
          display: "flex",
          backgroundImage:
            "radial-gradient(circle at 90% 10%, rgba(34,197,94,0.35), rgba(34,197,94,0) 60%), linear-gradient(60deg, rgba(10,10,10,0.92) 20%, rgba(10,10,10,0) 70%)",
        }}
      />
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 80px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo} width={88} height={88} alt="" />
          <div style={{ display: "flex", fontSize: 40, color: "#e5e5e5", letterSpacing: -0.5 }}>{SITE_NAME}</div>
          {eyebrow && (
            <div
              style={{
                display: "flex",
                marginLeft: 8,
                padding: "6px 18px",
                fontSize: 24,
                color: GREEN,
                border: "2px solid rgba(34,197,94,0.5)",
                borderRadius: 999,
              }}
            >
              {eyebrow}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div
            style={{
              display: "flex",
              fontSize: titleSize(headline),
              lineHeight: 1.08,
              letterSpacing: -2,
              color: "#ffffff",
              // The default font has one weight; a thin stroke gives the headline body.
              WebkitTextStroke: "2px #ffffff",
              lineClamp: 3,
            }}
          >
            {headline}
          </div>
          <div
            style={{ display: "flex", fontSize: 32, lineHeight: 1.35, color: "#a3a3a3", maxWidth: 960, lineClamp: 2 }}
          >
            {clip(subtitle, 120)}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 32, color: GREEN }}>
          <div style={{ display: "flex", width: 14, height: 14, borderRadius: 999, backgroundColor: GREEN }} />
          shareinference.com
        </div>
      </div>
    </div>,
    { width: 1200, height: 630 },
  );
}
