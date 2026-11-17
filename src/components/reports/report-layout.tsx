"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApiData } from "@/components/hooks";
import type { MoreMenuItem } from "@/components/more-menu";
import { Button } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { SaveReportRequest } from "@/components/reports/save-report";
import type { TrackingChoice } from "@/components/reports/statement-table";
import { type CustomReportLayout, type EditLayoutColumns, editLayoutColumns, type LayoutBase, lastDayOfMonth, type PeriodLength, standardLayout } from "@/lib/reports/custom-layout";

/** The report on screen, so Edit layout starts from the same dates and comparisons. */
export type ShownReport = { from: string | null; to: string; compare: number; compareBy: PeriodLength; ytd?: boolean };

/**
 * The standard profit and loss or balance sheet's default layout (decision
 * 1359): whether it has one, "Edit layout" (opens it, or starts one from the
 * standard rows), and switching between it and the standard layout.
 */
export function useReportLayout(organisationId: string, base: LayoutBase) {
  const router = useRouter();
  const { can } = useWorkspace();
  const defaults = useApiData<{
    defaults: Array<{ base: string; reportId: string; title: string }>;
  }>("/api/report-layouts", { organisationId });
  const chosen = defaults.data?.defaults.find((entry) => entry.base === base) ?? null;
  const [standard, setStandard] = useState(false);
  const [key] = useState(() => newIdempotencyKey("edit-layout"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function edit(shown: ShownReport | string) {
    if (chosen) return router.push(`/operations/reports/custom/${chosen.reportId}`);
    setError(null);
    let columns: EditLayoutColumns | undefined;
    let periodEnd = typeof shown === "string" ? shown : shown.to;
    if (typeof shown !== "string" && (base === "profit_and_loss" || base === "balance_sheet")) {
      const result = editLayoutColumns(base, shown);
      if ("problem" in result) return setError(result.problem);
      columns = result.columns;
      periodEnd = columns.periodEnd;
    }
    setBusy(true);
    try {
      const result = await api<{ report: { id: string } }>("/api/custom-reports", {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: key,
          base,
          start: "standard",
          periodEnd: lastDayOfMonth(periodEnd),
          ...(columns ? { columns: { periodLength: columns.periodLength, periodCount: columns.periodCount, yearToDate: columns.yearToDate } } : {}),
        },
      });
      // A layout started here becomes the report's layout on its first save (CR22).
      router.push(`/operations/reports/custom/${result.report.id}?from=edit-layout`);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }
  const active = Boolean(chosen && !standard);
  const more: MoreMenuItem[] = chosen
    ? [
        standard
          ? {
              label: `Show in ${chosen.title}`,
              onSelect: () => setStandard(false),
            }
          : {
              label: "Show the standard layout",
              onSelect: () => setStandard(true),
            },
      ]
    : [];
  const button = (shown: ShownReport | string) =>
    can("bookkeeper") ? (
      <Button variant="secondary" disabled={busy || !defaults.data} onClick={() => void edit(shown)}>
        Edit layout
      </Button>
    ) : null;
  /**
   * What Save as draft and Publish save for this report as shown (CR25): its own layout when it has one, else the standard rows, with the
   * dates, comparisons and tracking filter on screen.
   */
  async function saveRequest(shown: ShownReport, filter: TrackingChoice): Promise<SaveReportRequest> {
    if (base !== "profit_and_loss" && base !== "balance_sheet") return { problem: "This report can't be saved this way." };
    const result = editLayoutColumns(base, shown);
    if ("problem" in result) return { problem: result.problem.replace(/the layout editor/i, "A saved report").replace(/, then Edit layout\./, ", then save it.") };
    const columns = result.columns;
    let layout: CustomReportLayout = standardLayout(base, columns.periodEnd);
    if (active && chosen) {
      const own = await api<{ report: { layout: CustomReportLayout } }>(`/api/custom-reports/${chosen.reportId}`, { query: { organisationId } });
      layout = own.report.layout;
    }
    return {
      base,
      periodEnd: columns.periodEnd,
      layout: { ...layout, columns: { ...layout.columns, ...columns }, filter: filter ? { categoryId: filter.categoryId, valueId: filter.valueId } : null },
    };
  }
  return {
    chosen,
    active,
    more,
    button,
    saveRequest,
    error,
    loaded: Boolean(defaults.data),
  };
}
