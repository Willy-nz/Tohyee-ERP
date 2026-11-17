"use client";

import { type AllocationStatus } from "@/lib/tax/income/rules";
import type { IncomeTaxReport } from "@/lib/tax/income/service";

/**
 * Income tax, stage 1 (examples ITX1-ITX10): taxable income
 * from the books and the overall budget, standard provisional tax,
 * end-of-year tax and due dates, with IRD's figures typed in. Owners and
 * admins only. Nothing here posts, files, pays or elects anything.
 */

/** "-140.00" for "140.00"; nothing stays "0.00". */
export function negated(value: string): string {
  if (/^-?0*(\.0*)?$/.test(value)) return value.replace(/^-/, "");
  return value.startsWith("-") ? value.slice(1) : `-${value}`;
}

export type Status = { tone: "success" | "error"; text: string } | null;
export type Supported = Extract<IncomeTaxReport, { supported: true }>;

export const STATUS_TONES: Record<AllocationStatus, "green" | "blue" | "amber"> = { confirmed: "green", evidenced: "blue", forecast: "amber" };

export type TaxView = "overview" | "forecast" | "calculation" | "payments" | "returns" | "settings";

/** The workspace's pages: each its own address under /operations/income-tax. */
export const TAX_VIEWS: ReadonlyArray<readonly [TaxView, string]> = [
  ["overview", "Overview"],
  ["forecast", "Forecast"],
  ["calculation", "Tax calculation"],
  ["payments", "Payments"],
  ["returns", "Returns"],
  ["settings", "Tax settings"],
];

export function viewHref(view: TaxView, incomeYear: number | null): string {
  return `/operations/income-tax${view === "overview" ? "" : `/${view}`}${incomeYear ? `?incomeYear=${incomeYear}` : ""}`;
}
