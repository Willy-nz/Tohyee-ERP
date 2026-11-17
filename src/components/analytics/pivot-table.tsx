"use client";

import { useState } from "react";
import { useAnalyticsEmbed } from "@/components/analytics/embed-context";
import { FormattedCell,tableLook,totalRowClass } from "@/components/analytics/table-look";
import { columnRange,visiblePivotRows } from "@/lib/analytics/conditional";
import { columnHeaderRows,columnPathText,initiallyCollapsed,isGroupRow,steppedRows,visibleWithCollapsed } from "@/lib/analytics/matrix";
import { Button,Notice,ui } from "@/components/ui";
import { type ChartFormat } from "@/lib/analytics/chart-format";
import type {
PivotColumn,
PivotData,PivotDrillSelection,PivotRow,ResultColumn
} from "@/lib/analytics/query";
import { apiDownload,errorMessage } from "@/lib/client/api";
import { showValue } from "@/lib/analytics/display";
import { fieldLabel } from "@/lib/analytics/labels";
import { formatDate } from "@/lib/format";
import type { ReportExportData,ReportExportTable } from "@/lib/reports/export-types";
import styles from "@/components/analytics-dashboards.module.css";
import { PivotExportFor } from "@/components/analytics/report-shared";

function pivotRowLabel(row: PivotRow, index: number, field: ResultColumn): string {
  if (row.kind === "grand_total" && index === 0) return "Grand total";
  if (row.kind === "subtotal" && index === row.depth) return "Subtotal";
  if (index >= row.depth && row.kind !== "detail") return "";
  return row.dimensions[index] === null ? "(blank)" : showValue(row.dimensions[index], field);
}

function pivotColumnLabel(column: PivotColumn, pivot: PivotData): string {
  if (column.total) return "Grand total";
  if (!pivot.columnField) return column.measure.label;
  if (column.path) return columnPathText(column, (level, value) => pivotValueLabel(pivot, level, value, false));
  return column.pivotValue === null ? "(blank)" : showValue(column.pivotValue, pivot.columnField);
}

/** A column field's value as shown, with its field's name in front for headings. */
function pivotValueLabel(pivot: PivotData, level: number, value: string | null, named: boolean): string {
  const field = pivot.columnFields?.[level] ?? pivot.columnField!;
  const text = value === null ? "(blank)" : showValue(value, field);
  return named ? `${fieldLabel(field.label)}: ${text}` : text;
}

/** The pivot as a report table for the existing CSV/Excel export (`/api/reports/export`), exact values kept as text. */
export function pivotExportTable(pivot: PivotData): ReportExportTable {
  const columns = [
    ...pivot.rowFields.map((field) => fieldLabel(field.label)),
    ...pivot.columns.map((column) =>
      [
        column.total
          ? "Grand total"
          : column.path
            ? columnPathText(column, (level, value) => pivotValueLabel(pivot, level, value, true))
            : pivot.columnField
              ? `${fieldLabel(pivot.columnField.label)}: ${pivotColumnLabel(column, pivot)}`
              : "",
        column.measure.label,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  ];
  const rows = pivot.rows.map((row) => ({
    kind: row.kind === "detail" ? undefined : ("total" as const),
    cells: [
      ...pivot.rowFields.map((field, index) => ({ text: pivotRowLabel(row, index, field) })),
      ...pivot.columns.map((column) => {
        const value = row.cells[column.key] ?? null;
        const text = showValue(value, column.measure);
        return value !== null && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? { text, value, numeric: true } : { text };
      }),
    ],
  }));
  return { columns, rows };
}

export function PivotTable({
  title,
  pivot,
  onDrill,
  exportFor: exportForProp,
  format,
}: {
  title: string;
  pivot: PivotData;
  /** Table style and conditional formatting. */
  format?: ChartFormat;
  onDrill?: (selection: PivotDrillSelection, title: string) => void;
  /** Where the export comes from; without it (e.g. a preview) there's no export. */
  exportFor?: PivotExportFor;
}) {
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // No exports from a slide: the add-in only shows reports.
  const exportFor = useAnalyticsEmbed() ? undefined : exportForProp;
  const download = async (format: "csv" | "xlsx") => {
    if (!exportFor) return;
    setExportError(null);
    setExporting(true);
    try {
      const { from, to, values } = exportFor.filters;
      const data: ReportExportData = {
        report: "analytics-pivot",
        organisationName: exportFor.organisationName,
        title,
        period: from || to ? `${from ? formatDate(from) : "Start"} to ${to ? formatDate(to) : "today"}` : "All dates",
        basis: null,
        filters: Object.entries(values)
          .filter(([, chosen]) => chosen.length > 0)
          .map(([field, chosen]) => `${fieldLabel(field)}: ${chosen.join(", ")}`)
          .slice(0, 30),
        producedAt: new Date().toISOString(),
        tables: [pivotExportTable(pivot)],
      };
      const blob = await apiDownload("/api/reports/export", { organisationId: exportFor.organisationId, format, data });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${title.trim().replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "") || "pivot"}.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(errorMessage(error));
    } finally {
      setExporting(false);
    }
  };
  const click = (row: PivotRow, column: PivotColumn) => {
    if (!onDrill) return;
    const rowValues = row.dimensions.slice(0, row.depth).map((value) => value === null ? "(blank)" : value);
    const columnValue = column.total ? "Grand total" : pivot.columnField ? pivotColumnLabel(column, pivot) : "";
    const drillTitle = [rowValues.join(" · "), columnValue, column.measure.label].filter(Boolean).join(" · ") || "Grand total";
    onDrill(
      { depth: row.depth, dimensions: row.dimensions, pivotValue: column.pivotValue, total: column.total, ...(column.path ? { pivotPath: column.path } : {}) },
      `Rows · ${drillTitle}`,
    );
  };
  const look = tableLook(format?.table);
  // A value's position among the tile's values, for its conditional formatting.
  const measureKeys = [...new Set(pivot.columns.map((column) => column.measure.key))];
  const detailRows = pivot.rows.filter((row) => row.kind === "detail");
  const ranges = new Map(pivot.columns.map((column) => [column.key, columnRange(detailRows.map((row) => row.cells[column.key] ?? null))]));
  // Matrix layout: stepped rows, and groups that open and close.
  const levels = pivot.rowFields.length;
  const stepped = format?.table?.layout === "stepped" && levels > 0;
  const offLevels = new Set(format?.table?.subtotalsOff ?? []);
  const ordered = stepped ? steppedRows(pivot.rows.filter((row) => row.kind !== "grand_total" || format?.table?.totals !== false), levels) : visiblePivotRows(pivot.rows, format?.table);
  const groupsKey = JSON.stringify([pivot.rows.map((row) => row.key), format?.table?.expandTo]);
  const [collapsedState, setCollapsed] = useState<{ key: string; set: Set<string> } | null>(null);
  const collapsed = collapsedState?.key === groupsKey ? collapsedState.set : initiallyCollapsed(pivot.rows, levels, format?.table?.expandTo);
  const toggle = (row: PivotRow) => {
    const next = new Set(collapsed);
    if (next.has(row.key)) next.delete(row.key);
    else next.add(row.key);
    setCollapsed({ key: groupsKey, set: next });
  };
  const groups = ordered.filter((row) => isGroupRow(row, levels));
  const shownRows = visibleWithCollapsed(ordered, collapsed);
  const headerRows = pivot.columnField ? columnHeaderRows(pivot, (level, value) => pivotValueLabel(pivot, level, value, true)) : [];
  const headerDepth = headerRows.length + 1;
  const rowLabel = (row: PivotRow): string => {
    if (row.kind === "grand_total") return "Grand total";
    const level = Math.max(0, row.depth - 1);
    const value = row.dimensions[level];
    return value === null ? "(blank)" : showValue(value, pivot.rowFields[level]);
  };
  const toggleButton = (row: PivotRow) => {
    if (!isGroupRow(row, levels)) return null;
    const open = !collapsed.has(row.key);
    const name = row.dimensions.slice(0, row.depth).map((value, index) => (value === null ? "(blank)" : showValue(value, pivot.rowFields[index]))).join(" · ");
    return (
      <button type="button" className={styles.pivotToggle} aria-expanded={open} aria-label={`${open ? "Close" : "Open"} ${name}`} onClick={() => toggle(row)}>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
    );
  };
  return (
    <div className={styles.pivot}>
      {exportFor || groups.length ? (
        <div className={styles.pivotTools}>
          {groups.length ? (
            <>
              <Button size="small" variant="secondary" disabled={collapsed.size === 0} onClick={() => setCollapsed({ key: groupsKey, set: new Set() })}>Open all</Button>
              <Button size="small" variant="secondary" disabled={collapsed.size === groups.length} onClick={() => setCollapsed({ key: groupsKey, set: new Set(groups.map((row) => row.key)) })}>Close all</Button>
            </>
          ) : null}
          {exportFor ? (
            <>
              <Button size="small" variant="secondary" disabled={exporting} onClick={() => void download("csv")}>Export CSV</Button>
              <Button size="small" variant="secondary" disabled={exporting} onClick={() => void download("xlsx")}>Export Excel</Button>
            </>
          ) : null}
        </div>
      ) : null}
      {exportError ? <Notice tone="error">{exportError}</Notice> : null}
      <div className={`${ui.tableWrap} ${styles.pivotWrap}`}>
        <table className={`${ui.table} ${look.className}`} style={look.style} aria-label={`${title} pivot table`}>
          <caption>{title}</caption>
          <thead>
            {pivot.columnField ? (
              <>
                {headerRows.map((cells, level) => (
                  <tr key={`level-${level}`}>
                    {level === 0
                      ? stepped
                        ? <th scope="col" rowSpan={headerDepth}>{pivot.rowFields.map((field) => fieldLabel(field.label)).join(" › ")}</th>
                        : pivot.rowFields.map((field) => <th key={field.key} scope="col" rowSpan={headerDepth}>{fieldLabel(field.label)}</th>)
                      : null}
                    {cells.map((cell) => (
                      <th key={cell.key} scope="colgroup" colSpan={cell.colSpan} rowSpan={cell.rowSpan}>{cell.text}</th>
                    ))}
                  </tr>
                ))}
                <tr>{pivot.columns.map((column) => <th key={column.key} scope="col" className={ui.num}>{column.measure.label}</th>)}</tr>
              </>
            ) : (
              <tr>
                {stepped
                  ? <th scope="col">{pivot.rowFields.map((field) => fieldLabel(field.label)).join(" › ")}</th>
                  : pivot.rowFields.map((field) => <th key={field.key} scope="col">{fieldLabel(field.label)}</th>)}
                {pivot.columns.map((column) => <th key={column.key} scope="col" className={ui.num}>{column.measure.label}</th>)}
              </tr>
            )}
          </thead>
          <tbody>
            {shownRows.map((row) => {
              // In the stepped layout a group's row is its heading; with its subtotal turned off, its figures are left blank.
              const blank = stepped && row.kind === "subtotal" && offLevels.has(row.depth);
              return (
              <tr key={row.key} className={row.kind !== "detail" && !(stepped && row.kind === "subtotal" && blank) ? totalRowClass(format?.table, styles.pivotTotal) : undefined}>
                {stepped ? (
                  <th scope="row" className={styles.pivotStep} style={{ paddingInlineStart: `${8 + Math.max(0, row.depth - 1) * 16}px` }}>
                    {toggleButton(row)}
                    {rowLabel(row)}
                  </th>
                ) : (
                  pivot.rowFields.map((field, index) => (
                    <th key={field.key} scope="row">
                      {row.kind === "subtotal" && index === row.depth ? toggleButton(row) : null}
                      {pivotRowLabel(row, index, field)}
                    </th>
                  ))
                )}
                {pivot.columns.map((column) => (
                  blank ? <td key={column.key} className={ui.num} /> :
                  <FormattedCell
                    key={column.key}
                    className={ui.num}
                    format={row.kind === "detail" ? format : undefined}
                    valueIndex={measureKeys.indexOf(column.measure.key)}
                    value={row.cells[column.key] ?? null}
                    range={ranges.get(column.key) ?? null}
                    field={row.dimensions[0] ?? null}
                  >
                    {onDrill ? (
                      <button
                        type="button"
                        className={styles.pivotCell}
                        aria-label={`Show rows for ${stepped ? rowLabel(row) : pivot.rowFields.map((field, index) => pivotRowLabel(row, index, field)).filter(Boolean).join(" · ")}, ${pivotColumnLabel(column, pivot)}, ${column.measure.label}`}
                        onClick={() => click(row, column)}
                      >
                        {showValue(row.cells[column.key] ?? null, column.measure)}
                      </button>
                    ) : (
                      showValue(row.cells[column.key] ?? null, column.measure)
                    )}
                  </FormattedCell>
                ))}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
