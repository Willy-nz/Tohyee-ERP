import { describe, expect, it } from "vitest";
import { directoryPage, EMPTY_DIRECTORY } from "@/lib/organisations/directory";
import { formatIrdNumber, incomeTaxTaxpayerFor, parseIrdNumber } from "@/lib/organisations/entity-types";

describe("business structure (ENT1-ENT8)", () => {
  it("ENT2: keeps an IRD number as 9 digits when it passes Inland Revenue's check digit", () => {
    // Examples published with the check digit algorithm.
    expect(parseIrdNumber("49-091-850")).toBe("049091850");
    expect(parseIrdNumber("49098576")).toBe("049098576");
    expect(parseIrdNumber("")).toBeNull();
    expect(parseIrdNumber(null)).toBeNull();
    expect(formatIrdNumber("049091850")).toBe("49-091-850");
  });

  it("ENT2: refuses a mistyped IRD number", () => {
    expect(() => parseIrdNumber("49-091-851")).toThrow("That IRD number doesn't pass Inland Revenue's check. Check the digits.");
    expect(() => parseIrdNumber("1234567")).toThrow("An IRD number has 8 or 9 digits");
    expect(() => parseIrdNumber("12a-456-789")).toThrow("An IRD number has 8 or 9 digits");
  });

  it("ENT3: income tax is worked out for companies and sole traders only", () => {
    expect(incomeTaxTaxpayerFor("company")).toEqual({ taxpayerType: "company" });
    expect(incomeTaxTaxpayerFor("sole_trader")).toEqual({ taxpayerType: "individual" });
    for (const type of ["partnership", "look_through_company", "trust", "incorporated_society"] as const) {
      expect(incomeTaxTaxpayerFor(type)).toHaveProperty("unsupported");
    }
  });

  it("ENT7: the directory page shows the entity type and IRD number", () => {
    const page = directoryPage(
      { displayName: "Made-up Ltd", postalAddress: null, gstNumber: null, financialYearEndMonth: 3, entityType: "company", irdNumber: "049091850" },
      EMPTY_DIRECTORY,
    );
    expect(page.sections[0].lines).toEqual([
      { label: "Entity type", value: "Company" },
      { label: "IRD number", value: "49-091-850" },
      { label: "Balance date", value: "31 March" },
    ]);
  });
});
