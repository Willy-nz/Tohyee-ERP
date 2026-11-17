"use client";

import { useSaveReport } from "@/components/reports/save-report";
import { todayInBrowser } from "@/lib/format";
import { CUSTOM_REPORT_BASES, type TransactionReportBase, type TransactionReportFilters, TRANSACTION_REPORT_DEFAULT_COLUMNS } from "@/lib/reports/custom-layout";
import { statementAsAt, statementPeriod } from "@/lib/reports/report-dates";

/** The period line for a transaction report's filters, for the title Save as draft and Publish suggest. */
function filtersPeriod(filters: TransactionReportFilters): string {
  if ("asAt" in filters) return statementAsAt(filters.asAt ?? todayInBrowser());
  if (filters.from && filters.to) return statementPeriod(filters.from, filters.to);
  return "";
}

/**
 * Save as draft and Publish for a transaction report (CR25): a custom
 * report with these filters, saved without opening the editor. `items` go
 * in the "⋯" menu or `buttons` beside it; render `panel`
 * once. Nothing for people who can't make reports.
 */
export function useSaveAsCustomReport(organisationId: string, base: TransactionReportBase, filters: TransactionReportFilters) {
  return useSaveReport(organisationId, CUSTOM_REPORT_BASES[base], filtersPeriod(filters), () => ({
    base,
    periodEnd: filters.asAt ?? filters.to ?? todayInBrowser(),
    layout: { title: CUSTOM_REPORT_BASES[base], filters, columns: TRANSACTION_REPORT_DEFAULT_COLUMNS[base] },
  }));
}

export function SaveAsCustomReportButton({
  organisationId,
  base,
  filters,
}: {
  organisationId: string;
  base: TransactionReportBase;
  filters: TransactionReportFilters;
}) {
  const save = useSaveAsCustomReport(organisationId, base, filters);
  if (!save.allowed) return null;
  return (
    <>
      {save.buttons}
      {save.panel}
    </>
  );
}
