import type { ReactNode } from "react";
import type { MedicineShape } from "@/lib/farming/medicine-rules";

/**
 * Generic packshots inspired by the real veterinary supply formats found in NZ:
 * intramammary syringes, injectable vials, oral-drench jugs, two-chamber pour-ons,
 * large handled chemical cans, bolus pails, electrolyte sachets and aerosol cans.
 *
 * Intentionally unbranded. The farm's own uploaded product photo takes precedence
 * in the medicine cabinet. Do not infer specific drug, dose or withholding from art.
 */
export function MedicineArt({ shape, colour, size = 72 }: { shape: MedicineShape; colour: string; size?: number }) {
  const key = "med-" + shape;
  return (
    <svg viewBox="0 0 96 96" width={size} height={size} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={key + "-plastic"} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#aebbc0" />
          <stop offset=".14" stopColor="#fff" />
          <stop offset=".55" stopColor="#f7faf8" />
          <stop offset=".83" stopColor="#d2dfe0" />
          <stop offset="1" stopColor="#aebcc0" />
        </linearGradient>
        <linearGradient id={key + "-glass"} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#859fa8" stopOpacity=".75" />
          <stop offset=".16" stopColor="#e4f4f6" stopOpacity=".75" />
          <stop offset=".56" stopColor="#f4fcff" stopOpacity=".4" />
          <stop offset=".9" stopColor="#adc3c9" stopOpacity=".75" />
          <stop offset="1" stopColor="#77949e" stopOpacity=".9" />
        </linearGradient>
        <linearGradient id={key + "-metal"} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#788791"/>
          <stop offset=".17" stopColor="#f6f9fb"/>
          <stop offset=".4" stopColor="#aab8c1"/>
          <stop offset=".7" stopColor="#fff"/>
          <stop offset="1" stopColor="#8998a1"/>
        </linearGradient>
        <linearGradient id={key + "-colour"} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={colour} stopOpacity=".78"/>
          <stop offset=".5" stopColor={colour}/>
          <stop offset="1" stopColor="#1d3e47" stopOpacity=".92"/>
        </linearGradient>
        <linearGradient id={key + "-amber"} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#513018"/>
          <stop offset=".25" stopColor="#ae6b23"/>
          <stop offset=".55" stopColor="#c98936"/>
          <stop offset="1" stopColor="#593514"/>
        </linearGradient>
        <linearGradient id={key + "-foil"} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#95a1a9"/>
          <stop offset=".18" stopColor="#e9eef0"/>
          <stop offset=".6" stopColor="#fff"/>
          <stop offset="1" stopColor="#a2acb5"/>
        </linearGradient>
      </defs>
      <ellipse cx="48" cy="88" rx="29" ry="4" fill="#051d24" opacity=".17"/>
      {DRAWINGS[shape](colour, key)}
    </svg>
  );
}

function PackLabel({ colour, x, y, width, height, curved = false }: {
  colour: string; x: number; y: number; width: number; height: number; curved?: boolean
}) {
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx="2" fill="#fffefb" />
      {curved ?
        <path d={`M${x} ${y + height * .62} Q${x + width * .35} ${y + height * .28} ${x + width * .62} ${y + height * .63} T${x + width} ${y + height * .53} V${y + height} H${x}Z`} fill={colour} opacity=".94" /> :
        <rect x={x} y={y + 4} width={width} height="6" fill={colour}/>}
      <rect x={x + 4} y={y + height - 9} width={width * .55} height="1.6" rx="0.8" fill="#5d7781" opacity=".43"/>
      <rect x={x + 4} y={y + height - 5} width={width * .35} height="1.3" rx=".6" fill="#5d7781" opacity=".26"/>
    </g>
  );
}

const DRAWINGS: Record<MedicineShape, (colour: string, key: string) => ReactNode> = {
  // In NZ dairy sheds a teat/mastitis tube is a slim plastic intramammary syringe.
  tube: (c, k) => (
    <g transform="rotate(-36 48 47)">
      <path d="M45 9V4M51 9V4" stroke="#c4d3d7" strokeWidth="2"/>
      <rect x="43" y="8" width="10" height="8" rx="2" fill={`url(#${k}-plastic)`} stroke="#9eafb3" strokeWidth=".8"/>
      <rect x="46.5" y="15" width="3" height="12" rx="1" fill="#e9f1f2" stroke="#9dabad" strokeWidth=".5"/>
      <rect x="36" y="26" width="24" height="44" rx="5" fill={`url(#${k}-plastic)`} stroke="#b5c1c5"/>
      <path d="M37 34H59V60H37Z" fill={c} opacity=".88"/>
      <rect x="39" y="40" width="18" height="12" rx="2" fill="#fffefc"/>
      <path d="M39 46Q48 41 57 47V52H39Z" fill={c} opacity=".75"/>
      <rect x="34" y="68" width="28" height="5" rx="2" fill="#f4f8f7" stroke="#b2bdc2"/>
      <rect x="46" y="73" width="4" height="9" fill="#dae5e6"/>
      <rect x="39" y="80" width="18" height="4" rx="2" fill="#eaf0ee" stroke="#a6b8ba"/>
      <path d="M39 29V66" stroke="#fff" strokeWidth="2" opacity=".55"/>
    </g>
  ),
  vial: (c, k) => (
    <g>
      <rect x="36" y="8" width="24" height="11" rx="3" fill={`url(#${k}-metal)`} stroke="#8599a1"/>
      <rect x="39" y="8" width="18" height="3" rx="1.5" fill={c}/>
      <rect x="40" y="19" width="16" height="8" fill="#c9d7d9" stroke="#8699a1" strokeWidth=".7"/>
      <rect x="29" y="25" width="38" height="57" rx="9" fill={`url(#${k}-glass)`} stroke="#9fb5ba" strokeWidth="1.2"/>
      <path d="M31 61H65V73Q65 80 58 80H38Q31 80 31 73Z" fill={c} opacity=".22"/>
      <PackLabel colour={c} x={31} y={38} width={34} height={28}/>
      <path d="M35 32V76" stroke="#fff" strokeWidth="3" opacity=".48" strokeLinecap="round"/>
    </g>
  ),
  bottle: (c, k) => (
    <g>
      <rect x="36" y="7" width="24" height="15" rx="4" fill={`url(#${k}-plastic)`} stroke="#a1afb4"/>
      {Array.from({length: 9}, (_,i) => <path key={i} d={`M${39+i*2} 10v9`} stroke="#9faeb3" strokeWidth=".6" opacity=".65"/>)}
      <rect x="38" y="21" width="20" height="8" rx="2" fill="#79451f"/>
      <path d="M35 27H61Q68 33 68 42V76Q68 83 61 83H35Q28 83 28 76V42Q28 33 35 27Z" fill={`url(#${k}-amber)`} stroke="#654322"/>
      <PackLabel colour={c} x={30} y={46} width={36} height={29} curved/>
      <path d="M33 38V75" stroke="#fff4d8" opacity=".3" strokeWidth="3" strokeLinecap="round"/>
    </g>
  ),
  bag: (c, k) => (
    <g>
      <path d="M39 9Q39 4 48 4Q57 4 57 9V16H62Q68 18 67 27L64 70Q63 77 56 78H40Q33 77 32 70L29 27Q28 18 34 16H39Z" fill={`url(#${k}-glass)`} stroke="#a5b9c0" strokeWidth="1.4"/>
      <circle cx="48" cy="10" r="3.8" fill="#e8f4f7" stroke="#9ab0b8" strokeWidth="1.2"/>
      <path d="M33 42Q48 46 63 42L61 68Q60 73 55 74H41Q36 73 35 68Z" fill={c} opacity=".13"/>
      <PackLabel colour={c} x={38} y={28} width={20} height={19}/>
      <path d="M37 21L36 70" stroke="#fff" strokeWidth="3" opacity=".46" strokeLinecap="round"/>
      <rect x="40" y="78" width="6" height="10" rx="1" fill={`url(#${k}-plastic)`} stroke="#91a6b0"/>
      <rect x="51" y="78" width="6" height="8" rx="1" fill={c} stroke="#91a6b0"/>
    </g>
  ),
  drench: (c, k) => (
    <g>
      <path d="M22 30V23Q22 18 28 18H41Q46 18 46 23V30H58Q73 30 73 44V75Q73 82 66 82H21Q14 82 14 75V37Q14 30 22 30Z" fill={`url(#${k}-plastic)`} stroke="#b0c0c1" strokeWidth="1.2"/>
      <path d="M24 31V25H38V34H24Z" fill="#234c4b"/>
      <path d="M24 31V25H38" fill="none" stroke="#f1f7f7" strokeWidth="3"/>
      <rect x="21" y="13" width="20" height="8" rx="2" fill={c} stroke="#537675"/>
      <PackLabel colour={c} x={20} y={48} width={48} height={27} curved/>
      <path d="M18 38V74" stroke="#fff" strokeWidth="3" opacity=".6"/>
    </g>
  ),
  pour_on: (c, k) => (
    <g>
      <path d="M20 28Q20 22 26 22H47V31H65Q73 31 73 40V74Q73 82 64 82H28Q20 82 20 74Z" fill={`url(#${k}-plastic)`} stroke="#a9bec1" strokeWidth="1.3"/>
      <rect x="23" y="13" width="22" height="10" rx="3" fill={`url(#${k}-plastic)`} stroke="#a1aeb3"/>
      <rect x="52" y="10" width="15" height="9" rx="2" fill={`url(#${k}-plastic)`} stroke="#a1aeb3"/>
      <path d="M54 19H65V35H54Z" fill={`url(#${k}-glass)`} stroke="#aac5c5"/>
      <path d="M54 27H65V35H54Z" fill={c} opacity=".35"/>
      <path d="M24 60H69V74Q69 78 65 78H27Q24 78 24 74Z" fill={c} opacity=".27"/>
      <PackLabel colour={c} x={27} y={41} width={38} height={29} curved/>
      <path d="M25 29V73" stroke="#fff" strokeWidth="2.5" opacity=".55"/>
    </g>
  ),
  jerry: (c, k) => (
    <g>
      <path d="M19 26V20Q19 15 25 15H35Q39 15 42 19L47 26H67Q75 26 75 34V75Q75 83 67 83H20Q12 83 12 75V34Q12 26 19 26Z" fill={`url(#${k}-colour)`} stroke="#46635e" strokeWidth="1.1"/>
      <path d="M24 26V22H34L38 26Z" fill="#103336"/>
      <rect x="53" y="17" width="16" height="11" rx="3" fill="#26393d"/>
      <path d="M17 31V74" stroke="#f5ffff" strokeWidth="3" opacity=".3" strokeLinecap="round"/>
      <PackLabel colour={c} x={19} y={41} width={49} height={30} curved/>
    </g>
  ),
  bolus: (c, k) => (
    <g>
      <path d="M21 26H75L71 72Q70 80 63 80H33Q26 80 25 72Z" fill={`url(#${k}-plastic)`} stroke="#a6b6bc" strokeWidth="1.2"/>
      <ellipse cx="48" cy="26" rx="28" ry="8" fill={`url(#${k}-plastic)`} stroke="#a5b3b9"/>
      <ellipse cx="48" cy="20" rx="28" ry="6" fill={c} stroke="#42685f"/>
      <path d="M27 42H68V67H28Z" fill="#fff"/>
      <path d="M27 59Q47 44 69 59V67H27Z" fill={c} opacity=".9"/>
      <rect x="29" y="48" width="22" height="2" fill="#667e88" opacity=".35"/>
      <g transform="rotate(-24 24 78)"><rect x="11" y="74" width="27" height="10" rx="5" fill="#e9d8ae" stroke="#c1b08a"/></g>
      <g transform="rotate(11 66 79)"><rect x="52" y="75" width="31" height="10" rx="5" fill="#efe0ba" stroke="#c1b08a"/></g>
    </g>
  ),
  sachet: (c, k) => (
    <g>
      <path d="M26 10H70V80H26Z" fill={`url(#${k}-foil)`} stroke="#aab6be"/>
      {Array.from({length: 10}, (_,i) => <path key={i} d={`M28 ${12+i*7}h40`} stroke="#83939c" opacity=".12"/>)}
      <path d="M29 10V80M67 10V80M26 15H70M26 75H70" stroke="#869ba5" strokeWidth="1.1" strokeDasharray="1 1.5"/>
      <path d="M31 30H65V66H31Z" fill="#fffdfb"/>
      <path d="M31 54Q48 45 65 52V66H31Z" fill={c}/>
      <path d="M36 39H60M36 43H54" stroke="#b4c1c4" strokeWidth="1.4"/>
    </g>
  ),
  spray: (c, k) => (
    <g>
      <rect x="37" y="9" width="19" height="12" rx="4" fill={`url(#${k}-plastic)`} stroke="#a5b5ba"/>
      <rect x="41" y="7" width="11" height="5" rx="1" fill="#7f949b"/>
      <rect x="49" y="10" width="12" height="3" rx="1.5" fill="#7e949b"/>
      <path d="M32 24Q48 19 64 24V76Q64 84 56 84H40Q32 84 32 76Z" fill={`url(#${k}-metal)`} stroke="#a8b6bc"/>
      <ellipse cx="48" cy="25" rx="16" ry="5" fill="#e8eef0" stroke="#a2b5ba"/>
      <PackLabel colour={c} x={34} y={39} width={28} height={32} curved/>
      <path d="M36 29V76" stroke="#fff" strokeWidth="3" opacity=".4"/>
    </g>
  ),
  box: (c) => (
    <g>
      <path d="M19 27L36 16H77L62 27Z" fill="#e2eaf0" stroke="#aabac5" strokeWidth=".8"/>
      <path d="M62 27L77 16V68L62 79Z" fill="#c5d4dc" stroke="#aabac5" strokeWidth=".8"/>
      <path d="M19 27H62V79H19Z" fill="#fdfefc" stroke="#b4c2c7"/>
      <path d="M19 27H62V41Q43 36 19 47Z" fill={c} opacity=".95"/>
      <path d="M19 66Q40 57 62 69V79H19Z" fill={c} opacity=".75"/>
      <path d="M62 40L77 29V46L62 57Z" fill={c} opacity=".72"/>
      <path d="M25 53H54M25 57H44" stroke="#8d9da4" strokeWidth="1.5" opacity=".45"/>
    </g>
  ),
};
