import { apiDownload } from "@/lib/client/api";
import type { SpreadKind, SpreadMethod } from "@/lib/spreading/rules";

/** Bits the Spreading worksheet's files share. */

export const KIND_HELP: Record<SpreadKind, { what: string; code: string; example: string; arrived: string }> = {
  prepayment: {
    what: "A cost you've paid for ahead, like a year's insurance.",
    code: "Press Spread this on the bill, or code the bill to",
    example: "Insurance to June",
    arrived: "",
  },
  income_in_advance: {
    what: "Money you've invoiced or been paid before doing the work.",
    code: "Press Spread this on the invoice, or code the invoice to",
    example: "Year's subscription",
    arrived: "",
  },
  accrued_expense: {
    what: "A cost you've used but haven't had the bill for yet, like rates.",
    code: "When the bill comes, code it to",
    example: "Rates, July to September",
    arrived: "Bill arrived",
  },
  accrued_income: {
    what: "Work you've done but haven't invoiced yet.",
    code: "When you invoice it, code the invoice to",
    example: "Fencing job",
    arrived: "Invoice sent",
  },
};

export const METHOD_CHOICES: Array<{ value: SpreadMethod; label: string }> = [
  { value: "by_month", label: "Evenly by month" },
  { value: "by_days", label: "By days" },
  { value: "one_month", label: "All in one month" },
  { value: "own_amounts", label: "My own amounts" },
  { value: "when_done", label: "When it's done" },
];

/** Fetches a CSV file from the export route and hands it to the browser to save. */
export async function downloadFile(organisationId: string, body: Record<string, unknown>, fileName: string): Promise<void> {
  const blob = await apiDownload("/api/spreading/export", { organisationId, ...body });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function isAccrual(kind: SpreadKind): boolean {
  return kind === "accrued_expense" || kind === "accrued_income";
}

export type Send = (method: "POST" | "PUT" | "DELETE", path: string, body: Record<string, unknown> | null, text: string) => Promise<boolean>;
