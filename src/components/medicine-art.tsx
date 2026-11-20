import type { MedicineShape } from "@/lib/farming/medicine-rules";

/*
 * Tohyee's own drawings of medicine packs, by shape (MED3): generic, no
 * brands or label text. `colour` is the kind's colour.
 */
export function MedicineArt({ shape, colour, size = 72 }: { shape: MedicineShape; colour: string; size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">
      <ellipse cx="32" cy="59" rx="18" ry="3" fill="#000" opacity="0.12" />
      {DRAWINGS[shape](colour)}
    </svg>
  );
}

const LABEL = "#fdfdf8";
const DARK = "#2b2f36";
const SHINE = "#ffffff";

const DRAWINGS: Record<MedicineShape, (colour: string) => React.ReactNode> = {
  // An intramammary tube: a syringe body, a cap and a plunger.
  tube: (c) => (
    <g>
      <rect x="27" y="4" width="10" height="8" rx="2" fill={DARK} />
      <path d="M29 12h6l2 6H27z" fill="#c9ced6" />
      <rect x="22" y="18" width="20" height="30" rx="4" fill={c} />
      <rect x="25" y="24" width="14" height="14" rx="2" fill={LABEL} />
      <rect x="27" y="28" width="10" height="2" fill={c} opacity="0.7" />
      <rect x="27" y="32" width="7" height="2" fill={c} opacity="0.5" />
      <rect x="20" y="48" width="24" height="5" rx="2" fill={DARK} />
      <rect x="24" y="20" width="3" height="26" rx="1.5" fill={SHINE} opacity="0.35" />
    </g>
  ),
  // An injectable vial: crimp cap, neck and glass body.
  vial: (c) => (
    <g>
      <rect x="24" y="6" width="16" height="7" rx="2" fill={c} />
      <rect x="27" y="13" width="10" height="5" fill="#c9ced6" />
      <rect x="20" y="18" width="24" height="36" rx="5" fill="#dfe8ee" />
      <rect x="20" y="34" width="24" height="20" rx="5" fill={c} opacity="0.35" />
      <rect x="22" y="24" width="20" height="16" rx="2" fill={LABEL} />
      <rect x="22" y="24" width="20" height="5" fill={c} />
      <rect x="25" y="32" width="14" height="2" fill={DARK} opacity="0.4" />
      <rect x="23" y="20" width="3" height="30" rx="1.5" fill={SHINE} opacity="0.6" />
    </g>
  ),
  // A bottle with a screw cap.
  bottle: (c) => (
    <g>
      <rect x="26" y="4" width="12" height="7" rx="2" fill={DARK} />
      <path d="M27 11h10v5l6 6v30a4 4 0 0 1-4 4H25a4 4 0 0 1-4-4V22l6-6z" fill={c} />
      <rect x="23" y="28" width="18" height="16" rx="2" fill={LABEL} />
      <rect x="26" y="32" width="12" height="2.5" fill={c} opacity="0.7" />
      <rect x="26" y="37" width="8" height="2" fill={c} opacity="0.5" />
      <rect x="24" y="22" width="3" height="30" rx="1.5" fill={SHINE} opacity="0.35" />
    </g>
  ),
  // A soft flexible bag with a hanging tab and an outlet.
  bag: (c) => (
    <g>
      <rect x="28" y="3" width="8" height="6" rx="3" fill="none" stroke={DARK} strokeWidth="2" />
      <path d="M18 10h28l2 36c0 4-4 7-8 7H24c-4 0-8-3-8-7z" fill={c} opacity="0.85" />
      <rect x="22" y="18" width="20" height="18" rx="2" fill={LABEL} />
      <rect x="25" y="22" width="14" height="2.5" fill={c} />
      <rect x="25" y="27" width="10" height="2" fill={c} opacity="0.6" />
      <rect x="29" y="53" width="6" height="7" rx="1" fill={DARK} />
    </g>
  ),
  // A drench pack: a backpack-style container with a hose outlet.
  drench: (c) => (
    <g>
      <rect x="14" y="12" width="32" height="42" rx="6" fill={c} />
      <rect x="20" y="6" width="10" height="7" rx="2" fill={DARK} />
      <path d="M46 20c8 0 10 6 10 14" fill="none" stroke={DARK} strokeWidth="3" strokeLinecap="round" />
      <rect x="18" y="24" width="24" height="18" rx="2" fill={LABEL} />
      <rect x="21" y="28" width="18" height="3" fill={c} />
      <rect x="21" y="34" width="12" height="2" fill={c} opacity="0.6" />
      <rect x="16" y="14" width="3" height="36" rx="1.5" fill={SHINE} opacity="0.3" />
    </g>
  ),
  // A pour-on pack: a squeeze-measure chamber on top.
  pour_on: (c) => (
    <g>
      <rect x="24" y="2" width="16" height="12" rx="3" fill="#e4eaef" stroke={DARK} strokeWidth="1.5" />
      <rect x="26" y="8" width="12" height="5" fill={c} opacity="0.5" />
      <rect x="29" y="14" width="6" height="4" fill={DARK} />
      <rect x="16" y="18" width="32" height="36" rx="5" fill={c} />
      <rect x="20" y="26" width="24" height="18" rx="2" fill={LABEL} />
      <rect x="23" y="30" width="18" height="3" fill={c} />
      <rect x="23" y="36" width="12" height="2" fill={c} opacity="0.6" />
    </g>
  ),
  // A jerry can with a handle.
  jerry: (c) => (
    <g>
      <path d="M14 18l8-8h16v8H22v-2z" fill={c} />
      <rect x="40" y="6" width="8" height="8" rx="2" fill={DARK} />
      <rect x="12" y="16" width="38" height="38" rx="5" fill={c} />
      <rect x="18" y="26" width="26" height="18" rx="2" fill={LABEL} />
      <rect x="21" y="30" width="20" height="3" fill={c} />
      <rect x="21" y="36" width="14" height="2" fill={c} opacity="0.6" />
      <path d="M14 48l34-28" stroke="#000" strokeOpacity="0.08" strokeWidth="4" />
    </g>
  ),
  // Boluses in a tub.
  bolus: (c) => (
    <g>
      <rect x="20" y="8" width="8" height="18" rx="4" fill={c} transform="rotate(-20 24 17)" />
      <rect x="30" y="6" width="8" height="18" rx="4" fill={c} opacity="0.85" />
      <rect x="38" y="10" width="8" height="18" rx="4" fill={c} transform="rotate(18 42 19)" />
      <path d="M14 24h36l-3 30H17z" fill="#e8edf2" stroke={DARK} strokeWidth="1.5" />
      <rect x="20" y="32" width="24" height="14" rx="2" fill={c} opacity="0.9" />
      <rect x="23" y="36" width="18" height="2.5" fill={LABEL} />
    </g>
  ),
  // A sachet with a tear notch.
  sachet: (c) => (
    <g>
      <path d="M16 8h32v46H16z" fill={c} />
      <path d="M16 8h32v6H16z" fill="#000" opacity="0.15" />
      <path d="M44 8l4 4V8z" fill="#fff" />
      <rect x="20" y="22" width="24" height="20" rx="2" fill={LABEL} />
      <circle cx="32" cy="30" r="4" fill={c} opacity="0.7" />
      <rect x="24" y="37" width="16" height="2" fill={c} opacity="0.6" />
    </g>
  ),
  // An aerosol spray can.
  spray: (c) => (
    <g>
      <rect x="28" y="4" width="10" height="6" rx="1.5" fill={DARK} />
      <rect x="37" y="5" width="6" height="2.5" fill={DARK} />
      <path d="M22 14c0-4 20-4 20 0z" fill="#c9ced6" />
      <rect x="22" y="14" width="20" height="40" rx="3" fill={c} />
      <rect x="22" y="24" width="20" height="18" fill={LABEL} />
      <rect x="25" y="28" width="14" height="3" fill={c} />
      <rect x="25" y="34" width="10" height="2" fill={c} opacity="0.6" />
      <rect x="24" y="16" width="3" height="36" rx="1.5" fill={SHINE} opacity="0.35" />
    </g>
  ),
  // A carton.
  box: (c) => (
    <g>
      <path d="M12 20l20-10 20 10v28L32 58 12 48z" fill={c} />
      <path d="M12 20l20 10 20-10" fill="none" stroke="#000" strokeOpacity="0.18" strokeWidth="1.5" />
      <path d="M32 30v28" stroke="#000" strokeOpacity="0.18" strokeWidth="1.5" />
      <path d="M15 27l14 7v14l-14-7z" fill={LABEL} />
      <path d="M17 31l10 5" stroke={c} strokeWidth="2" />
    </g>
  ),
};
