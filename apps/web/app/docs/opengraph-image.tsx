import { ogImage } from "../lib/og";

export const alt = "ShareInference: Documentation";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return ogImage({
    title: "Documentation",
    subtitle: "Guides for the API, sharing your GPU, privacy and the FAQ.",
    eyebrow: "Docs",
  });
}
