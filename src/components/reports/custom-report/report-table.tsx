"use client";

import { useState } from "react";
import { Button,ui } from "@/components/ui";
import {
type ComputedBlock,CUSTOM_REPORT_LIMITS,type CustomReportFigures,
type CustomReportLayout,groupAccounts,
moveAccounts,moveRow,
newLayoutId,type ReportBlock,type ReportRow,
type ReportTrackingFilter
} from "@/lib/reports/custom-layout";
import { useConfirm } from "@/components/confirm-dialog";
import { statementAsAt,statementPeriod } from "@/lib/reports/report-dates";
import { CustomFiguresTable,type RowEditor } from "@/components/reports/custom-report-table";
import { formulaRows } from "@/components/reports/custom-report/row-editor";

/** The report's period in the statement's words. */
export function periodSummary(figures: CustomReportFigures): string {
  const periods = figures.columns.filter((column) => column.kind === "period");
  if (periods.length === 0) return "";
  // p0 is the chosen period, wherever the order puts it.
  const newest = periods.find((column) => column.key === "p0") ?? periods[0];
  if (figures.base === "balance_sheet") {
    return periods.length === 1 ? statementAsAt(newest.to!) : `${statementAsAt(newest.to!)}, compared with ${periods.length - 1} earlier date${periods.length > 2 ? "s" : ""}`;
  }
  return periods.length === 1
    ? statementPeriod(newest.from!, newest.to!)
    : `${statementPeriod(newest.from!, newest.to!)}, compared with ${periods.length - 1} earlier period${periods.length > 2 ? "s" : ""}`;
}

export type Editing =
  | {
      kind: "row";
      blockId: string;
      row: ReportRow;
      isNew: boolean;
      after?: string;
    }
  | { kind: "columns" }
  | null;

/** What's picked in the layout editor, to change in Details (LE1). */
export type Picked = { kind: "row"; blockId: string; rowId: string } | { kind: "block"; blockId: string } | { kind: "columns" } | null;

export function move<T>(items: T[], index: number, by: -1 | 1): boolean {
  const to = index + by;
  if (index < 0 || to < 0 || to >= items.length) return false;
  const [item] = items.splice(index, 1);
  items.splice(to, 0, item);
  return true;
}

export function ReportTable({
  block,
  figures,
  layoutBlock,
  editable,
  busy,
  onChange,
  onEditRow,
  onEditNote,
  onError,
  filter,
  onPick,
  pickedRowId,
  onPickColumns,
}: {
  filter?: ReportTrackingFilter | null;
  block: Extract<ComputedBlock, { kind: "table" }>;
  figures: CustomReportFigures;
  layoutBlock: Extract<ReportBlock, { kind: "table" }> | undefined;
  editable: boolean;
  busy: boolean;
  onChange: (change: (layout: CustomReportLayout) => boolean | void) => void;
  onEditRow: (row: ReportRow, isNew: boolean) => void;
  onEditNote: (row: ReportRow) => void;
  onError: (message: string) => void;
  onPick?: (rowId: string) => void;
  pickedRowId?: string | null;
  onPickColumns?: () => void;
}) {
  const confirm = useConfirm();
  const [title, setTitle] = useState(block.title);
  const tableOf = (layout: CustomReportLayout) => layout.blocks.find((entry) => entry.id === block.id) as Extract<ReportBlock, { kind: "table" }>;
  const rowOf = (layout: CustomReportLayout, id: string) => tableOf(layout).rows.find((r) => r.id === id)!;
  const [announce, setAnnounce] = useState("");
  /** Just this table, for checking a change before it's made. */
  const figuresLayout = (rows: ReportRow[]): CustomReportLayout => ({ title: "", columns: {} as CustomReportLayout["columns"], blocks: [{ id: block.id, kind: "table", title: block.title, rows }] });

  const editor: RowEditor | undefined = editable
    ? {
        busy,
        select: onPick,
        selectedId: pickedRowId,
        selectColumns: onPickColumns,
        rename: (rowId, label) => onChange((layout) => void (rowOf(layout, rowId).label = label)),
        move: (rowId, toIndex) => {
          const rows = layoutBlock?.rows ?? [];
          if (toIndex < 0 || toIndex >= rows.length) return;
          onChange((layout) => {
            const moved = moveRow(layout, block.id, rowId, toIndex);
            layout.blocks = moved.blocks;
          });
          const row = rows.find((entry) => entry.id === rowId);
          setAnnounce(`${row?.label ?? "Row"} moved to row ${toIndex + 1} of ${rows.length}.`);
          // Keep focus on the handle the person is using.
          requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[aria-label^="Move ${CSS.escape(row?.label ?? "")}, row"]`)?.focus());
        },
        group: (rowId, codes, label) =>
          onChange((layout) => {
            const grouped = groupAccounts(layout, block.id, rowId, codes, label);
            layout.blocks = grouped.layout.blocks;
          }),
        moveAccounts: (fromRowId, codes, toRowId) => {
          const rows = layoutBlock?.rows ?? [];
          const to = rows.find((entry) => entry.id === toRowId);
          try {
            // Checked first, so a refusal (the group's last account) shows as a message.
            moveAccounts(figuresLayout(rows), block.id, fromRowId, codes, toRowId);
          } catch (caught) {
            onError(caught instanceof Error ? caught.message : "Those accounts can't be moved there.");
            return;
          }
          onChange((layout) => {
            layout.blocks = moveAccounts(layout, block.id, fromRowId, codes, toRowId).blocks;
          });
          setAnnounce(`${codes.length} ${codes.length === 1 ? "account" : "accounts"} moved to ${to?.label ?? "the group"}.`);
        },
        rowMenu: (row) => {
          const layoutRow = layoutBlock?.rows.find((entry) => entry.id === row.id);
          if (!layoutRow) return [];
          const toggle = (field: "hidden" | "pageBreakAfter") =>
            onChange((layout) => {
              const target = rowOf(layout, row.id);
              if (target[field]) delete target[field];
              else target[field] = true;
            });
          return [
            ...(layoutRow.kind !== "heading"
              ? [
                  {
                    label: "Change…",
                    onSelect: () => onEditRow(structuredClone(layoutRow), false),
                  },
                ]
              : []),
            {
              label: layoutRow.hidden ? "Show" : "Hide",
              onSelect: () => toggle("hidden"),
            },
            {
              label: layoutRow.pageBreakAfter ? "No page break after" : "Page break after",
              onSelect: () => toggle("pageBreakAfter"),
            },
            {
              label: layoutRow.note ? "Change note…" : "Add note…",
              onSelect: () => onEditNote(structuredClone(layoutRow)),
            },
            {
              label: "Delete",
              danger: true,
              onSelect: async () => {
                const users = (layoutBlock?.rows ?? []).filter((r) => r.kind === "formula" && formulaRows(r).includes(row.id));
                if (users.length > 0) {
                  onError(
                    `${users.map((r) => r.label).join(" and ")} ${users.length === 1 ? "uses" : "use"} ${row.label}. Change or delete ${users.length === 1 ? "it" : "them"} first.`,
                  );
                  return;
                }
                if (!(await confirm(`Delete the row ${row.label}?`))) return;
                onChange((layout) => {
                  const rows = tableOf(layout).rows;
                  rows.splice(
                    rows.findIndex((r) => r.id === row.id),
                    1,
                  );
                });
              },
            },
          ];
        },
      }
    : undefined;

  return (
    <div className={ui.reportBlock}>
      {editable ? (
        <div className={ui.blockHeader} data-print="hide">
          <input
            aria-label="Table title"
            placeholder="Table title (optional)"
            value={title}
            maxLength={CUSTOM_REPORT_LIMITS.labelLength}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => {
              if (title.trim() !== block.title) onChange((layout) => void (tableOf(layout).title = title.trim()));
            }}
          />
        </div>
      ) : null}
      {block.title ? <h3 className={`${ui.reportBlockTitle} ${editable ? ui.printOnly : ""}`}>{block.title}</h3> : null}
      <CustomFiguresTable id={`custom-report-${block.id}`} block={block} figures={figures} filter={filter} editor={editor} />
      <p className={ui.srOnly} role="status" aria-live="polite">
        {announce}
      </p>
      {editable ? (
        <div className={ui.actions} data-print="hide">
          <span className={ui.muted}>Add a row:</span>
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              onEditRow(
                {
                  id: newLayoutId("r"),
                  kind: "group",
                  label: "",
                  accountTypes: [],
                  accountCodes: [],
                  showAccounts: true,
                },
                true,
              )
            }
          >
            Group of accounts
          </Button>
          <Button size="small" variant="secondary" disabled={busy} onClick={() => onEditRow({ id: newLayoutId("r"), kind: "formula", label: "", terms: [] }, true)}>
            Formula
          </Button>
          <Button size="small" variant="secondary" disabled={busy} onClick={() => onEditRow({ id: newLayoutId("r"), kind: "heading", label: "" }, true)}>
            Heading
          </Button>
          {figures.base === "balance_sheet" ? (
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                onEditRow(
                  {
                    id: newLayoutId("r"),
                    kind: "earnings",
                    label: "Current year earnings",
                    which: "current",
                  },
                  true,
                )
              }
            >
              Earnings
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
