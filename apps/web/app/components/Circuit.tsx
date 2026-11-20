/**
 * Decorative circuit-board art for the hero: a pinned chip on each side with dense routed trace bundles, vias,
 * glow pads and data specks. Pure SVG, generated once at module load from deterministic numbers (no Math.random),
 * so server and client render the same markup.
 */

// Chip geometry (viewBox units). The art bleeds off the top and the outer edge of the page.
const W = 400;
const H = 520;
const CX = 165;
const CY = 150;
const HALF = 32;
const PINS = 10;
const PITCH = (HALF * 2) / (PINS + 1);
const PIN_LEN = 7;
const STEP = PITCH * 0.4142; // bend offset between neighbours, keeps nested 45° corners evenly spaced

/** Deterministic pseudo-random in [0, 1) from an integer seed. */
const rnd = (n: number) => ((Math.imul(n + 1, 2654435761) >>> 0) % 1000) / 1000;
const f = (n: number) => n.toFixed(1);

interface SideSpec {
  o: [number, number]; // outward unit vector
  l: [number, number]; // lateral unit vector (pin index increases along it)
  sign: 1 | -1; // which way the bundle shifts along `l` (pinwheel, so bundles never cross)
  first: number; // run before the first bend
  shift: number; // lateral shift of the first bend
  length: number; // outward length of a full trace
  back?: { run: number; shift: number }; // optional second bend shifting part of the way back
}

const SIDES: SideSpec[] = [
  { o: [0, -1], l: [1, 0], sign: 1, first: 8, shift: 34, length: 150 },
  { o: [1, 0], l: [0, 1], sign: 1, first: 6, shift: 22, length: 40 },
  { o: [0, 1], l: [1, 0], sign: -1, first: 12, shift: 30, length: 340, back: { run: 22, shift: 22 } },
  { o: [-1, 0], l: [0, 1], sign: -1, first: 10, shift: 32, length: 236, back: { run: 18, shift: 26 } },
];

interface Trace {
  d: string;
  opacity: number;
  via?: [number, number];
  glow: boolean;
  pulse?: { dur: number; delay: number }; // a light running along this trace toward the chip
}

function bundle(side: SideSpec, sideIndex: number): Trace[] {
  const { o, l, sign, first, shift, length, back } = side;
  const at = (a: number, b: number): [number, number] => [
    CX + o[0] * (HALF + a) + l[0] * b,
    CY + o[1] * (HALF + a) + l[1] * b,
  ];
  const traces: Trace[] = [];
  for (let i = 0; i < PINS; i++) {
    const seed = sideIndex * 50 + i;
    const b0 = (i - (PINS - 1) / 2) * PITCH;
    const r = sign > 0 ? i : PINS - 1 - i; // 0 = trailing line of the bundle, PINS-1 = leading
    const a1 = first + (PINS - 1 - r) * STEP;
    const pts: [number, number][] = [at(0, b0), at(PIN_LEN, b0), at(a1, b0), at(a1 + shift, b0 + sign * shift)];
    let lastA = a1 + shift;
    let lastB = b0 + sign * shift;
    if (back) {
      const a2 = first + (PINS - 1) * STEP + shift + back.run + r * STEP;
      pts.push(at(a2, lastB));
      lastA = a2 + back.shift;
      lastB -= sign * back.shift;
      pts.push(at(lastA, lastB));
    }
    const ends = rnd(seed) < 0.4;
    const total = ends ? Math.max(length * (0.5 + 0.35 * rnd(seed + 9)), lastA + 14) : length;
    pts.push(at(total, lastB));
    traces.push({
      d: pts.map(([x, y], k) => `${k ? "L" : "M"}${f(x)} ${f(y)}`).join(""),
      opacity: 0.3 + 0.55 * rnd(seed + 3),
      via: ends ? at(total, lastB) : undefined,
      glow: ends && rnd(seed + 5) < 0.4,
      pulse: rnd(seed + 7) < 0.55 ? { dur: 4 + 6 * rnd(seed + 11), delay: -10 * rnd(seed + 13) } : undefined,
    });
  }
  return traces;
}

const TRACES = SIDES.flatMap((s, i) => bundle(s, i));

/** Pin ticks: PINS short leads on each side of the chip. */
const PIN_PATH = (() => {
  let d = "";
  for (let i = 0; i < PINS; i++) {
    const b = (i - (PINS - 1) / 2) * PITCH;
    d += `M${f(CX + b)} ${CY - HALF}v${-PIN_LEN}M${f(CX + b)} ${CY + HALF}v${PIN_LEN}`;
    d += `M${CX - HALF} ${f(CY + b)}h${-PIN_LEN}M${CX + HALF} ${f(CY + b)}h${PIN_LEN}`;
  }
  return d;
})();

// Hand-placed extras: faint long routes in the lower field, glow pads, and little "data speck" clusters.
const AMBIENT = [
  "M0 300h70l30 30h60l24 24v70",
  "M0 336h40l22 22h46l20 20v60",
  "M0 372h96l20 20h22v90",
  "M0 408h60l40 40h30v72",
  "M0 262h46l18-18h40",
  "M0 120h20l14-14h60l16-16h50",
  "M40 0v70l20 20h30",
  "M76 0v40l16 16h40l14 14",
];
const PADS: [number, number][] = [
  [92, 90],
  [128, 244],
  [160, 354],
  [118, 392],
];
const SPECKS: [number, number][] = [
  [20, 196],
  [54, 232],
  [30, 52],
];

function Side({ flip }: { flip?: boolean }) {
  const id = flip ? "r" : "l";
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${W} ${H}`}
      className={`absolute top-0 hidden h-auto w-80 text-accent md:block [mask-image:radial-gradient(ellipse_at_41%_29%,black_30%,transparent_75%)] lg:w-96 ${flip ? "right-0 -scale-x-100" : "left-0"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="0.45"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <defs>
        <radialGradient id={`glow-${id}`}>
          <stop offset="0" stopColor="currentColor" stopOpacity="0.3" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`die-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.55" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.12" />
        </linearGradient>
      </defs>

      <circle cx={CX} cy={CY} r="150" fill={`url(#glow-${id})`} stroke="none" />

      <g opacity="0.22">
        {AMBIENT.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>

      <g>
        {TRACES.map((t, i) => (
          <path key={i} d={t.d} opacity={t.opacity} />
        ))}
      </g>

      {/* Lights travelling along random traces toward the chip; the path starts at the chip, so the dash runs end to start. */}
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

      {/* Via rings at the ends of shortened traces; some are lit pads with a halo. */}
      <g>
        {TRACES.map((t, i) =>
          t.via ? (
            <g key={i} opacity="0.85">
              <circle cx={t.via[0]} cy={t.via[1]} r="2.2" />
              {t.glow && (
                <>
                  <circle cx={t.via[0]} cy={t.via[1]} r="9" fill={`url(#glow-${id})`} stroke="none" />
                  <circle cx={t.via[0]} cy={t.via[1]} r="1.4" fill="currentColor" stroke="none" />
                </>
              )}
            </g>
          ) : null,
        )}
      </g>

      {/* Lit square pads on the faint routes. */}
      <g>
        {PADS.map(([x, y]) => (
          <g key={`${x}-${y}`}>
            <circle cx={x} cy={y} r="14" fill={`url(#glow-${id})`} stroke="none" />
            <rect x={x - 3} y={y - 3} width="6" height="6" rx="1" fill="currentColor" fillOpacity="0.5" opacity="0.9" />
          </g>
        ))}
      </g>

      {/* Data specks: tiny dashed rows that read as text on a board. */}
      <g opacity="0.45" strokeDasharray="3 2 1 2" strokeWidth="1">
        {SPECKS.map(([x, y]) => (
          <path key={`${x}-${y}`} d={`M${x} ${y}h34M${x} ${y + 5}h22M${x} ${y + 10}h40`} />
        ))}
      </g>

      {/* The chip. */}
      <g className="[filter:drop-shadow(0_0_5px_currentColor)]">
        <path d={PIN_PATH} strokeWidth="1.2" strokeLinecap="butt" opacity="0.95" />
        <rect
          x={CX - HALF}
          y={CY - HALF}
          width={HALF * 2}
          height={HALF * 2}
          rx="6"
          fill="currentColor"
          fillOpacity="0.1"
          strokeWidth="1"
        />
        <rect
          x={CX - 20}
          y={CY - 20}
          width="40"
          height="40"
          rx="3"
          fill={`url(#die-${id})`}
          strokeWidth="0.9"
          opacity="0.95"
        />
        <circle cx={CX - 25} cy={CY - 25} r="1.6" fill="currentColor" stroke="none" />
      </g>
    </svg>
  );
}

export function Circuit() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-full bg-[radial-gradient(ellipse_at_top,rgba(34,197,94,0.14),transparent_60%)]" />
      <div className="absolute inset-0 opacity-60 [mask-image:linear-gradient(to_bottom,black_60%,transparent)]">
        <Side />
        <Side flip />
      </div>
    </div>
  );
}
