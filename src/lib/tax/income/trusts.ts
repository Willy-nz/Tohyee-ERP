// The app-wide income year rule (early balance dates count toward the next 31 March; TXF1).
import { incomeYearOf } from "@/lib/rd/amounts";
import { add, cmp, dec, type Decimal, isPositive, isZero, mul, roundHalfUp, sub, toFixedString, toPlainString, truncate, ZERO_DECIMAL } from "@/lib/money/decimal";

/*
 * Income tax for trusts (examples TRU1-TRU14; from IRD's trustee tax rate and
 * beneficiary income pages, the IR6 and IRD's 2024 trust webinar; following
 * common practice, not yet reviewed). Pure: the service loads the figures.
 */

export const TRUST_KINDS = ["family", "deceased_estate", "disabled_beneficiary", "lines_trust", "legacy_superannuation"] as const;
export type TrustKind = (typeof TRUST_KINDS)[number];
export const TRUST_KIND_LABELS: Record<TrustKind, string> = {
  family: "Family trust (most trusts)",
  deceased_estate: "Deceased estate",
  disabled_beneficiary: "Disabled beneficiary trust",
  lines_trust: "Lines trust (energy consumer trust)",
  legacy_superannuation: "Legacy superannuation fund",
};

export type Beneficiary = {
  id: string;
  name: string;
  kind: "person" | "company";
  dateOfBirth: string | null;
  /** The trust was settled by a relative or guardian of theirs (TRU2, TRU7). */
  settledByRelative: boolean;
  /** A disability allowance or child disability allowance is paid for them (TRU7). */
  disabilityAllowance: boolean;
  /** For a company: the corporate beneficiary rule applies to it (TRU8). */
  corporateRule: boolean;
};

const TRUSTEE_RATE = dec("0.39");
const LOWER_RATE = dec("0.33");
/** A legacy superannuation fund's rate: Income Tax Act 2007 sch 1 pt A cl 6(d), from 1 April 2024 (TXF13). */
const LEGACY_SUPERANNUATION_RATE = dec("0.28");
const DE_MINIMIS = dec("10000");
const MINOR_LIMIT = dec("1000");
/** The income year the 39% trustee rate starts (1 April 2024 to 31 March 2025 for a 31 March balance date). */
const TRUSTEE_RATE_FROM = 2025;

export type BeneficiaryLine = {
  beneficiaryId: string;
  name: string;
  amount: string;
  /** Taxed by the trustee at 39% (minor or corporate beneficiary rule), or taxed to the beneficiary. */
  taxedByTrustee: boolean;
  reason: string;
};

export type TrustTax = {
  kind: TrustKind;
  netIncome: string;
  beneficiaryIncome: string;
  /** IR6 box 21A. */
  ordinaryBeneficiaryIncome: string;
  /** IR6 box 21C. */
  minorCorporateIncome: string;
  /** IR6 box 28C. */
  minorCorporateTax: string;
  /** Trustee net income, before losses brought forward (TRU10). */
  trusteeNetIncome: string;
  lossesBroughtForward: string;
  lossesUsed: string;
  lossCarriedForward: string;
  trusteeIncome: string;
  trusteeRate: string;
  trusteeRateReason: string;
  trusteeTax: string;
  tax: string;
  lines: BeneficiaryLine[];
  notes: string[];
};

/** Age in whole years on a date. */
function ageOn(dateOfBirth: string, date: string): number {
  const [by, bm, bd] = dateOfBirth.split("-").map(Number);
  const [y, m, d] = date.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** The trustee's rate and why (TRU4-TRU6). */
export function trusteeRate(input: { kind: TrustKind; year: number; endMonth: number; dateOfDeath: string | null; trusteeNetIncome: Decimal }): { rate: Decimal; reason: string } {
  if (input.kind === "legacy_superannuation") {
    // Clause 6(d) was inserted from 1 April 2024; earlier years weren't checked (Tohyee starts at the 2025 income year).
    if (input.year < TRUSTEE_RATE_FROM) throw new Error("A legacy superannuation fund's rate before the 2025 income year isn't supported.");
    return { rate: LEGACY_SUPERANNUATION_RATE, reason: "28%: a legacy superannuation fund (Income Tax Act 2007 schedule 1 part A clause 6(d))." };
  }
  if (input.year < TRUSTEE_RATE_FROM) return { rate: LOWER_RATE, reason: "33%: the trustee rate before the 2025 income year." };
  if (input.kind === "disabled_beneficiary") return { rate: LOWER_RATE, reason: "33%: a disabled beneficiary trust." };
  if (input.kind === "lines_trust") return { rate: LOWER_RATE, reason: "33%: a lines trust, also called an energy consumer trust (schedule 1 part A clause 6B)." };
  if (input.kind === "deceased_estate" && input.dateOfDeath) {
    const deathYear = incomeYearOf(input.dateOfDeath, input.endMonth);
    if (input.year <= deathYear + 3) return { rate: LOWER_RATE, reason: `33%: a deceased estate in the income year of the death (${deathYear}) or the three after it.` };
  }
  if (cmp(input.trusteeNetIncome, DE_MINIMIS) <= 0) return { rate: LOWER_RATE, reason: "33%: the trustee's net income is $10,000 or less." };
  return { rate: TRUSTEE_RATE, reason: "39%: the trustee's net income is over $10,000, so the whole of it is taxed at 39%." };
}

/**
 * The trust's tax for an income year (TRU3-TRU11): beneficiary income comes off
 * net income; the minor and corporate beneficiary rules tax some of it at 39%
 * by the trustee; losses come off trustee income only.
 */
export function trustTax(input: {
  kind: TrustKind;
  dateOfDeath: string | null;
  year: number;
  endMonth: number;
  /** The end of the income year, for ages (TRU7). */
  yearEnd: string;
  /** Net income before losses brought forward. */
  netIncome: Decimal;
  lossesBroughtForward: Decimal;
  /** fromMaoriAuthority: the allocation all comes from a Māori authority distribution (TXF7). */
  allocations: Array<{ beneficiary: Beneficiary; amount: Decimal; fromMaoriAuthority?: boolean }>;
}): TrustTax {
  const notes: string[] = [];
  const lines: BeneficiaryLine[] = [];
  let ordinary = ZERO_DECIMAL;
  let minorCorporate = ZERO_DECIMAL;
  // TXF12, TXF13: the rule's exclusions checked are disabled beneficiary trusts and estates; it still applies to the others.
  const minorRuleApplies = input.kind !== "deceased_estate" && input.kind !== "disabled_beneficiary";
  for (const { beneficiary, amount, fromMaoriAuthority } of input.allocations) {
    if (!isPositive(amount)) continue;
    let taxedByTrustee = false;
    let reason = "Taxed to the beneficiary.";
    if (beneficiary.kind === "company") {
      if (beneficiary.corporateRule && input.year >= TRUSTEE_RATE_FROM) {
        taxedByTrustee = true;
        reason = "Corporate beneficiary rule: taxed by the trustee at 39%.";
      } else reason = "A company the corporate beneficiary rule doesn't apply to: taxed to the company.";
    } else if (!beneficiary.dateOfBirth) {
      reason = "Taxed to the beneficiary. No date of birth, so treated as 16 or older.";
      notes.push(`${beneficiary.name} has no date of birth, so they're treated as 16 or older.`);
    } else if (ageOn(beneficiary.dateOfBirth, input.yearEnd) < 16) {
      if (!minorRuleApplies) reason = input.kind === "deceased_estate" ? "Under 16, but the minor beneficiary rule doesn't apply to a deceased estate." : "Under 16, but the minor beneficiary rule doesn't apply to a disabled beneficiary trust.";
      else if (!beneficiary.settledByRelative) reason = "Under 16, but the trust wasn't settled by a relative or guardian of theirs.";
      else if (beneficiary.disabilityAllowance) reason = "Under 16, but a disability allowance is paid for them.";
      else if (fromMaoriAuthority) reason = "Under 16, but the income comes from a Māori authority distribution.";
      else if (cmp(amount, MINOR_LIMIT) <= 0) reason = "Under 16, but $1,000 or less this year.";
      else {
        taxedByTrustee = true;
        reason = "Minor beneficiary rule: under 16 and over $1,000, so all of it is taxed by the trustee at 39%.";
      }
    }
    if (taxedByTrustee) minorCorporate = add(minorCorporate, amount);
    else ordinary = add(ordinary, amount);
    lines.push({ beneficiaryId: beneficiary.id, name: beneficiary.name, amount: money(amount), taxedByTrustee, reason });
  }
  const beneficiaryIncome = add(ordinary, minorCorporate);
  let trusteeNetIncome = sub(input.netIncome, beneficiaryIncome);
  if (isPositive(beneficiaryIncome) && cmp(beneficiaryIncome, input.netIncome) > 0) {
    notes.push(
      isPositive(input.netIncome)
        ? `Beneficiary income of ${money(beneficiaryIncome)} is more than the year's net income of ${money(input.netIncome)}. Check the allocations; trustee income is treated as nil.`
        : `Beneficiary income of ${money(beneficiaryIncome)} is allocated, but the trust has no net income this year. A trust loss can't be allocated to beneficiaries; trustee income is treated as nil.`,
    );
    trusteeNetIncome = ZERO_DECIMAL;
  }
  // TRU10: losses come off trustee income only.
  let lossesUsed = ZERO_DECIMAL;
  let carried = input.lossesBroughtForward;
  let trusteeIncome = trusteeNetIncome;
  if (isPositive(trusteeNetIncome)) {
    lossesUsed = cmp(input.lossesBroughtForward, trusteeNetIncome) < 0 ? input.lossesBroughtForward : trusteeNetIncome;
    trusteeIncome = sub(trusteeNetIncome, lossesUsed);
    carried = sub(input.lossesBroughtForward, lossesUsed);
  } else if (!isZero(trusteeNetIncome)) {
    carried = sub(input.lossesBroughtForward, trusteeNetIncome);
    trusteeIncome = ZERO_DECIMAL;
  }
  const { rate, reason } = trusteeRate({ kind: input.kind, year: input.year, endMonth: input.endMonth, dateOfDeath: input.dateOfDeath, trusteeNetIncome });
  if (input.kind === "legacy_superannuation") {
    notes.push(
      "IRD's registered superannuation funds page says a registered fund files an IR44, which Tohyee doesn't produce. Use this kind for a legacy superannuation fund that files an IR6. Tohyee uses 28% on all its trustee income, without the $10,000 test.",
    );
    if (isPositive(beneficiaryIncome)) notes.push("Tohyee hasn't checked how beneficiary income works for a superannuation fund. Check the allocations.");
  }
  if (input.kind === "deceased_estate" && !input.dateOfDeath) notes.push("The date of death isn't set, so the estate is taxed as a family trust. Set it under Tax settings.");
  // Whole dollars, as the other returns (ITX50).
  const trusteeTax = isPositive(trusteeIncome) ? roundHalfUp(mul(truncate(trusteeIncome, 0), rate), 2) : ZERO_DECIMAL;
  const minorCorporateTax = roundHalfUp(mul(minorCorporate, TRUSTEE_RATE), 2);
  if (cmp(rate, LOWER_RATE) === 0 && reason.startsWith("33%: the trustee's net income")) {
    notes.push("The 33% rate for a trustee's net income of $10,000 or less applies to most trusts; check no rule stops this trust using it.");
  }
  return {
    kind: input.kind,
    netIncome: money(input.netIncome),
    beneficiaryIncome: money(beneficiaryIncome),
    ordinaryBeneficiaryIncome: money(ordinary),
    minorCorporateIncome: money(minorCorporate),
    minorCorporateTax: money(minorCorporateTax),
    trusteeNetIncome: money(trusteeNetIncome),
    lossesBroughtForward: money(input.lossesBroughtForward),
    lossesUsed: money(lossesUsed),
    lossCarriedForward: money(carried),
    trusteeIncome: money(trusteeIncome),
    trusteeRate: toPlainString(rate),
    trusteeRateReason: reason,
    trusteeTax: money(trusteeTax),
    tax: money(add(trusteeTax, minorCorporateTax)),
    lines,
    notes,
  };
}

function money(value: Decimal): string {
  return toFixedString(roundHalfUp(value, 2), 2);
}
