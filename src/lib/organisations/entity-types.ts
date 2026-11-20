import { ValidationError } from "@/lib/errors";

/*
 * Business structure types and checks (examples ENT1-ENT8), with no server
 * imports so screens can use them too.
 */

export const ENTITY_TYPES = ["sole_trader", "partnership", "company", "look_through_company", "trust", "incorporated_society"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  sole_trader: "Sole trader",
  partnership: "Partnership",
  company: "Company",
  look_through_company: "Look-through company",
  trust: "Trust",
  incorporated_society: "Incorporated society",
};

/** What Settings › Directory calls the people who run it (ENT7). */
export const ENTITY_OFFICER_ROLE: Record<EntityType, string> = {
  sole_trader: "Owner",
  partnership: "Partner",
  company: "Director",
  look_through_company: "Director",
  trust: "Trustee",
  incorporated_society: "Committee member",
};

/** The income tax workpaper's taxpayer for a type (ENT3), or why Tohyee doesn't work it out. */
export function incomeTaxTaxpayerFor(type: EntityType): { taxpayerType: "company" | "individual" } | { unsupported: string } {
  switch (type) {
    case "company":
      return { taxpayerType: "company" };
    case "sole_trader":
      return { taxpayerType: "individual" };
    case "partnership":
      return { unsupported: "Tohyee's income tax is for companies and sole traders. A partnership's partners are taxed on their shares." };
    case "look_through_company":
      return { unsupported: "Tohyee's income tax is for companies and sole traders. A look-through company's owners are taxed on their shares." };
    case "trust":
      return { unsupported: "Tohyee's income tax is for companies and sole traders. A trust's income is taxed to the trustees or the beneficiaries." };
    case "incorporated_society":
      return { unsupported: "Tohyee's income tax is for companies and sole traders, not incorporated societies." };
  }
}

/**
 * An IRD number (ENT2): 8 or 9 digits, kept as 9, passing Inland Revenue's
 * published modulus 11 check digit (weights 3,2,7,6,5,4,3,2; when that gives
 * 10, weights 7,4,3,2,5,2,7,6; 10 again means the number isn't valid).
 */
export function parseIrdNumber(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") throw new ValidationError("The IRD number is text, like 123-456-789.");
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (!/^[\d\s-]+$/.test(trimmed)) throw new ValidationError("An IRD number has 8 or 9 digits, like 123-456-789.");
  const digits = trimmed.replace(/[\s-]/g, "");
  if (!/^\d{8,9}$/.test(digits)) throw new ValidationError("An IRD number has 8 or 9 digits, like 123-456-789.");
  const padded = digits.padStart(9, "0");
  if (!irdCheckDigitOk(padded)) throw new ValidationError("That IRD number doesn't pass Inland Revenue's check. Check the digits.");
  return padded;
}

function irdCheckDigitOk(nine: string): boolean {
  const base = nine.slice(0, 8).split("").map(Number);
  const check = Number(nine[8]);
  const digitFor = (weights: number[]) => {
    const remainder = base.reduce((sum, digit, index) => sum + digit * weights[index], 0) % 11;
    return remainder === 0 ? 0 : 11 - remainder;
  };
  let calculated = digitFor([3, 2, 7, 6, 5, 4, 3, 2]);
  if (calculated === 10) calculated = digitFor([7, 4, 3, 2, 5, 2, 7, 6]);
  if (calculated === 10) return false;
  return calculated === check;
}

/** 123-456-789, or 12-345-678 for an 8-digit number stored with its leading 0. */
export function formatIrdNumber(nine: string): string {
  const digits = nine.startsWith("0") ? nine.slice(1) : nine;
  return `${digits.slice(0, -6)}-${digits.slice(-6, -3)}-${digits.slice(-3)}`;
}
