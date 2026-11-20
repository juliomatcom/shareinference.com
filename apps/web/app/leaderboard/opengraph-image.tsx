import { ogImage } from "../lib/og";

export const alt = "ShareInference: GPU provider leaderboard";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return ogImage({
    title: "GPU provider leaderboard",
    subtitle: "The community members sharing the most GPU time, ranked by tokens served.",
    eyebrow: "Live",
  });
}
