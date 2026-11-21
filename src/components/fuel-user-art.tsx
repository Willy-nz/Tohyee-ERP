import type { FuelUserKind } from "@/lib/farming/fuel-refund-rules";

/*
 * Tohyee's own drawings of what uses petrol on a farm (FUEL6), in the same
 * style as the illustrated icons. Generic: no makes or models.
 */
export function FuelUserArt({ kind, size = 56 }: { kind: FuelUserKind; size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">
      <g fill="none" stroke="#233E45" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        {DRAWINGS[kind]}
      </g>
    </svg>
  );
}

const wheel = (cx: number, cy: number, r: number) => (
  <>
    <circle cx={cx} cy={cy} r={r} fill="#B9D9EE" />
    <circle cx={cx} cy={cy} r={r / 3} fill="#FFFDF7" />
  </>
);

const DRAWINGS: Record<FuelUserKind, React.ReactNode> = {
  quad: (
    <>
      <path d="M5 26h13m30-1h11" />
      <path fill="#A8D8BF" d="M5 38q1-10 11-10h9l5 5h7l4-8h8q9 0 10 13Z" />
      <path fill="#F3D48B" d="M21 28l3-6h11l2 6Z" />
      <path d="M42 25l3-10m-5 0h9" />
      {wheel(15, 46, 9)}
      {wheel(49, 46, 9)}
    </>
  ),
  motorbike: (
    <>
      <path fill="#A8D8BF" d="M16 40l8-12h14l6 6-4 6Z" />
      <path fill="#F3D48B" d="M22 28l2-4h10l2 4Z" />
      <path d="M44 34l4-14m-4 0h8" />
      {wheel(14, 46, 9)}
      {wheel(50, 46, 9)}
    </>
  ),
  side_by_side: (
    <>
      <path d="M16 30l4-14h22l6 14" />
      <path fill="#A8D8BF" d="M6 40q0-10 10-10h38q6 0 6 10Z" />
      <path fill="#F3D48B" d="M24 30v-8h10v8" />
      {wheel(16, 46, 8)}
      {wheel(48, 46, 8)}
    </>
  ),
  tractor: (
    <>
      <path fill="#A8D8BF" d="M24 38V18h16l4 14h10q4 0 4 6Z" />
      <path fill="#B9D9EE" d="M28 22h10l2 8H28Z" />
      <path d="M48 32v-14" />
      <circle cx="20" cy="42" r="13" fill="#B9D9EE" />
      <circle cx="20" cy="42" r="4" fill="#FFFDF7" />
      {wheel(52, 48, 7)}
    </>
  ),
  generator: (
    <>
      <path d="M10 18h44v30H10Z" />
      <rect x="14" y="22" width="36" height="22" rx="3" fill="#F3D48B" />
      <rect x="20" y="27" width="14" height="12" rx="2" fill="#FFFDF7" />
      <circle cx="42" cy="33" r="4" fill="#A8D8BF" />
      <path d="M10 48v6m44-6v6" />
    </>
  ),
  pump: (
    <>
      <rect x="12" y="26" width="26" height="20" rx="4" fill="#F3D48B" />
      <circle cx="46" cy="36" r="9" fill="#A8D8BF" />
      <path d="M46 27V16h12" />
      <path d="M55 36h6" />
      <path d="M10 50h44" />
      <rect x="16" y="30" width="10" height="8" rx="2" fill="#FFFDF7" />
    </>
  ),
  small_engine: (
    <>
      <rect x="6" y="24" width="22" height="18" rx="4" fill="#F3D48B" />
      <path d="M12 24v-6h10v6" />
      <path fill="#B9D9EE" d="M28 28h28q4 0 4 5t-4 5H28Z" />
      <path d="M32 33h24" strokeDasharray="3 3" />
      <circle cx="14" cy="33" r="3" fill="#FFFDF7" />
    </>
  ),
  road_vehicle: (
    <>
      <path fill="#A8D8BF" d="M4 42V32l8-2 6-10h16l6 10h18v12Z" />
      <path fill="#B9D9EE" d="M21 23h11l4 7H18Z" />
      <path d="M44 30v-6h14v6" />
      {wheel(16, 44, 7)}
      {wheel(48, 44, 7)}
    </>
  ),
  other: (
    <>
      <path fill="#F3D48B" d="M16 16l6-6h14v8H22v-2z" />
      <rect x="14" y="16" width="36" height="38" rx="5" fill="#F3D48B" />
      <rect x="20" y="26" width="24" height="16" rx="2" fill="#FFFDF7" />
      <path d="M42 8h8v8h-8z" fill="#233E45" />
    </>
  ),
};
