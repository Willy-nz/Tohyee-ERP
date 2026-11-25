import { add, cmp, dec, type Decimal, divide, isNegative, isPositive, isZero, mul, mulDiv, roundHalfUp, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import type { Beneficiary, TrustTax } from "@/lib/tax/income/trusts";

/*
 * The rest of a trust's return (examples TRU15-TRU27; from IRD's IR6 and IR6B
 * forms for 2025 and 2026, the 2026 IR6 guide (IR6G) and IRD's beneficiary
 * pages; following common practice, not yet reviewed): credits shared with
 * beneficiaries, tax the trustee pays for a beneficiary, distributions and the
 * beneficiary current account, foreign and non-complying trusts, and the IR6
 * and IR6B boxes. Pure: the service loads the figures.
 */

export const TRUST_CLASSES = ["complying", "foreign", "non_complying"] as const;
export type TrustClass = (typeof TRUST_CLASSES)[number];
export const TRUST_CLASS_LABELS: Record<TrustClass, string> = {
  complying: "Complying trust (most New Zealand trusts)",
  foreign: "Foreign trust",
  non_complying: "Non-complying trust",
};

/** Tax on a non-complying trust's taxable distributions (TRU22). */
const NON_COMPLYING_RATE = dec("0.45");

export type Credits = { overseas: Decimal; imputation: Decimal; other: Decimal };

/** A beneficiary's figures for the year (TRU3, TRU18, TRU21, TRU24). */
export type BeneficiaryYear = {
  beneficiary: Beneficiary & { irdNumber: string | null; jurisdiction: string | null; tin: string | null };
  /** Beneficiary income allocated (TRU3); nil when only a distribution was made. */
  amount: Decimal;
  /** The trustee pays the beneficiary's tax on it (IR6B "estate or trust paying tax", TRU18). */
  trusteePaysTax: boolean;
  /** The beneficiary's other taxable income, for working out that tax (TRU18). */
  otherIncome: Decimal;
  /** A foreign or non-complying trust's distribution that's taxable, other than beneficiary income (TRU21-TRU23). */
  taxableDistribution: Decimal;
  /** Distributions that aren't taxable: corpus, a complying trust's capital gains and the like (TRU21). */
  nonTaxableDistribution: Decimal;
  /** Taken out of their current account during the year (TRU24). */
  withdrawn: Decimal;
  /** Owed to them at the start of the year (TRU24). */
  openingBalance: Decimal;
  /** All of it comes from a Māori authority distribution (TXF7). */
  fromMaoriAuthority?: boolean;
};

/** One beneficiary's IR6B (TRU25), by meaning; boxes() gives the numbers. */
export type BeneficiaryStatement = {
  beneficiaryId: string;
  name: string;
  dateOfBirth: string | null;
  irdNumber: string | null;
  jurisdiction: string | null;
  tin: string | null;
  /** The minor or corporate beneficiary rule applies to this income (TRU7, TRU8). */
  taxedByTrustee: boolean;
  trusteePaysTax: boolean;
  beneficiaryIncome: string;
  /** A foreign trust's taxable distribution, in other income (TRU23). */
  foreignTaxableDistribution: string;
  /** Taxable income: beneficiary income plus a foreign trust's taxable distribution (IR6B 26I). */
  taxableIncome: string;
  /** A non-complying trust's taxable distribution (IR6B 26K, TRU22). */
  nonComplyingDistribution: string;
  overseasTax: string;
  imputationCredits: string;
  otherCredits: string;
  /** Filled in when the trustee pays their tax (TRU18). */
  tax: { taxOnIncome: string; afterOverseas: string; afterImputation: string; afterOther: string } | null;
  /** 45% of a non-complying trust's taxable distribution (IR6B 26S). */
  nonComplyingTax: string;
  /** Tax the trustee pays for them (IR6B 26T). */
  taxPayable: string;
  account: { opening: string; taxable: string; nonTaxable: string; withdrawn: string; closing: string };
};

export type TrustReturn = {
  trustClass: TrustClass;
  /** Credits on the trust's income, before sharing (TRU15). */
  totalCredits: { overseas: string; imputation: string; other: string };
  /** Passed to beneficiaries taxed as their own: theirs, not the trustee's (TRU15). */
  passedOn: { overseas: string; imputation: string; other: string };
  /** The trustee's share, including credits on minor and corporate beneficiary income (TRU15). */
  trusteeCredits: { overseas: string; imputation: string; other: string };
  statements: BeneficiaryStatement[];
  /** Tax the trustee pays for beneficiaries (IR6 26Z / 27Z, TRU18, TRU22). */
  beneficiaryTax: string;
  totalDistributions: string;
  taxableDistributions: string;
  notes: string[];
};

/**
 * Shares the credits, works out each beneficiary's IR6B and the tax the trustee
 * pays for them (TRU15-TRU25). `taxOn` is the individual or company tax for the
 * year on whole dollars.
 */
export function trustReturn(input: {
  trustClass: TrustClass;
  trust: TrustTax;
  credits: Credits;
  years: BeneficiaryYear[];
  taxOn: (income: Decimal, kind: "person" | "company") => Decimal;
}): TrustReturn {
  const notes: string[] = [];
  const net = dec(input.trust.netIncome);
  const allocated = dec(input.trust.beneficiaryIncome);
  // TRU15: the same share of each credit as of the income. When more is allocated than the net income (TRU11), share by what's allocated.
  const base = cmp(allocated, net) > 0 ? allocated : net;
  const taxedByTrustee = new Map(input.trust.lines.map((line) => [line.beneficiaryId, line.taxedByTrustee]));
  let passedOverseas = ZERO_DECIMAL;
  let passedImputation = ZERO_DECIMAL;
  let passedOther = ZERO_DECIMAL;
  let beneficiaryTax = ZERO_DECIMAL;
  let totalDistributions = ZERO_DECIMAL;
  let taxableDistributions = ZERO_DECIMAL;
  const statements: BeneficiaryStatement[] = [];
  for (const year of input.years) {
    const { beneficiary } = year;
    const income = isPositive(year.amount) ? year.amount : ZERO_DECIMAL;
    const byTrustee = taxedByTrustee.get(beneficiary.id) ?? false;
    const share = (credit: Decimal) => (isPositive(base) && isPositive(income) && isPositive(credit) ? mulDiv(credit, income, base, 2) : ZERO_DECIMAL);
    const overseas = share(input.credits.overseas);
    const imputation = share(input.credits.imputation);
    const other = share(input.credits.other);
    if (!byTrustee) {
      passedOverseas = add(passedOverseas, overseas);
      passedImputation = add(passedImputation, imputation);
      passedOther = add(passedOther, other);
    }
    // TRU21-TRU23: a taxable distribution only comes from a foreign or non-complying trust.
    let distribution = isPositive(year.taxableDistribution) ? year.taxableDistribution : ZERO_DECIMAL;
    if (isPositive(distribution) && input.trustClass === "complying") {
      notes.push(`${beneficiary.name} has a taxable distribution typed, but a complying trust's distributions other than beneficiary income aren't taxable. It's left out; type it as not taxable.`);
      distribution = ZERO_DECIMAL;
    }
    const foreignDistribution = input.trustClass === "foreign" ? distribution : ZERO_DECIMAL;
    const nonComplyingDistribution = input.trustClass === "non_complying" ? distribution : ZERO_DECIMAL;
    const taxableIncome = add(income, foreignDistribution);
    // TRU18: the trustee pays their tax: the share of tax on all their income that the trust income makes up.
    let tax: BeneficiaryStatement["tax"] = null;
    let afterOther = ZERO_DECIMAL;
    if (year.trusteePaysTax && !byTrustee && isPositive(taxableIncome)) {
      const other$ = isPositive(year.otherIncome) ? year.otherIncome : ZERO_DECIMAL;
      const total = add(taxableIncome, other$);
      const taxOnTotal = input.taxOn(total, beneficiary.kind);
      const taxOnIncome = mulDiv(taxOnTotal, taxableIncome, total, 2);
      const afterOverseas = cmp(overseas, taxOnIncome) > 0 ? ZERO_DECIMAL : sub(taxOnIncome, overseas);
      const afterImputation = sub(afterOverseas, imputation);
      afterOther = sub(afterImputation, other);
      tax = { taxOnIncome: money(taxOnIncome), afterOverseas: money(afterOverseas), afterImputation: money(afterImputation), afterOther: money(afterOther) };
    } else if (year.trusteePaysTax && byTrustee) {
      notes.push(`${beneficiary.name}'s income is taxed by the trustee under the minor or corporate beneficiary rule, so the trustee doesn't pay tax for them as well.`);
    }
    const nonComplyingTax = roundHalfUp(mul(nonComplyingDistribution, NON_COMPLYING_RATE), 2);
    const sumTax = add(tax ? afterOther : ZERO_DECIMAL, nonComplyingTax);
    const taxPayable = isNegative(sumTax) ? ZERO_DECIMAL : sumTax;
    beneficiaryTax = add(beneficiaryTax, taxPayable);
    // TRU24: the current account.
    const nonTaxable = isPositive(year.nonTaxableDistribution) ? year.nonTaxableDistribution : ZERO_DECIMAL;
    const taxableAccount = add(income, distribution);
    const closing = sub(add(add(year.openingBalance, taxableAccount), nonTaxable), year.withdrawn);
    totalDistributions = add(totalDistributions, add(taxableAccount, nonTaxable));
    taxableDistributions = add(taxableDistributions, distribution);
    if (!beneficiary.irdNumber && !beneficiary.tin && (isPositive(taxableAccount) || isPositive(nonTaxable))) {
      notes.push(`${beneficiary.name} has no IRD number. The IR6B asks for it (or their overseas tax number).`);
    }
    statements.push({
      beneficiaryId: beneficiary.id,
      name: beneficiary.name,
      dateOfBirth: beneficiary.dateOfBirth,
      irdNumber: beneficiary.irdNumber,
      jurisdiction: beneficiary.jurisdiction,
      tin: beneficiary.tin,
      taxedByTrustee: byTrustee,
      trusteePaysTax: tax !== null,
      beneficiaryIncome: money(income),
      foreignTaxableDistribution: money(foreignDistribution),
      taxableIncome: money(taxableIncome),
      nonComplyingDistribution: money(nonComplyingDistribution),
      overseasTax: money(overseas),
      imputationCredits: money(imputation),
      otherCredits: money(other),
      tax,
      nonComplyingTax: money(nonComplyingTax),
      taxPayable: money(taxPayable),
      account: { opening: money(year.openingBalance), taxable: money(taxableAccount), nonTaxable: money(nonTaxable), withdrawn: money(year.withdrawn), closing: money(closing) },
    });
  }
  const trusteeOverseas = sub(input.credits.overseas, passedOverseas);
  const trusteeImputation = sub(input.credits.imputation, passedImputation);
  const trusteeOther = sub(input.credits.other, passedOther);
  const anyCredits = isPositive(input.credits.overseas) || isPositive(input.credits.imputation) || isPositive(input.credits.other);
  if (anyCredits && isPositive(add(add(passedOverseas, passedImputation), passedOther))) {
    notes.push("Credits are shared in the same proportion as the income. If the trust's deed or the income's source means a beneficiary should get a different share, the figures here need changing by hand.");
  }
  if (input.trustClass === "non_complying" && isPositive(taxableDistributions)) {
    notes.push("A non-complying trust's tax loss can reduce the 45% tax on its taxable distributions. Tohyee doesn't work that out.");
  }
  if (input.trustClass === "foreign") {
    notes.push("A foreign trust's trustee income from outside New Zealand may not be taxable, and foreign trusts have their own registration and disclosure rules. Tohyee doesn't work these out: check the trustee income before filing.");
  }
  if (input.trustClass !== "complying" && isPositive(taxableDistributions)) {
    notes.push("Distributions come from beneficiary income first, then accumulated trustee income, then capital gains, then corpus. Tohyee doesn't keep those amounts, so the taxable part of each distribution is as typed.");
  }
  return {
    trustClass: input.trustClass,
    totalCredits: { overseas: money(input.credits.overseas), imputation: money(input.credits.imputation), other: money(input.credits.other) },
    passedOn: { overseas: money(passedOverseas), imputation: money(passedImputation), other: money(passedOther) },
    trusteeCredits: { overseas: money(trusteeOverseas), imputation: money(trusteeImputation), other: money(trusteeOther) },
    statements,
    beneficiaryTax: money(beneficiaryTax),
    totalDistributions: money(totalDistributions),
    taxableDistributions: money(taxableDistributions),
    notes,
  };
}

/**
 * The trustee's tax after its credits (TRU16, TRU17): overseas tax, then
 * imputation credits (an excess becomes a loss, excess ÷ the trustee rate),
 * then RWT and other credits (an excess is refunded).
 */
export function trusteeAfterCredits(input: { tax: Decimal; trusteeRate: Decimal; credits: Credits }) {
  const afterOverseas = cmp(input.credits.overseas, input.tax) > 0 ? ZERO_DECIMAL : sub(input.tax, input.credits.overseas);
  const excessImputation = cmp(input.credits.imputation, afterOverseas) > 0 ? sub(input.credits.imputation, afterOverseas) : ZERO_DECIMAL;
  const afterImputation = isPositive(excessImputation) ? ZERO_DECIMAL : sub(afterOverseas, input.credits.imputation);
  const imputationLoss = isPositive(excessImputation) && isPositive(input.trusteeRate) ? divide(excessImputation, input.trusteeRate, 2) : ZERO_DECIMAL;
  return { afterOverseas, afterImputation, excessImputation, imputationLoss, result: sub(afterImputation, input.credits.other) };
}

export type Ir6Box = { box: string; label: string; amount: string; side?: "credit" | "debit" };
export type Ir6Figures = {
  /** The form the box numbers come from (TRU26). */
  form: 2025 | 2026;
  boxes: Ir6Box[];
  beneficiaries: Array<{ beneficiaryId: string; name: string; dateOfBirth: string | null; irdNumber: string | null; tin: string | null; jurisdiction: string | null; ruleApplies: boolean; boxes: Ir6Box[] }>;
  notes: string[];
};

/** The IR6 and IR6B boxes (TRU25, TRU26): the 2026 form's numbers, or the 2025 form's (each question one higher) before that. */
export function ir6Figures(input: {
  year: number;
  trust: TrustTax;
  ret: TrustReturn;
  after: ReturnType<typeof trusteeAfterCredits>;
  rit: Decimal;
}): Ir6Figures {
  const form = input.year >= 2026 ? 2026 : 2025;
  const q = (n: number) => String(form === 2026 ? n : n + 1);
  const p = form === 2026 ? "26" : "27";
  const { trust, ret, after } = input;
  const trusteeCredits = { overseas: dec(ret.trusteeCredits.overseas), imputation: dec(ret.trusteeCredits.imputation), other: dec(ret.trusteeCredits.other) };
  const totalTax = add(dec(trust.trusteeTax), dec(trust.minorCorporateTax));
  const result = after.result;
  const boxes: Ir6Box[] = [
    { box: `${q(20)}A`, label: "Beneficiary income (excluding minor and corporate beneficiaries)", amount: trust.ordinaryBeneficiaryIncome },
    { box: `${q(20)}B`, label: "Trustee income (after expenses)", amount: trust.trusteeNetIncome },
    { box: `${q(20)}C`, label: "Minor and corporate beneficiary income", amount: trust.minorCorporateIncome },
    { box: `${q(22)}A`, label: "Losses brought forward", amount: trust.lossesBroughtForward },
    { box: `${q(22)}B`, label: "Losses claimed this year", amount: trust.lossesUsed },
  ];
  if (ret.trustClass !== "complying") {
    boxes.push(
      { box: q(23), label: "Total distributions", amount: ret.totalDistributions },
      { box: q(24), label: "Total taxable distributions", amount: ret.taxableDistributions },
    );
  }
  const z = `${p}Z`;
  const t = (n: number, letter: string) => `${form === 2026 ? n : n + 1}${letter}`;
  boxes.push(
    { box: z, label: "Tax payable for beneficiaries (from the IR6Bs)", amount: ret.beneficiaryTax },
    { box: t(27, "A"), label: "Trustee's taxable income", amount: trust.trusteeIncome },
    { box: t(27, "B"), label: `Tax on trustee income at ${percent(dec(trust.trusteeRate))}`, amount: trust.trusteeTax },
    { box: t(27, "C"), label: "Tax on minor and corporate beneficiary income at 39%", amount: trust.minorCorporateTax },
    { box: t(27, "D"), label: "Total tax payable", amount: money(totalTax) },
    { box: t(27, "E"), label: "Trustee's share of overseas tax paid", amount: money(trusteeCredits.overseas) },
    { box: t(27, "F"), label: "After overseas tax", amount: money(after.afterOverseas) },
    { box: t(27, "G"), label: "Trustee's share of imputation credits", amount: money(trusteeCredits.imputation) },
    { box: t(27, "H"), label: "After imputation credits", amount: money(after.afterImputation) },
    { box: t(27, "I"), label: "Trustee's share of RWT and other tax credits", amount: money(trusteeCredits.other) },
    { box: t(27, "J"), label: "Tax on trustee income", amount: money(absolute(result)), side: isNegative(result) ? "credit" : "debit" },
    { box: t(28, "A"), label: "Tax payable for beneficiaries", amount: ret.beneficiaryTax },
    { box: t(28, "B"), label: "Tax on trustee income", amount: money(absolute(result)), side: isNegative(result) ? "credit" : "debit" },
    { box: t(28, "C"), label: "Residual income tax", amount: money(absolute(input.rit)), side: isNegative(input.rit) ? "credit" : "debit" },
  );
  const beneficiaries = ret.statements.map((s) => {
    const list: Ir6Box[] = [{ box: `${p}I`, label: "Taxable income", amount: s.taxableIncome }];
    if (s.foreignTaxableDistribution !== "0.00") list.push({ box: `${p}H`, label: "Other income: taxable distribution from the foreign trust", amount: s.foreignTaxableDistribution });
    if (s.nonComplyingDistribution !== "0.00") list.push({ box: `${p}K`, label: "Taxable distribution by non-complying trust", amount: s.nonComplyingDistribution });
    if (s.tax) {
      list.push(
        { box: `${p}L`, label: "Tax on taxable income", amount: s.tax.taxOnIncome },
        { box: `${p}M`, label: "Overseas tax paid", amount: s.overseasTax },
        { box: `${p}N`, label: "After overseas tax", amount: s.tax.afterOverseas },
        { box: `${p}O`, label: "Imputation credits", amount: s.imputationCredits },
        { box: `${p}P`, label: "After imputation credits", amount: s.tax.afterImputation },
        { box: `${p}Q`, label: "RWT and other tax credits", amount: s.otherCredits },
        { box: `${p}R`, label: "After RWT and other credits", amount: s.tax.afterOther },
      );
    } else if (!s.taxedByTrustee) {
      list.push(
        { box: `${p}M`, label: "Overseas tax paid", amount: s.overseasTax },
        { box: `${p}O`, label: "Imputation credits", amount: s.imputationCredits },
        { box: `${p}Q`, label: "RWT and other tax credits", amount: s.otherCredits },
      );
    }
    list.push(
      { box: `${p}S`, label: "Tax on the non-complying trust distribution at 45%", amount: s.nonComplyingTax },
      { box: `${p}T`, label: "Tax payable by the trustee for this beneficiary", amount: s.taxPayable },
      { box: `${p}U`, label: "Current account: opening balance", amount: s.account.opening },
      { box: `${p}V`, label: "Distributions that are taxable", amount: s.account.taxable },
      { box: `${p}W`, label: "Distributions that are not taxable", amount: s.account.nonTaxable },
      { box: `${p}X`, label: "Withdrawn during the year", amount: s.account.withdrawn },
      { box: `${p}Y`, label: "Current account: closing balance", amount: s.account.closing },
    );
    return { beneficiaryId: s.beneficiaryId, name: s.name, dateOfBirth: s.dateOfBirth, irdNumber: s.irdNumber, tin: s.tin, jurisdiction: s.jurisdiction, ruleApplies: s.taxedByTrustee, boxes: list };
  });
  const notes: string[] = [];
  if (input.year < 2025) notes.push("The box numbers are the 2025 IR6's. Check them against this year's form.");
  notes.push(`Tohyee puts the trust's income after expenses in box ${q(20)}B, with nothing in box ${q(21)}. Split each beneficiary's income between interest, dividends, Māori authority distributions, overseas and other income on the IR6B in the same shares as the trust's income.`);
  return { form, boxes, beneficiaries, notes };
}

function absolute(value: Decimal): Decimal {
  return isNegative(value) ? sub(ZERO_DECIMAL, value) : value;
}

function percent(rate: Decimal): string {
  return `${toFixedString(mul(rate, dec("100")), 0)}%`;
}

function money(value: Decimal): string {
  const rounded = roundHalfUp(value, 2);
  return toFixedString(isZero(rounded) ? ZERO_DECIMAL : rounded, 2);
}
