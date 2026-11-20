import { cmp, dec, isPositive } from "@/lib/money/decimal";

/*
 * The medicine cabinet's rules (examples MED1-MED10; following common
 * practice, not yet reviewed). Browser-safe. Kinds are generic, never brands,
 * and nothing here supplies a withholding period.
 */

/** The drawings Tohyee draws for a kind (MED3). */
export const MEDICINE_SHAPES = ["tube", "vial", "bottle", "bag", "drench", "pour_on", "jerry", "bolus", "sachet", "spray", "box"] as const;
export type MedicineShape = (typeof MEDICINE_SHAPES)[number];

type KindInfo = { label: string; shape: MedicineShape; unit: "L" | "kg" | "each" | "doses"; colour: string };

/** The kinds (MED2), each with its drawing, usual stock unit and colour. */
export const MEDICINE_KINDS = {
  mastitis_tubes: { label: "Mastitis tubes", shape: "tube", unit: "each", colour: "#c0392b" },
  dry_cow: { label: "Dry cow therapy", shape: "tube", unit: "each", colour: "#8e44ad" },
  teat_sealant: { label: "Teat sealant", shape: "tube", unit: "each", colour: "#2c3e50" },
  injectable_antibiotic: { label: "Injectable antibiotic", shape: "vial", unit: "L", colour: "#d35400" },
  anti_inflammatory: { label: "Anti-inflammatory", shape: "vial", unit: "L", colour: "#16a085" },
  calcium_magnesium: { label: "Calcium and magnesium", shape: "bag", unit: "L", colour: "#2980b9" },
  energy_drench: { label: "Energy drench (ketosis)", shape: "bottle", unit: "L", colour: "#f39c12" },
  oral_drench: { label: "Oral drench", shape: "drench", unit: "L", colour: "#27ae60" },
  pour_on: { label: "Pour-on", shape: "pour_on", unit: "L", colour: "#1abc9c" },
  injectable_drench: { label: "Injectable drench", shape: "vial", unit: "L", colour: "#2ecc71" },
  lice_flystrike: { label: "Lice and flystrike", shape: "jerry", unit: "L", colour: "#7f8c8d" },
  vaccine: { label: "Vaccine", shape: "vial", unit: "doses", colour: "#3498db" },
  vitamin_mineral: { label: "Vitamin and mineral injection", shape: "vial", unit: "L", colour: "#e84393" },
  mineral_bolus: { label: "Mineral bolus", shape: "bolus", unit: "each", colour: "#6d4c41" },
  bloat: { label: "Bloat treatment", shape: "jerry", unit: "L", colour: "#b8860b" },
  scour_electrolytes: { label: "Scour treatment and electrolytes", shape: "sachet", unit: "kg", colour: "#0097a7" },
  footrot: { label: "Footrot and footbath", shape: "jerry", unit: "kg", colour: "#5d6d7e" },
  eye: { label: "Eye treatment", shape: "spray", unit: "each", colour: "#00838f" },
  wound_spray: { label: "Wound spray", shape: "spray", unit: "each", colour: "#6c3483" },
  reproduction: { label: "Reproduction products", shape: "box", unit: "each", colour: "#ad1457" },
  teat_spray: { label: "Teat spray", shape: "jerry", unit: "L", colour: "#0277bd" },
  other: { label: "Other", shape: "box", unit: "each", colour: "#757575" },
} as const satisfies Record<string, KindInfo>;
export type MedicineKind = keyof typeof MEDICINE_KINDS;
export const MEDICINE_KIND_KEYS = Object.keys(MEDICINE_KINDS) as MedicineKind[];

export function isMedicineKind(value: unknown): value is MedicineKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MEDICINE_KINDS, value);
}

/** The common lists (MED2). */
export const STARTER_LISTS = {
  dairy: [
    "mastitis_tubes",
    "dry_cow",
    "teat_sealant",
    "injectable_antibiotic",
    "anti_inflammatory",
    "calcium_magnesium",
    "energy_drench",
    "oral_drench",
    "pour_on",
    "vaccine",
    "vitamin_mineral",
    "mineral_bolus",
    "bloat",
    "scour_electrolytes",
    "footrot",
    "eye",
    "wound_spray",
    "reproduction",
    "teat_spray",
  ],
  sheep: [
    "oral_drench",
    "injectable_drench",
    "lice_flystrike",
    "vaccine",
    "vitamin_mineral",
    "mineral_bolus",
    "injectable_antibiotic",
    "anti_inflammatory",
    "footrot",
    "eye",
    "wound_spray",
    "scour_electrolytes",
    "calcium_magnesium",
    "energy_drench",
  ],
} as const satisfies Record<string, readonly MedicineKind[]>;
export type StarterList = keyof typeof STARTER_LISTS;
export const STARTER_LIST_LABELS: Record<StarterList, string> = { dairy: "Dairy farm", sheep: "Sheep farm" };

export type MedicineBadge = "ok" | "low" | "out" | "count" | "none";

/** Running low, out, or count it (MED6). `none`: nothing recorded yet. */
export function stockBadge(onHand: string | null, reorderAt: string | null): MedicineBadge {
  if (onHand === null) return "none";
  const amount = dec(onHand);
  if (cmp(amount, dec("0")) < 0) return "count";
  if (!isPositive(amount)) return "out";
  if (reorderAt !== null && cmp(amount, dec(reorderAt)) <= 0) return "low";
  return "ok";
}

export const BADGE_LABELS: Record<MedicineBadge, string> = { ok: "", low: "Running low", out: "Out", count: "Count it", none: "No stock recorded" };

/** Expired, or expires within 30 days (MED7). */
export function expiryState(expiresOn: string | null, today: string): "expired" | "soon" | "ok" | null {
  if (!expiresOn) return null;
  if (expiresOn < today) return "expired";
  return expiresOn <= addDaysIso(today, 30) ? "soon" : "ok";
}

function addDaysIso(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * The soonest expiry of stock on hand (MED7): received since the last count,
 * or the count's own; none when there's nothing on hand. `moves` oldest first.
 */
export function soonestExpiry(moves: ReadonlyArray<{ kind: string; expiresOn?: string | null }>, onHand: string | null): string | null {
  if (onHand === null || !isPositive(dec(onHand))) return null;
  let lastCount = -1;
  moves.forEach((move, index) => {
    if (move.kind === "counted") lastCount = index;
  });
  const dates = moves
    .slice(Math.max(lastCount, 0))
    .filter((move, index) => (move.kind === "received" || move.kind === "moved_in" || (move.kind === "counted" && index === 0 && lastCount >= 0)) && move.expiresOn)
    .map((move) => move.expiresOn as string)
    .sort();
  return dates[0] ?? null;
}
