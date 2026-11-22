import { useId } from "react";
import { type ProviderId, PROVIDERS } from "../lib/providers";

// Reusable mark for a model's maker: a soft-lit rounded tile with the provider's glyph on it. The glyphs are our own
// simplified drawings in a shared 24x24 grid (same stroke weight and optical size), not the companies' trademarked
// logos. Decorative by default (the name always sits next to it); pass `label` where it stands alone.

type Glyph = (props: { gradient: string }) => React.JSX.Element;

const GLYPHS: Record<ProviderId | "generic", Glyph> = {
  // Qwen: a hexagonal cell with a folded ribbon, the "Q" tail leaving at the lower right.
  qwen: ({ gradient }) => (
    <g fill="none" stroke={gradient} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.2 19.6 7.6v8.8L12 20.8 4.4 16.4V7.6z" />
      <path d="M8.6 9.6 12 11.6l3.4-2" />
      <path d="M12 11.6v4.2" />
      <path d="m14.4 17.6 3.4 3" />
    </g>
  ),
  // Google (Gemma): a four-point gem spark with concave sides.
  google: ({ gradient }) => (
    <g>
      <path
        fill={gradient}
        d="M12 2.4c.7 5.2 4.4 8.9 9.6 9.6-5.2.7-8.9 4.4-9.6 9.6-.7-5.2-4.4-8.9-9.6-9.6 5.2-.7 8.9-4.4 9.6-9.6z"
      />
      <path
        fill="none"
        stroke="rgba(255,255,255,.55)"
        strokeWidth=".9"
        strokeLinejoin="round"
        d="M12 7.2c.5 2.8 2 4.3 4.8 4.8-2.8.5-4.3 2-4.8 4.8-.5-2.8-2-4.3-4.8-4.8 2.8-.5 4.3-2 4.8-4.8z"
      />
    </g>
  ),
  // Thinking Machines (Inkling's looped layers): two interlocked loops.
  "thinking-machines": ({ gradient }) => (
    <g fill="none" stroke={gradient} strokeWidth="1.9" strokeLinecap="round">
      <circle cx="9.2" cy="12" r="5.4" />
      <circle cx="14.8" cy="12" r="5.4" />
      <path d="M12 7.7a5.4 5.4 0 0 1 0 8.6" strokeWidth="1" opacity=".6" />
    </g>
  ),
  // Unknown maker: a chip with pins.
  generic: ({ gradient }) => (
    <g fill="none" stroke={gradient} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.2" />
      <rect x="10" y="10" width="4" height="4" rx=".8" />
      <path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3" />
    </g>
  ),
};

export function ProviderIcon({
  provider,
  size = 40,
  label,
  className = "",
}: {
  /** A known provider, or undefined for the generic chip. */
  provider?: ProviderId;
  /** Tile edge in px. */
  size?: number;
  /** Accessible name; omit when the provider's name is written next to the icon. */
  label?: string;
  className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const gradId = `pi-${uid}`;
  const color = provider ? PROVIDERS[provider].color : "#a3a3a3";
  const Glyph = GLYPHS[provider ?? "generic"];
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center rounded-xl border ${className}`}
      style={{
        width: size,
        height: size,
        borderColor: `${color}40`,
        background: `radial-gradient(120% 120% at 20% 0%, ${color}38, ${color}0d 60%, transparent), #0a0a0a`,
        boxShadow: `inset 0 1px 0 ${color}2e, 0 6px 18px -10px ${color}`,
      }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <svg viewBox="0 0 24 24" width={size * 0.66} height={size * 0.66} aria-hidden="true">
        <defs>
          <linearGradient id={gradId} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor={color} />
          </linearGradient>
        </defs>
        <Glyph gradient={`url(#${gradId})`} />
      </svg>
    </span>
  );
}
