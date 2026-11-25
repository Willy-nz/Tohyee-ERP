import { describe, expect, it } from "vitest";
import { logTreatmentPayload } from "@/lib/farming/log-treatment";

const answers = { day: "2026-11-05", product: "Oral drench", chemicalRecordId: "3f1d2c4b-5a6e-4f70-8a9b-0c1d2e3f4a5b", dose: " 20 mL a head ", quantity: "4", unit: "L", givenTime: "7:30", meat: "14", milk: "", givenBy: "Sam" };

describe("a treatment from Log (OPF4)", () => {
  it("names the cabinet's product, the quantity in its unit and the time given, as Mobs' treat flow does", () => {
    expect(logTreatmentPayload("12", 200, answers)).toEqual({
      mobId: "12",
      head: 200,
      treatedOn: "2026-11-05",
      product: "Oral drench",
      chemicalRecordId: "3f1d2c4b-5a6e-4f70-8a9b-0c1d2e3f4a5b",
      dose: "20 mL a head",
      quantity: "4",
      quantityUnit: "L",
      givenTime: "07:30",
      meatWithholdingDays: 14,
      milkWithholdingHours: null,
      givenBy: "Sam",
    });
  });

  it("sends no quantity unit without a quantity, and no time when none was given", () => {
    const payload = logTreatmentPayload("12", 200, { ...answers, quantity: "", givenTime: "", chemicalRecordId: null });
    expect(payload).toMatchObject({ quantity: null, quantityUnit: null, givenTime: null, chemicalRecordId: null });
  });
});
