import { describe, expect, it } from "vitest";
import { dec, toPlainString } from "@/lib/money/decimal";
import { trusteeAfterCredits } from "@/lib/tax/income/trust-return";
import { type Beneficiary, trustTax, trusteeRate } from "@/lib/tax/income/trusts";

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
const company = (id: string, name: string, corporateRule = true): Beneficiary => ({ id, name, kind: "company", dateOfBirth: null, settledByRelative: false, disabilityAllowance: false, corporateRule });
const base = { kind: "family" as const, dateOfDeath: null, year: 2026, endMonth: 3, yearEnd: "2026-03-31", lossesBroughtForward: dec("0") };

describe("trust tax (TRU4-TRU11)", () => {
  it("TRU4: 33% when the trustee's net income is $10,000 or less, 39% on all of it above", () => {
    const low = trustTax({ ...base, netIncome: dec("9800"), allocations: [] });
    expect(low).toMatchObject({ trusteeRate: "0.33", trusteeTax: "3234.00" });
    const high = trustTax({ ...base, netIncome: dec("10001"), allocations: [] });
    expect(high).toMatchObject({ trusteeRate: "0.39", trusteeTax: "3900.39" });
  });

  it("TRU5, TRU6: estates at 33% for the year of death and three after; disabled beneficiary trusts at 33%", () => {
    const estate = (year: number) => trusteeRate({ kind: "deceased_estate", year, endMonth: 3, dateOfDeath: "2023-12-30", trusteeNetIncome: dec("50000") });
    expect([2025, 2026, 2027, 2028].map((year) => toPlainString(estate(year).rate))).toEqual(["0.33", "0.33", "0.33", "0.39"]);
    expect(toPlainString(trusteeRate({ kind: "disabled_beneficiary", year: 2026, endMonth: 3, dateOfDeath: null, trusteeNetIncome: dec("90000") }).rate)).toBe("0.33");
  });

  it("TXF1: an estate with a 31 October balance date counts the year of death as IRD numbers it", () => {
    // Death 15 May 2025 is in the year to 31 October 2025: the 2026 income year. 33% for 2026 to 2029.
    const estate = (year: number, endMonth: number) => trusteeRate({ kind: "deceased_estate", year, endMonth, dateOfDeath: "2025-05-15", trusteeNetIncome: dec("50000") });
    expect([2026, 2027, 2028, 2029, 2030].map((year) => toPlainString(estate(year, 10).rate))).toEqual(["0.33", "0.33", "0.33", "0.33", "0.39"]);
    expect(estate(2029, 10).reason).toContain("(2026)");
    expect(trustTax({ ...base, kind: "deceased_estate", dateOfDeath: "2025-05-15", year: 2029, endMonth: 10, yearEnd: "2028-10-31", netIncome: dec("50000"), allocations: [] }).trusteeTax).toBe("16500.00");
    // A December death with a 31 October balance date is in the next year: year to 31 October 2026, the 2027 income year.
    const december = (year: number) => trusteeRate({ kind: "deceased_estate", year, endMonth: 10, dateOfDeath: "2025-12-10", trusteeNetIncome: dec("50000") });
    expect([2030, 2031].map((year) => toPlainString(december(year).rate))).toEqual(["0.33", "0.39"]);
    // A late balance date (30 June) was already right: May 2025 is the 2025 income year, so 2028 is the last 33% year.
    expect([2028, 2029].map((year) => toPlainString(estate(year, 6).rate))).toEqual(["0.33", "0.39"]);
  });

  it("TXF12, TXF13: a lines trust at 33% and a legacy superannuation fund at 28%, whatever the income", () => {
    const lines = trustTax({ ...base, kind: "lines_trust", year: 2027, yearEnd: "2027-03-31", netIncome: dec("50000"), allocations: [] });
    expect(lines).toMatchObject({ trusteeRate: "0.33", trusteeTax: "16500.00" });
    expect(lines.trusteeRateReason).toContain("lines trust");
    const legacy = trustTax({ ...base, kind: "legacy_superannuation", year: 2027, yearEnd: "2027-03-31", netIncome: dec("50000"), allocations: [] });
    expect(legacy).toMatchObject({ trusteeRate: "0.28", trusteeTax: "14000.00" });
    expect(legacy.notes.join(" ")).toContain("IR44");
    // 28% under $10,000 too (clause 6), not the 33% rule.
    expect(trustTax({ ...base, kind: "legacy_superannuation", netIncome: dec("9000"), allocations: [] }).trusteeRate).toBe("0.28");
    // Excess imputation credits become a loss at the trust's own rate (IR6 guide Q27G).
    const credits = { overseas: dec("0"), imputation: dec("330"), other: dec("0") };
    expect(toPlainString(trusteeAfterCredits({ tax: dec("0"), trusteeRate: dec("0.33"), credits }).imputationLoss)).toBe("1000");
    expect(toPlainString(trusteeAfterCredits({ tax: dec("0"), trusteeRate: dec("0.28"), credits: { ...credits, imputation: dec("280") } }).imputationLoss)).toBe("1000");
    // The minor beneficiary rule still applies to a lines trust.
    const child = person("1", "Nikau", "2016-08-01");
    expect(trustTax({ ...base, kind: "lines_trust", netIncome: dec("5000"), allocations: [{ beneficiary: child, amount: dec("3000") }] }).minorCorporateIncome).toBe("3000.00");
  });

  it("TXF7: income from a Māori authority distribution isn't caught by the minor beneficiary rule", () => {
    const nikau = person("1", "Nikau", "2016-08-01");
    const caught = trustTax({ ...base, netIncome: dec("5000"), allocations: [{ beneficiary: nikau, amount: dec("3000") }] });
    expect(caught.minorCorporateIncome).toBe("3000.00");
    const excluded = trustTax({ ...base, netIncome: dec("5000"), allocations: [{ beneficiary: nikau, amount: dec("3000"), fromMaoriAuthority: true }] });
    expect(excluded).toMatchObject({ minorCorporateIncome: "0.00", ordinaryBeneficiaryIncome: "3000.00" });
    expect(excluded.lines[0].reason).toContain("Māori authority");
  });

  it("TRU9: the worked example", () => {
    const result = trustTax({
      ...base,
      netIncome: dec("60000"),
      allocations: [
        { beneficiary: person("1", "Aroha", "1990-05-01"), amount: dec("20000") },
        { beneficiary: person("2", "Nikau", "2016-08-01"), amount: dec("3000") },
        { beneficiary: person("3", "Tama", "2013-06-01"), amount: dec("800") },
        { beneficiary: company("4", "Tōtara Holdings Ltd"), amount: dec("10000") },
      ],
    });
    expect(result).toMatchObject({
      ordinaryBeneficiaryIncome: "20800.00",
      minorCorporateIncome: "13000.00",
      minorCorporateTax: "5070.00",
      trusteeIncome: "26200.00",
      trusteeRate: "0.39",
      trusteeTax: "10218.00",
      tax: "15288.00",
    });
    expect(result.lines.map((line) => line.taxedByTrustee)).toEqual([false, true, false, true]);
  });

  it("TRU7: the minor beneficiary rule's exceptions", () => {
    const child = (extra: Partial<Beneficiary>) => [{ beneficiary: person("1", "Nikau", "2016-08-01", extra), amount: dec("3000") }];
    expect(trustTax({ ...base, netIncome: dec("5000"), allocations: child({ settledByRelative: false }) }).minorCorporateIncome).toBe("0.00");
    expect(trustTax({ ...base, netIncome: dec("5000"), allocations: child({ disabilityAllowance: true }) }).minorCorporateIncome).toBe("0.00");
    expect(trustTax({ ...base, kind: "disabled_beneficiary", netIncome: dec("5000"), allocations: child({}) }).minorCorporateIncome).toBe("0.00");
    expect(trustTax({ ...base, kind: "deceased_estate", dateOfDeath: "2025-01-01", netIncome: dec("5000"), allocations: child({}) }).minorCorporateIncome).toBe("0.00");
    // 16 by the end of the income year: not a minor.
    expect(trustTax({ ...base, netIncome: dec("5000"), allocations: [{ beneficiary: person("1", "Mere", "2010-03-31"), amount: dec("3000") }] }).minorCorporateIncome).toBe("0.00");
    const unknown = trustTax({ ...base, netIncome: dec("5000"), allocations: [{ beneficiary: person("1", "Rua", null), amount: dec("3000") }] });
    expect(unknown.minorCorporateIncome).toBe("0.00");
    expect(unknown.notes).toContain("Rua has no date of birth, so they're treated as 16 or older.");
    expect(trustTax({ ...base, netIncome: dec("15000"), allocations: [{ beneficiary: company("4", "Other Ltd", false), amount: dec("5000") }] }).minorCorporateIncome).toBe("0.00");
  });

  it("TRU10: losses come off trustee income only; the $10,000 test is before them", () => {
    const result = trustTax({ ...base, netIncome: dec("30000"), lossesBroughtForward: dec("25000"), allocations: [{ beneficiary: person("1", "Aroha", "1990-05-01"), amount: dec("15000") }] });
    expect(result).toMatchObject({ trusteeNetIncome: "15000.00", lossesUsed: "15000.00", lossCarriedForward: "10000.00", trusteeIncome: "0.00", trusteeRate: "0.39", tax: "0.00" });
    const loss = trustTax({ ...base, netIncome: dec("-4000"), lossesBroughtForward: dec("1000"), allocations: [] });
    expect(loss).toMatchObject({ trusteeIncome: "0.00", lossCarriedForward: "5000.00" });
  });

  it("TRU11: more beneficiary income than net income is flagged and trustee income is nil", () => {
    const result = trustTax({ ...base, netIncome: dec("8000"), allocations: [{ beneficiary: person("1", "Aroha", "1990-05-01"), amount: dec("9000") }] });
    expect(result.trusteeIncome).toBe("0.00");
    expect(result.notes[0]).toContain("is more than the year's net income");
  });
});
