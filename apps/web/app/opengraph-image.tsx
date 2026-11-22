import { ogImage } from "./lib/og";

export const alt = "ShareInference: community-powered AI inference";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return ogImage({
    title: "Community-powered AI inference",
    subtitle: "Share GPU time from a browser tab, use it through an OpenAI-compatible API.",
  });
}
