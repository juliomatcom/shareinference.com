"use client";

import { usePathname } from "next/navigation";

/**
 * Background art for every page except the landing page (which has its own `Circuit`): bundles of thin traces run
 * down both edges with a few 45° jogs and end in vias, fading out toward the page centre so they never sit under the
 * content. Some carry the same fast light as the hero (`.circuit-pulse`). Deterministic SVG, no `Math.random`.
 */

const W = 300;
const H = 1000;
const LANES = 5;
const GAP = 7;
const f = (n: number) => n.toFixed(1);
/** Deterministic pseudo-random in [0, 1) from an integer seed. */
const rnd = (n: number) => ((Math.imul(n + 1, 2654435761) >>> 0) % 1000) / 1000;

// Each bundle's lanes jog together (same y, same dx), so they never cross. `x` is the outer lane's x.
const BUNDLES = [
  {
    x: 6,
    jogs: [
      { y: 180, dx: 26 },
      { y: 520, dx: -20 },
      { y: 800, dx: 34 },
    ],
    endAt: [H, 640, H, 900, H],
  },
  {
    x: 92,
    jogs: [
      { y: 90, dx: -24 },
      { y: 400, dx: 30 },
      { y: 700, dx: -26 },
    ],
    endAt: [760, H, 520, H, 880],
  },
  {
    x: 176,
    jogs: [
      { y: 260, dx: 22 },
      { y: 600, dx: 28 },
    ],
    endAt: [H, 460, H, 340, H],
  },
];

interface Trace {
  d: string;
  opacity: number;
  via?: [number, number];
  pulse?: { dur: number; delay: number };
}

const TRACES: Trace[] = BUNDLES.flatMap((b, bi) =>
  Array.from({ length: LANES }, (_, i): Trace => {
    const seed = bi * 40 + i;
    let x = b.x + i * GAP;
    let y = -10;
    let d = `M${f(x)} ${f(y)}`;
    const end = b.endAt[i]!;
    for (const j of b.jogs) {
      if (j.y >= end) break;
      d += `L${f(x)} ${f(j.y - Math.abs(j.dx))}`; // straight run, then a 45° jog
      x += j.dx;
      y = j.y;
      d += `L${f(x)} ${f(y)}`;
    }
    d += `L${f(x)} ${f(end)}`;
    return {
      d,
      opacity: 0.35 + 0.5 * rnd(seed + 3),
      via: end < H ? [x, end] : undefined,
      pulse: rnd(seed + 7) < 0.5 ? { dur: 4 + 6 * rnd(seed + 11), delay: -10 * rnd(seed + 13) } : undefined,
    };
  }),
);

// Short stubs branching off a lane to a lit pad, for a little more "board".
const STUBS: [number, number, number][] = [
  [20, 140, 46],
  [96, 330, 40],
  [28, 590, 52],
  [186, 480, 38],
  [104, 760, 44],
  [14, 900, 36],
];

function Side({ flip }: { flip?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMinYMid slice"
      className={`absolute top-0 h-full w-60 text-accent [mask-image:linear-gradient(to_right,black,black_20%,transparent)] lg:w-80 ${flip ? "right-0 -scale-x-100" : "left-0"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="0.45"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g>
        {TRACES.map((t, i) => (
          <path key={i} d={t.d} opacity={t.opacity} />
        ))}
      </g>
      <g opacity="0.8">
        {TRACES.map((t, i) => (t.via ? <circle key={i} cx={t.via[0]} cy={t.via[1]} r="2.2" /> : null))}
        {STUBS.map(([x, y, len]) => (
          <g key={`${x}-${y}`}>
            <path d={`M${x} ${y}h${len}`} opacity="0.7" />
            <rect x={x + len} y={y - 2.5} width="5" height="5" rx="1" fill="currentColor" fillOpacity="0.5" />
          </g>
        ))}
      </g>
      <g stroke="#86efac" strokeWidth="1.1" className="[filter:drop-shadow(0_0_2px_#4ade80)]">
        {TRACES.map((t, i) =>
          t.pulse ? (
            <path
              key={i}
              d={t.d}
              pathLength={100}
              className="circuit-pulse"
              style={{ "--dur": `${f(t.pulse.dur)}s`, "--delay": `${f(t.pulse.delay)}s` } as React.CSSProperties}
            />
          ) : null,
        )}
      </g>
    </svg>
  );
}

export function PageArt() {
  const pathname = usePathname();
  if (pathname === "/") return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 hidden overflow-hidden opacity-75 md:block"
    >
      <Side />
      <Side flip />
    </div>
  );
}
