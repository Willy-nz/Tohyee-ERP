"use client";

import { Notice } from "@/components/ui";
import {
type CustomReportFigures
} from "@/lib/reports/custom-layout";

/** Accounts left out of a report, or counted twice, so it doesn't hide that it no longer adds up. */
export function ReportWarnings({ figures }: { figures: CustomReportFigures }) {
  return (
    <>
      {figures.notInReport.length > 0 ? (
        <Notice tone="warning">
          <strong>Not in this report:</strong> these accounts have amounts but aren&apos;t in any group, so the report doesn&apos;t add up to the ledger.
          <ul>
            {figures.notInReport.map((line) => (
              <li key={line.code}>
                {line.code} · {line.name}:{" "}
                {figures.columns
                  .filter((column) => column.kind === "period" || column.kind === "year_to_date")
                  .map((column) => `${column.label} ${line.values[column.key]}`)
                  .join(", ")}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {figures.inSeveralGroups.length > 0 ? (
        <Notice tone="warning">
          <strong>Counted more than once:</strong>
          <ul>
            {figures.inSeveralGroups.map((entry) => (
              <li key={`${entry.tableTitle}:${entry.code}`}>
                {entry.code} · {entry.name} is in {entry.groups.join(" and ")}
                {entry.tableTitle ? ` (${entry.tableTitle})` : ""}.
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </>
  );
}
