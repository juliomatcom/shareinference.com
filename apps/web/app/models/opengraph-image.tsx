import { ogImage } from "../lib/og";

export const alt = "ShareInference: Open-weight model catalog";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return ogImage({
    title: "Open-weight model catalog",
    subtitle: "Models you can call through the OpenAI-compatible API, with live workers and queue depth.",
    eyebrow: "Catalog",
  });
}
