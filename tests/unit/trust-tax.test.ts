import { describe, expect, it } from "vitest";
import { dec, toPlainString } from "@/lib/money/decimal";
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
