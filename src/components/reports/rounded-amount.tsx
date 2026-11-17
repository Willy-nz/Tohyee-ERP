"use client";

import { createContext, useContext } from "react";
import { Field } from "@/components/ui";
import { isReportRounding, REPORT_ROUNDINGS, type ReportRounding, roundingCaption } from "@/lib/reports/rounding";
import { statementAmount, statementAmountIn } from "@/lib/reports/statement-format";

/** How the statement around an amount is rounded (RND1, RND6): amounts show in those units, with no cents. */
export const ReportRoundingContext = createContext<ReportRounding | undefined>(undefined);

/** A statement's amount: to the cent as statements show it, or in the statement's rounded units (a minus in brackets, nothing as a dash). */
export function StatementAmount({ value }: { value: string | null | undefined }) {
  const rounding = useContext(ReportRoundingContext);
  if (value == null) return <></>;
  return <>{rounding ? statementAmountIn(value, rounding) : statementAmount(value)}</>;
}

/** The line above a rounded statement saying what its figures are in. */
export function RoundingCaption({ rounding, currencyCode, className }: { rounding: ReportRounding | undefined; currencyCode: string; className?: string }) {
  return rounding ? <p className={className}>{roundingCaption(rounding, currencyCode)}</p> : null;
}

/** The Rounding choice in a layout's columns. */
export function RoundingField({ value, onChange }: { value: ReportRounding | undefined; onChange: (next: ReportRounding | undefined) => void }) {
  return (
    <Field label="Rounding" hint="Rounded reports always add up: each line is rounded and every total is added from the rounded lines.">
      <select value={value ?? "none"} onChange={(event) => onChange(isReportRounding(event.target.value) ? event.target.value : undefined)}>
        <option value="none">To the cent</option>
        {Object.entries(REPORT_ROUNDINGS).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
    </Field>
  );
}
