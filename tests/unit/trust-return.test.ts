import { describe, expect, it } from "vitest";
import { dec, type Decimal, isPositive, ZERO_DECIMAL } from "@/lib/money/decimal";
import { workpaper } from "@/lib/tax/income/rules";
import { type BeneficiaryYear, ir6Figures, type TrustClass, trusteeAfterCredits } from "@/lib/tax/income/trust-return";
import type { Beneficiary } from "@/lib/tax/income/trusts";

const person = (id: string, name: string, dateOfBirth: string | null, extra: Partial<Beneficiary> = {}): Beneficiary => ({
  id,
  name,
  kind: "person",
  dateOfBirth,
  settledByRelative: true,
  disabilityAllowance: false,
  corporateRule: false,
  ...extra,
});
const company = (id: string, name: string): Beneficiary => ({ id, name, kind: "company", dateOfBirth: null, settledByRelative: false, disabilityAllowance: false, corporateRule: true });

function year(beneficiary: Beneficiary, amount: string, extra: Partial<BeneficiaryYear> = {}): BeneficiaryYear {
  return {
    beneficiary: { ...beneficiary, irdNumber: "049091850", jurisdiction: null, tin: null },
    amount: dec(amount),
    trusteePaysTax: false,
    otherIncome: ZERO_DECIMAL,
    taxableDistribution: ZERO_DECIMAL,
    nonTaxableDistribution: ZERO_DECIMAL,
    withdrawn: ZERO_DECIMAL,
    openingBalance: ZERO_DECIMAL,
    ...extra,
  };
}

const aroha = person("1", "Aroha", "1990-05-01");
const nikau = person("2", "Nikau", "2016-08-01");
const tama = person("3", "Tama", "2013-06-01");
const holdings = company("4", "Tōtara Holdings Ltd");

function paper(input: { netIncome: string; years: BeneficiaryYear[]; credits?: { overseas: string; imputation: string; other: string }; trustClass?: TrustClass; yearNumber?: number; losses?: Decimal }) {
  const yearNumber = input.yearNumber ?? 2026;
  return workpaper({
    type: "trust",
    year: yearNumber,
    accounts: [{ accountId: "1", code: "4000", name: "Income", side: "income", amount: dec(input.netIncome), treatment: "full", businessUsePercent: null }],
    typedAdjustments: [],
    otherIncome: ZERO_DECIMAL,
    lossesBroughtForward: input.losses ?? ZERO_DECIMAL,
    taxCredits: dec(input.credits?.other ?? "0"),
    imputationCredits: dec(input.credits?.imputation ?? "0"),
    overseasTaxPaid: dec(input.credits?.overseas ?? "0"),
    trust: {
      kind: "family",
      dateOfDeath: null,
      endMonth: 3,
      yearEnd: `${yearNumber}-03-31`,
      allocations: input.years.filter((entry) => isPositive(entry.amount)).map((entry) => ({ beneficiary: entry.beneficiary, amount: entry.amount })),
      trustClass: input.trustClass ?? "complying",
      years: input.years,
    },
  });
}

const totara = [year(aroha, "20000"), year(nikau, "3000"), year(tama, "800"), year(holdings, "10000")];
const credits = { overseas: "300", imputation: "1200", other: "600" };

function boxes(result: ReturnType<typeof paper>, yearNumber = 2026) {
  const figures = ir6Figures({
    year: yearNumber,
    trust: result.trust!,
    ret: result.trustReturn!,
    after: trusteeAfterCredits({
      tax: dec(result.tax),
      trusteeRate: dec(result.trust!.trusteeRate),
      credits: { overseas: dec(result.trustReturn!.trusteeCredits.overseas), imputation: dec(result.trustReturn!.trusteeCredits.imputation), other: dec(result.trustReturn!.trusteeCredits.other) },
    }),
    rit: dec(result.taxToPay),
  });
  return { figures, map: Object.fromEntries(figures.boxes.map((box) => [box.box, box.amount])) };
}

describe("a trust's return (TRU15-TRU27)", () => {
  it("TRU15: credits are shared in proportion to the income; the minor and corporate shares stay with the trustee", () => {
    const result = paper({ netIncome: "60000", years: totara, credits });
    expect(result.trustReturn!.passedOn).toEqual({ overseas: "104.00", imputation: "416.00", other: "208.00" });
    expect(result.trustReturn!.trusteeCredits).toEqual({ overseas: "196.00", imputation: "784.00", other: "392.00" });
    const aro = result.trustReturn!.statements[0];
    expect(aro).toMatchObject({ overseasTax: "100.00", imputationCredits: "400.00", otherCredits: "200.00", taxPayable: "0.00", tax: null });
    expect(result.taxToPay).toBe("13916.00");
    expect(result.rit).toBe("13916.00");
  });

  it("TRU15, TRU26: the 2026 IR6 boxes", () => {
    const { map } = boxes(paper({ netIncome: "60000", years: totara, credits }));
    expect(map).toMatchObject({
      "20A": "20800.00",
      "20B": "26200.00",
      "20C": "13000.00",
      "26Z": "0.00",
      "27A": "26200.00",
      "27B": "10218.00",
      "27C": "5070.00",
      "27D": "15288.00",
      "27E": "196.00",
      "27F": "15092.00",
      "27G": "784.00",
      "27H": "14308.00",
      "27I": "392.00",
      "27J": "13916.00",
      "28A": "0.00",
      "28B": "13916.00",
      "28C": "13916.00",
    });
    expect(map["23"]).toBeUndefined();
  });

  it("TRU26: the 2025 IR6's boxes are one question higher", () => {
    const { figures, map } = boxes(paper({ netIncome: "60000", years: totara, credits, yearNumber: 2025 }), 2025);
    expect(figures.form).toBe(2025);
    expect(map).toMatchObject({ "21A": "20800.00", "21C": "13000.00", "27Z": "0.00", "28C": "5070.00", "28J": "13916.00", "29C": "13916.00" });
    expect(figures.beneficiaries[0].boxes[0]).toEqual({ box: "27I", label: "Taxable income", amount: "20000.00" });
  });

  it("TRU16: the trustee's excess imputation credits become a loss, excess ÷ the trustee rate", () => {
    const result = paper({ netIncome: "2000", years: [], credits: { overseas: "0", imputation: "900", other: "0" } });
    expect(result.trust!.trusteeTax).toBe("660.00");
    expect(result.excessImputationCredits).toBe("240.00");
    expect(result.imputationLoss).toBe("727.27");
    expect(result.lossCarriedForward).toBe("727.27");
    expect(result.taxToPay).toBe("0.00");
  });

  it("TRU17: the trustee's RWT and other credits beyond its tax are refunded", () => {
    const result = paper({ netIncome: "2000", years: [], credits: { overseas: "0", imputation: "0", other: "900" } });
    expect(result.taxToPay).toBe("-240.00");
    const { map } = boxes(result);
    const j = boxes(result).figures.boxes.find((box) => box.box === "27J");
    expect(map["27J"]).toBe("240.00");
    expect(j?.side).toBe("credit");
  });

  it("TRU18: the trust pays a beneficiary's tax: their share of tax on all their income, less their credits", () => {
    const years = [year(aroha, "20000", { trusteePaysTax: true, otherIncome: dec("50000") }), year(nikau, "3000"), year(tama, "800"), year(holdings, "10000")];
    const result = paper({ netIncome: "60000", years, credits });
    const aro = result.trustReturn!.statements[0];
    expect(aro.tax).toEqual({ taxOnIncome: "3777.29", afterOverseas: "3677.29", afterImputation: "3277.29", afterOther: "3077.29" });
    expect(aro.taxPayable).toBe("3077.29");
    expect(result.trustReturn!.beneficiaryTax).toBe("3077.29");
    expect(result.taxToPay).toBe("16993.29");
    const { map, figures } = boxes(result);
    expect(map).toMatchObject({ "26Z": "3077.29", "28A": "3077.29", "28B": "13916.00", "28C": "16993.29" });
    expect(figures.beneficiaries[0].boxes.map((box) => box.box)).toEqual(["26I", "26L", "26M", "26N", "26O", "26P", "26Q", "26R", "26S", "26T", "26U", "26V", "26W", "26X", "26Y"]);
  });

  it("TRU18: the trustee doesn't pay tax for a minor beneficiary taxed under the rule", () => {
    const result = paper({ netIncome: "60000", years: [year(nikau, "3000", { trusteePaysTax: true })] });
    expect(result.trustReturn!.statements[0]).toMatchObject({ tax: null, taxPayable: "0.00" });
    expect(result.trustReturn!.notes.join(" ")).toContain("doesn't pay tax for them as well");
  });

  it("TRU21: a complying trust's taxable distribution is left out", () => {
    const result = paper({ netIncome: "60000", years: [year(aroha, "20000", { taxableDistribution: dec("5000") })] });
    expect(result.trustReturn!.taxableDistributions).toBe("0.00");
    expect(result.trustReturn!.notes.join(" ")).toContain("aren't taxable");
  });

  it("TRU22: a non-complying trust's taxable distribution is taxed at 45%, paid by the trustee", () => {
    const result = paper({ netIncome: "60000", years: [year(aroha, "0", { taxableDistribution: dec("10000"), nonTaxableDistribution: dec("4000") })], trustClass: "non_complying" });
    const aro = result.trustReturn!.statements[0];
    expect(aro).toMatchObject({ nonComplyingDistribution: "10000.00", nonComplyingTax: "4500.00", taxPayable: "4500.00", taxableIncome: "0.00" });
    const { map, figures } = boxes(result);
    expect(map).toMatchObject({ "23": "14000.00", "24": "10000.00", "26Z": "4500.00" });
    expect(figures.beneficiaries[0].boxes.find((box) => box.box === "26K")?.amount).toBe("10000.00");
  });

  it("TRU23: a foreign trust's taxable distribution is the beneficiary's other income", () => {
    const result = paper({ netIncome: "60000", years: [year(aroha, "0", { taxableDistribution: dec("8000") })], trustClass: "foreign" });
    const aro = result.trustReturn!.statements[0];
    expect(aro).toMatchObject({ foreignTaxableDistribution: "8000.00", taxableIncome: "8000.00", nonComplyingTax: "0.00", taxPayable: "0.00" });
    expect(boxes(result).figures.beneficiaries[0].boxes.find((box) => box.box === "26H")?.amount).toBe("8000.00");
  });

  it("TRU24: the current account", () => {
    const result = paper({ netIncome: "60000", years: [year(aroha, "20000", { openingBalance: dec("1500"), nonTaxableDistribution: dec("2500"), withdrawn: dec("18000") })] });
    expect(result.trustReturn!.statements[0].account).toEqual({ opening: "1500.00", taxable: "20000.00", nonTaxable: "2500.00", withdrawn: "18000.00", closing: "6000.00" });
  });

  it("TRU25: a beneficiary with a distribution and no IRD number is flagged", () => {
    const entry = year(aroha, "20000");
    entry.beneficiary.irdNumber = null;
    expect(paper({ netIncome: "60000", years: [entry] }).trustReturn!.notes.join(" ")).toContain("Aroha has no IRD number");
  });
});
