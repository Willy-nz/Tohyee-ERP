import { parseTimeGiven } from "@/lib/farming/treatment-rules";

/*
 * What Log sends for a treatment (OPF4): the same fields as Mobs' treat flow,
 * so a product picked from the cabinet comes off its stock and milk
 * withholding counts from the time given. Browser-safe, no imports beyond
 * the rules.
 */

export type LogTreatmentAnswers = {
  day: string;
  product: string;
  chemicalRecordId: string | null;
  dose: string;
  quantity: string;
  unit: string;
  givenTime: string;
  meat: string;
  milk: string;
  givenBy: string;
};

export function logTreatmentPayload(mobId: string, head: number | null, answers: LogTreatmentAnswers): Record<string, unknown> {
  const quantity = answers.quantity.trim();
  return {
    mobId,
    head,
    treatedOn: answers.day,
    product: answers.product.trim(),
    chemicalRecordId: answers.chemicalRecordId,
    dose: answers.dose.trim(),
    quantity: quantity || null,
    quantityUnit: quantity ? answers.unit : null,
    givenTime: parseTimeGiven(answers.givenTime) ?? null,
    meatWithholdingDays: answers.meat === "" ? null : Number(answers.meat),
    milkWithholdingHours: answers.milk === "" ? null : Number(answers.milk),
    givenBy: answers.givenBy.trim(),
  };
}
