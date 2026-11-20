import { ogImage } from "../lib/og";

export const alt = "ShareInference: How it works";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return ogImage({
    title: "How it works",
    subtitle: "Browser GPUs, an OpenAI-compatible API and credits that keep it fair.",
    eyebrow: "Overview",
  });
}
