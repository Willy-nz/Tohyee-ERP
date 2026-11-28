import { useId } from "react";
import styles from "./farm-hero.module.css";

/*
 * The small pictures farm panels draw on their tiles. They're first drafts,
 * drawn in code so they follow the data (a gauge fills, a pen holds more
 * stock); issue #121 tracks better artwork. Each is decoration beside words that say the same
 * thing, so all are hidden from a screen reader.
 */

const INK = "#0f2228";
const RAIL = "#d7c9a3";

/** A rain gauge filled to the reading. The tube's top is 50 mm, a heavy day; more than that just fills it. */
export function RainGaugeArt({ mm }: { mm: number | null }) {
  const level = mm === null ? 0 : Math.max(0, Math.min(1, mm / 50));
  const height = Math.round(level * 40);
  const clip = useId();
  return (
    <svg className={styles.art} viewBox="0 0 36 56" aria-hidden="true">
      <path d="M8 4h20l-3 6v38a7 7 0 0 1-14 0V10Z" fill="rgb(255 255 255 / 0.08)" stroke="#cfe9e2" strokeWidth="1.6" strokeLinejoin="round" />
      <clipPath id={clip}>
        <path d="M12 11h12v37a6 6 0 0 1-12 0Z" />
      </clipPath>
      <rect x="12" y={54 - height} width="12" height={height} fill="#6fc3e8" clipPath={`url(#${clip})`} />
      {[18, 28, 38].map((y) => (
        <path key={y} d={`M24 ${y}h-4`} stroke="#cfe9e2" strokeWidth="1.2" strokeLinecap="round" />
      ))}
      {mm === null ? null : <path d="M30 20c2.2 3 3.4 4.8 3.4 6.3a3.4 3.4 0 0 1-6.8 0c0-1.5 1.2-3.3 3.4-6.3Z" fill="#6fc3e8" />}
    </svg>
  );
}

/** A pen in the yards: post-and-rail fence with a dot for each fifty head or so, up to twelve. */
export function PenArt({ head }: { head: number }) {
  const dots = head <= 0 ? 0 : Math.max(1, Math.min(12, Math.round(head / 50)));
  return (
    <svg className={styles.art} viewBox="0 0 56 44" aria-hidden="true">
      <rect x="3" y="6" width="50" height="34" rx="3" fill="rgb(141 201 140 / 0.16)" />
      {Array.from({ length: dots }, (_, i) => (
        <ellipse key={i} cx={11 + (i % 4) * 11.5} cy={15 + Math.floor(i / 4) * 9} rx="3.6" ry="2.6" fill="#f3efe2" stroke={INK} strokeWidth="0.8" />
      ))}
      <path d="M3 12h50M3 24h50M3 36h50" stroke={RAIL} strokeWidth="2" strokeLinecap="round" opacity="0.9" />
      {[3, 19.5, 36.5, 53].map((x) => (
        <path key={x} d={`M${x} 4v38`} stroke={RAIL} strokeWidth="3" strokeLinecap="round" />
      ))}
    </svg>
  );
}

/** An ear tag. Yellow unless the mob's own tag colour is one it can draw. */
export function EarTagArt({ colour }: { colour?: string | null }) {
  const fill = TAG_COLOURS[(colour ?? "").trim().toLowerCase()] ?? "#f2c94c";
  return (
    <svg className={styles.art} viewBox="0 0 36 48" aria-hidden="true">
      <path d="M13 3h10v9l8 7v21a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5V19l8-7Z" fill={fill} stroke={INK} strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="18" cy="8.5" r="2.2" fill={INK} />
      <path d="M11 27h14M11 33h14M11 39h9" stroke={INK} strokeWidth="1.8" strokeLinecap="round" opacity="0.55" />
    </svg>
  );
}
const TAG_COLOURS: Record<string, string> = { yellow: "#f2c94c", blue: "#6fa8dc", green: "#7fc97f", red: "#e06c5a", orange: "#f2994a", white: "#f5f5f0", pink: "#f4a6c0", purple: "#b08ad9" };

/** A note pinned to the job board. The pin is red when the job is overdue. */
export function PinnedNoteArt({ overdue }: { overdue: boolean }) {
  return (
    <svg className={styles.art} viewBox="0 0 40 44" aria-hidden="true">
      <path d="M5 8h30v24l-8 8H5Z" fill="#fbf3d0" stroke={INK} strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M27 40v-8h8" fill="#e8dcae" stroke={INK} strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M10 18h20M10 24h20M10 30h11" stroke={INK} strokeWidth="1.6" strokeLinecap="round" opacity="0.45" />
      <circle cx="20" cy="7" r="4.5" fill={overdue ? "#e0604c" : "#e6a93a"} stroke={INK} strokeWidth="1.2" />
    </svg>
  );
}

/** A soil core: pasture on top, then topsoil and subsoil. Decoration only: it doesn't change with the results. */
export function SoilCoreArt() {
  const clip = useId();
  return (
    <svg className={styles.art} viewBox="0 0 30 52" aria-hidden="true">
      <clipPath id={clip}>
        <rect x="7" y="8" width="16" height="40" rx="3" />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <rect x="7" y="8" width="16" height="6" fill="#7fc97f" />
        <rect x="7" y="14" width="16" height="14" fill="#6b4a33" />
        <rect x="7" y="28" width="16" height="11" fill="#9a7350" />
        <rect x="7" y="39" width="16" height="9" fill="#c2a47c" />
        <circle cx="12" cy="20" r="1.2" fill="#3d2a1c" />
        <circle cx="18" cy="24" r="1" fill="#3d2a1c" />
        <circle cx="14" cy="33" r="1.2" fill="#6b4a33" />
        <circle cx="19" cy="43" r="1" fill="#9a7350" />
      </g>
      <rect x="7" y="8" width="16" height="40" rx="3" fill="none" stroke="#cfe9e2" strokeWidth="1.4" />
      <path d="M10 8V4m5 4V2m5 6V5" stroke="#7fc97f" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The feed wedge: a bar for each paddock's cover, highest first, with the
 * farm's average as a dashed line. The first and last bars carry their
 * paddock's name; the figures are all in the list underneath.
 */
export function FeedWedgeArt({ bars, average }: { bars: Array<{ name: string; cover: number }>; average: number | null }) {
  const width = 300;
  const top = 8;
  const floor = 92;
  const max = Math.max(1, ...bars.map((bar) => bar.cover));
  const step = width / Math.max(bars.length, 1);
  const y = (cover: number) => floor - (Math.max(0, cover) / max) * (floor - top);
  return (
    <svg className={styles.chart} viewBox={`0 0 ${width} 112`} aria-hidden="true">
      {bars.map((bar, i) => (
        <rect key={`${bar.name}-${i}`} x={i * step + step * 0.12} y={y(bar.cover)} width={step * 0.76} height={floor - y(bar.cover)} rx={Math.min(3, step * 0.2)} fill={i === 0 ? "#bde5c5" : "#7fc9a0"} opacity={0.55 + 0.45 * (bar.cover / max)} />
      ))}
      <path d={`M0 ${floor}h${width}`} stroke="#cfe9e2" strokeWidth="1" opacity="0.5" />
      {average !== null && average > 0 && average <= max ? <path d={`M0 ${y(average)}h${width}`} stroke="#ffe3af" strokeWidth="1.4" strokeDasharray="5 4" /> : null}
      {bars.length ? (
        <text x="2" y="108" fill="#d3e2dc" fontSize="12">
          {bars[0].name}
        </text>
      ) : null}
      {bars.length > 1 ? (
        <text x={width - 2} y="108" fill="#d3e2dc" fontSize="12" textAnchor="end">
          {bars[bars.length - 1].name}
        </text>
      ) : null}
    </svg>
  );
}

/** A bag of fertiliser, for a plan. */
export function FertiliserBagArt() {
  return (
    <svg className={styles.art} viewBox="0 0 36 48" aria-hidden="true">
      <path d="M8 9c3 2 17 2 20 0l3 6c-1.5 8-1.5 18 0 26-4 3-22 3-26 0 1.5-8 1.5-18 0-26Z" fill="#f3efe2" stroke={INK} strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 9c1-3 3-5 4-6h12c1 1 3 3 4 6" fill="#e3dcc4" stroke={INK} strokeWidth="1.3" strokeLinejoin="round" />
      <rect x="11" y="20" width="14" height="12" rx="2" fill="#7fc97f" stroke={INK} strokeWidth="1" />
      <path d="M18 30v-7m0 3c-2-.5-3-2-3-3.5m3 5c2-.5 3-2 3-3.5" stroke={INK} strokeWidth="1.1" strokeLinecap="round" fill="none" />
    </svg>
  );
}
