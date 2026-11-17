"use client";

import Link from "next/link";
import { useRouter,useSearchParams } from "next/navigation";
import { Fragment,useEffect,useState } from "react";
import { useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { useTracking } from "@/components/tracking";
import { Badge,Button,Empty,Notice,ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api,errorMessage,newIdempotencyKey } from "@/lib/client/api";
import { formatDateTime,personName } from "@/lib/format";
import type { CustomReport } from "@/lib/reports/custom";
import type { AnyCustomReportFigures } from "@/lib/reports/custom";
import {
CUSTOM_REPORT_BASES,
isEquityLayout,
isTransactionReportBase,
CUSTOM_REPORT_LIMITS,type CustomReportFigures,
type CustomReportLayout,
type FinancialReportBase,moveRow,
newLayoutId,type ReportBlock,addedColumnKey,
type ReportRow
} from "@/lib/reports/custom-layout";
import type { Budget } from "@/lib/budgets/service";
import { useConfirm } from "@/components/confirm-dialog";
import { CustomFiguresTable } from "@/components/reports/custom-report-table";
import { CashFlowCustomReportPage } from "@/components/reports/cash-flow-custom-report";
import { EquityCustomReportPage } from "@/components/reports/equity-custom-report";
import { TransactionCustomReportPage } from "@/components/reports/transaction-custom-report";
import { MoreMenu,type MoreMenuItem } from "@/components/more-menu";
import { ExportMenu } from "@/components/reports/report-export";
import { Editing,Picked,ReportTable,move,periodSummary } from "@/components/reports/custom-report/report-table";
import { NoteBlock,NoteEditor,NotesCellInput,RowEditor as RowEditorForm,SaveAsForm,formulaRows } from "@/components/reports/custom-report/row-editor";
import { ColumnsEditor } from "@/components/reports/custom-report/columns-editor";
import { FavouriteButton } from "@/components/reports/custom-report/favourites";
import { ReportWarnings } from "@/components/reports/custom-report/warnings";
export { CustomReportList, StartCustomReport } from "@/components/reports/custom-report/list";
export { FavouriteButton, FavouriteToggle, useFavourite } from "@/components/reports/custom-report/favourites";
export { ReportWarnings } from "@/components/reports/custom-report/warnings";

/**
 * Custom reports (examples CR1-CR10): the lists (drafts, published,
 * archived), starting one from a standard report, and the report page, which
 * is also its editor while it's a draft.
 */

type Loaded = { report: CustomReport; figures: AnyCustomReportFigures };

export const pageHref = (id: string) => `/operations/reports/custom/${id}`;

export function CustomReportPage({ organisationId, reportId }: { organisationId: string; reportId: string }) {
  const confirm = useConfirm();
  const router = useRouter();
  const fromEditLayout = useSearchParams()?.get("from") === "edit-layout";
  const { can, current } = useWorkspace();
  const loaded = useApiData<Loaded>(`/api/custom-reports/${encodeURIComponent(reportId)}`, { organisationId });
  const accounts = useAccounts(organisationId, true);
  const tracking = useTracking(organisationId);
  const budgets = useApiData<{ budgets: Budget[] }>("/api/budgets", {
    organisationId,
  });
  const defaults = useApiData<{
    defaults: Array<{ base: string; reportId: string }>;
  }>("/api/report-layouts", { organisationId });
  const [defaultsOverride, setDefaultsOverride] = useState<Array<{
    base: string;
    reportId: string;
  }> | null>(null);
  const [state, setState] = useState<Loaded | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [picked, setPicked] = useState<Picked>(null);
  const [sideTab, setSideTab] = useState<"details" | "preview">("details");
  const [noteFor, setNoteFor] = useState<{
    blockId: string;
    row: ReportRow;
  } | null>(null);
  const [saveAs, setSaveAs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [publishKey, setPublishKey] = useState(() => newIdempotencyKey("custom-report-publish"));
  const [saveAsKey] = useState(() => newIdempotencyKey("custom-report-copy"));
  const [title, setTitle] = useState<string | null>(null);
  // Changes are kept here until Save; the figures shown are a preview of them.
  const [draft, setDraft] = useState<CustomReportLayout | null>(null);
  const [preview, setPreview] = useState<CustomReportFigures | null>(null);
  // The editor's own figures (CR23): the saved layout with every account listed, so ones with nothing in these dates can be moved too.
  const [editorFigures, setEditorFigures] = useState<{ version: number; figures: CustomReportFigures } | null>(null);
  const shownReport = (state ?? loaded.data)?.report;
  const editorVersion =
    shownReport && shownReport.kind === "draft" && !shownReport.archivedAt && can("bookkeeper") && (shownReport.base === "profit_and_loss" || shownReport.base === "balance_sheet")
      ? shownReport.version
      : null;
  const editorLayout = editorVersion == null ? null : shownReport!.layout;
  useEffect(() => {
    if (editorVersion == null || !editorLayout) return;
    let stale = false;
    api<{ figures: CustomReportFigures }>(`/api/custom-reports/${encodeURIComponent(reportId)}/preview`, {
      method: "POST",
      body: { organisationId, layout: editorLayout, everyAccount: true },
    }).then(
      (result) => {
        if (!stale) setEditorFigures({ version: editorVersion, figures: result.figures });
      },
      () => {
        // The report's own figures still show; only accounts with nothing in these dates are missing.
      },
    );
    return () => {
      stale = true;
    };
    // The layout only changes with the version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organisationId, reportId, editorVersion]);

  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  const currentLoaded = state ?? loaded.data;
  if (isEquityLayout(currentLoaded.report.base, currentLoaded.report.layout)) {
    return <EquityCustomReportPage organisationId={organisationId} loaded={currentLoaded} />;
  }
  if (isTransactionReportBase(currentLoaded.report.base)) {
    return <TransactionCustomReportPage organisationId={organisationId} loaded={currentLoaded} />;
  }
  if (currentLoaded.report.base === "cash_flows") {
    return <CashFlowCustomReportPage organisationId={organisationId} loaded={currentLoaded} />;
  }
  const report = currentLoaded.report as CustomReport & {
    base: FinancialReportBase;
    layout: CustomReportLayout;
  };
  const layout = draft ?? report.layout;
  const figures =
    (draft ? preview : null) ?? (editorFigures && editorFigures.version === report.version ? editorFigures.figures : null) ?? (currentLoaded.figures as CustomReportFigures);
  const editable = report.kind === "draft" && !report.archivedAt && can("bookkeeper");
  const titleValue = title ?? layout.title;
  const defaultList = defaultsOverride ?? defaults.data?.defaults ?? [];
  const isDefault = defaultList.some((entry) => entry.reportId === report.id);
  const baseName = CUSTOM_REPORT_BASES[report.base].toLowerCase();

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await work();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  /** Applies a change to a copy of the layout, unsaved, and shows its figures. */
  function change(apply: (layout: CustomReportLayout) => boolean | void, after?: () => void) {
    const next = structuredClone(layout);
    if (apply(next) === false) return;
    void run(async () => {
      const result = await api<{ figures: CustomReportFigures }>(`/api/custom-reports/${report.id}/preview`, {
        method: "POST",
        body: { organisationId, layout: next, everyAccount: true },
      });
      setDraft(next);
      setPreview(result.figures);
      setTitle(null);
      after?.();
    });
  }

  const save = () =>
    run(async () => {
      if (!draft) return;
      const saved = await api<Loaded>(`/api/custom-reports/${report.id}`, {
        method: "PUT",
        body: { organisationId, layout: draft, version: report.version },
      });
      setState(saved);
      setDraft(null);
      setPreview(null);
      // Started with Edit layout on a report that has no layout of its own yet: Reports shows this one from now on (CR22).
      if (fromEditLayout && !defaultList.some((entry) => entry.base === report.base)) {
        const result = await api<{ defaults: Array<{ base: string; reportId: string }> }>("/api/report-layouts", {
          method: "PUT",
          body: { organisationId, base: report.base, reportId: report.id },
        });
        setDefaultsOverride(result.defaults);
        setMessage(`Saved. Reports now shows the ${baseName} in this layout. To go back to the standard one, choose "Stop using as the ${baseName} layout" under ⋯.`);
        return;
      }
      setMessage("Saved.");
    });

  function saveRow(blockId: string, row: ReportRow, isNew: boolean, after?: string) {
    change(
      (next) => {
        const table = next.blocks.find((block) => block.id === blockId) as Extract<ReportBlock, { kind: "table" }>;
        const at = after ? table.rows.findIndex((entry) => entry.id === after) : -1;
        if (isNew && at >= 0) table.rows.splice(at + 1, 0, row);
        else if (isNew) table.rows.push(row);
        else table.rows[table.rows.findIndex((entry) => entry.id === row.id)] = row;
      },
      () => {
        setEditing(null);
        setPicked({ kind: "row", blockId, rowId: row.id });
      },
    );
  }

  // The layout editor's toolbar (LE1-LE3): each acts on what's picked.
  const pickedBlockId = picked && picked.kind !== "columns" ? picked.blockId : null;
  function insertBlock(block: ReportBlock) {
    change(
      (next) => {
        const at = pickedBlockId ? next.blocks.findIndex((entry) => entry.id === pickedBlockId) : -1;
        if (at >= 0) next.blocks.splice(at + 1, 0, block);
        else next.blocks.push(block);
      },
      () => setPicked({ kind: "block", blockId: block.id }),
    );
  }
  function addSection() {
    const tableId =
      pickedBlockId && layout.blocks.find((entry) => entry.id === pickedBlockId)?.kind === "table" ? pickedBlockId : layout.blocks.find((entry) => entry.kind === "table")?.id;
    if (!tableId) {
      setError("Add a table first: a section goes in a table.");
      return;
    }
    setSideTab("details");
    setEditing({
      kind: "row",
      blockId: tableId,
      row: { id: newLayoutId("r"), kind: "heading", label: "" },
      isNew: true,
      after: picked?.kind === "row" ? picked.rowId : undefined,
    });
  }
  function togglePageBreak() {
    if (!picked || picked.kind === "columns") {
      setError("Pick a row, table or note first, then Page break puts a new page after it.");
      return;
    }
    change((next) => {
      const block = next.blocks.find((entry) => entry.id === picked.blockId);
      if (!block) return false;
      const target: { pageBreakAfter?: boolean } | undefined = picked.kind === "row" && block.kind === "table" ? block.rows.find((entry) => entry.id === picked.rowId) : block;
      if (!target) return false;
      if (target.pageBreakAfter) delete target.pageBreakAfter;
      else target.pageBreakAfter = true;
    });
  }
  function movePicked(by: -1 | 1) {
    if (!picked || picked.kind === "columns") return;
    if (picked.kind === "block") return moveBlock(picked.blockId, by);
    const rows = (layout.blocks.find((entry) => entry.id === picked.blockId) as Extract<ReportBlock, { kind: "table" }> | undefined)?.rows ?? [];
    const index = rows.findIndex((entry) => entry.id === picked.rowId);
    if (index + by < 0 || index + by >= rows.length) return;
    change((next) => {
      next.blocks = moveRow(next, picked.blockId, picked.rowId, index + by).blocks;
    });
  }
  async function deletePicked() {
    if (!picked || picked.kind === "columns") return;
    const block = layout.blocks.find((entry) => entry.id === picked.blockId);
    if (!block) return;
    if (picked.kind === "block") {
      await deleteBlock(block.id, block.kind === "table" ? "table and its rows" : "note");
      setPicked(null);
      return;
    }
    if (block.kind !== "table") return;
    const row = block.rows.find((entry) => entry.id === picked.rowId);
    if (!row) return;
    const users = block.rows.filter((entry) => entry.kind === "formula" && formulaRows(entry).includes(row.id));
    if (users.length > 0) {
      setError(
        `${users.map((entry) => entry.label).join(" and ")} ${users.length === 1 ? "uses" : "use"} ${row.label}. Change or delete ${users.length === 1 ? "it" : "them"} first.`,
      );
      return;
    }
    if (!(await confirm(`Delete the row ${row.label}?`))) return;
    change(
      (next) => {
        const rows = (next.blocks.find((entry) => entry.id === block.id) as Extract<ReportBlock, { kind: "table" }>).rows;
        rows.splice(
          rows.findIndex((entry) => entry.id === row.id),
          1,
        );
      },
      () => setPicked(null),
    );
  }
  function cancelChanges() {
    setDraft(null);
    setPreview(null);
    setEditing(null);
    setPicked(null);
    setNoteFor(null);
    setTitle(null);
    setMessage("Changes cancelled.");
  }

  function moveBlock(id: string, by: -1 | 1) {
    change((next) =>
      move(
        next.blocks,
        next.blocks.findIndex((block) => block.id === id),
        by,
      ),
    );
  }
  async function deleteBlock(id: string, what: string) {
    if (!(await confirm(`Delete this ${what}?`))) return;
    change((next) => {
      next.blocks.splice(
        next.blocks.findIndex((block) => block.id === id),
        1,
      );
    });
  }

  const publish = () =>
    run(async () => {
      const result = await api<{ report: CustomReport }>(`/api/custom-reports/${report.id}/publish`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: publishKey },
      });
      setPublishKey(newIdempotencyKey("custom-report-publish"));
      router.push(pageHref(result.report.id));
    });
  const setArchived = (archived: boolean) =>
    run(async () => {
      const result = await api<{ report: CustomReport }>(`/api/custom-reports/${report.id}/archive`, { method: "POST", body: { organisationId, archived } });
      setState({ report: result.report, figures: currentLoaded.figures });
      setMessage(archived ? "Archived. It's under Reports › Archived." : "Brought back.");
      defaults.reload();
      setDefaultsOverride(null);
    });
  const remove = async () => {
    if (!(await confirm(`Delete the draft ${report.title}? Published copies of it stay.`))) return;
    void run(async () => {
      await api(`/api/custom-reports/${report.id}`, {
        method: "DELETE",
        query: { organisationId },
      });
      router.push("/operations/reports?view=drafts");
    });
  };
  const setDefault = (on: boolean) =>
    run(async () => {
      const result = await api<{
        defaults: Array<{ base: string; reportId: string }>;
      }>("/api/report-layouts", {
        method: "PUT",
        body: {
          organisationId,
          base: report.base,
          reportId: on ? report.id : null,
        },
      });
      setDefaultsOverride(result.defaults);
      setMessage(on ? `Reports now shows the ${baseName} in this layout.` : `Reports shows the standard ${baseName} again.`);
    });
  const copy = (copyTitle: string) =>
    run(async () => {
      const result = await api<{ report: CustomReport }>("/api/custom-reports", {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: saveAsKey,
          base: report.base,
          layout: { ...layout, title: copyTitle },
        },
      });
      router.push(pageHref(result.report.id));
    });

  const reportRows = layout.blocks.flatMap((block) => (block.kind === "table" ? block.rows.filter((row) => row.kind !== "heading").map((row) => ({ id: row.id, label: row.label })) : []));
  const tableBlocks = new Map(layout.blocks.filter((block) => block.kind === "table").map((block) => [block.id, block as Extract<ReportBlock, { kind: "table" }>]));
  const editingTable = editing?.kind === "row" ? tableBlocks.get(editing.blockId) : undefined;
  const exportTables = figures.blocks
    .filter((block) => block.kind === "table")
    .map((block) => ({
      id: `custom-report-${block.id}`,
      title: (block as { title: string }).title || undefined,
    }));
  const editorsPanel = (
    <>
      {noteFor ? (
        <NoteEditor
          row={noteFor.row}
          busy={busy}
          onCancel={() => setNoteFor(null)}
          onSave={(note) =>
            change(
              (next) => {
                const table = next.blocks.find((block) => block.id === noteFor.blockId) as Extract<ReportBlock, { kind: "table" }>;
                const target = table.rows.find((entry) => entry.id === noteFor.row.id)!;
                if (note) target.note = note;
                else delete target.note;
              },
              () => setNoteFor(null),
            )
          }
        />
      ) : null}
      {editing?.kind === "columns" ? (
        <ColumnsEditor
          base={report.base}
          initial={layout.columns}
          initialFilter={layout.filter ?? null}
          rows={reportRows}
          tracking={tracking.data}
          budgets={budgets.data?.budgets ?? []}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(setting, filter) =>
            change(
              (next) => {
                next.columns = setting;
                if (filter) next.filter = filter;
                else delete next.filter;
              },
              () => setEditing(null),
            )
          }
        />
      ) : null}
      {editing?.kind === "row" && editingTable ? (
        <RowEditorForm
          key={editing.row.id}
          base={report.base}
          table={editingTable}
          initial={editing.row}
          isNew={editing.isNew}
          accounts={accounts.data?.accounts ?? []}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(row) => saveRow(editing.blockId, row, editing.isNew, editing.after)}
        />
      ) : null}
    </>
  );
  // The layout editor's side panel (LE1, LE2): Details for what's picked, or a Preview of the report as it prints.
  const pickedTable = picked && picked.kind !== "columns" ? tableBlocks.get(picked.blockId) : undefined;
  const pickedRow = picked?.kind === "row" ? pickedTable?.rows.find((entry) => entry.id === picked.rowId) : undefined;
  const pickedBlock = picked?.kind === "block" ? layout.blocks.find((entry) => entry.id === picked.blockId) : undefined;
  const flag = (field: "hidden" | "pageBreakAfter", on: boolean) =>
    change((next) => {
      if (!picked || picked.kind === "columns") return false;
      const block = next.blocks.find((entry) => entry.id === picked.blockId);
      const target: { hidden?: boolean; pageBreakAfter?: boolean } | undefined =
        picked.kind === "row" && block?.kind === "table" ? block.rows.find((entry) => entry.id === picked.rowId) : field === "pageBreakAfter" ? block : undefined;
      if (!target) return false;
      if (on) target[field] = true;
      else delete target[field];
    });
  const details = (() => {
    if (editing?.kind === "row" || noteFor) return editorsPanel;
    if (picked?.kind === "columns") {
      return (
        <ColumnsEditor
          base={report.base}
          initial={layout.columns}
          initialFilter={layout.filter ?? null}
          rows={reportRows}
          tracking={tracking.data}
          budgets={budgets.data?.budgets ?? []}
          busy={busy}
          onCancel={() => setPicked(null)}
          onSave={(setting, filter) =>
            change((next) => {
              next.columns = setting;
              if (filter) next.filter = filter;
              else delete next.filter;
            })
          }
        />
      );
    }
    if (pickedRow && pickedTable && picked?.kind === "row") {
      return (
        <div style={{ display: "grid", gap: 12 }}>
          <RowEditorForm
            key={`${pickedRow.id}:${JSON.stringify(pickedRow)}`}
            base={report.base}
            table={pickedTable}
            initial={structuredClone(pickedRow)}
            isNew={false}
            accounts={accounts.data?.accounts ?? []}
            busy={busy}
            onCancel={() => setPicked(null)}
            onSave={(row) => saveRow(picked.blockId, row, false)}
          />
          <label>
            <input type="checkbox" checked={Boolean(pickedRow.hidden)} disabled={busy} onChange={(event) => flag("hidden", event.target.checked)} /> Hide this row
          </label>
          <label>
            <input type="checkbox" checked={Boolean(pickedRow.pageBreakAfter)} disabled={busy} onChange={(event) => flag("pageBreakAfter", event.target.checked)} /> New page after
            this row
          </label>
          {(layout.columns.added ?? [])
            .filter((column) => column.kind === "notes")
            .map((column) => (
              <NotesCellInput
                key={`${pickedRow.id}:${column.id}:${pickedRow.cells?.[addedColumnKey(column)] ?? ""}`}
                label={column.heading || "Notes"}
                value={pickedRow.cells?.[addedColumnKey(column)] ?? ""}
                busy={busy}
                onSave={(value) =>
                  change((next) => {
                    const block = next.blocks.find((entry) => entry.id === picked.blockId);
                    const target = block?.kind === "table" ? block.rows.find((entry) => entry.id === picked.rowId) : undefined;
                    if (!target) return false;
                    const cells = { ...(target.cells ?? {}) };
                    if (value) cells[addedColumnKey(column)] = value;
                    else delete cells[addedColumnKey(column)];
                    if (Object.keys(cells).length > 0) target.cells = cells;
                    else delete target.cells;
                  })
                }
              />
            ))}
          <div>
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                setNoteFor({
                  blockId: picked.blockId,
                  row: structuredClone(pickedRow),
                })
              }
            >
              {pickedRow.note ? "Change note" : "Add note"}
            </Button>
          </div>
        </div>
      );
    }
    if (pickedBlock) {
      return (
        <div style={{ display: "grid", gap: 12 }}>
          <strong>{pickedBlock.kind === "table" ? `Table${pickedBlock.title ? `: ${pickedBlock.title}` : ""}` : "Text"}</strong>
          <p className={ui.muted} style={{ margin: 0 }}>
            {pickedBlock.kind === "table"
              ? "Type the table's title above it on the left. Click a row to change it, or use Section to add a heading. Add rows with the buttons under the table."
              : "Type the text on the left."}
          </p>
          <label>
            <input type="checkbox" checked={Boolean(pickedBlock.pageBreakAfter)} disabled={busy} onChange={(event) => flag("pageBreakAfter", event.target.checked)} /> New page
            after this {pickedBlock.kind === "table" ? "table" : "text"}
          </label>
        </div>
      );
    }
    return (
      <p className={ui.muted}>
        Click a row, table, text or column heading on the left to change it here. The toolbar adds text, tables, sections and page breaks after what&apos;s picked.
      </p>
    );
  })();
  const previewPanel = (
    <div style={{ display: "grid", gap: 12, fontSize: "var(--text-sm)" }}>
      <strong>{layout.title}</strong>
      <span className={ui.muted}>{periodSummary(figures)}</span>
      {figures.blocks.map((block) =>
        block.kind === "table" ? (
          <div key={block.id}>
            {block.title ? <strong>{block.title}</strong> : null}
            <CustomFiguresTable id={`preview-${block.id}`} block={block} figures={figures} filter={layout.filter ?? null} />
          </div>
        ) : (
          <p key={block.id} className={ui.reportNote}>
            {block.text}
          </p>
        ),
      )}
      <span className={ui.muted}>{draft ? "With your changes, not saved yet." : "As saved."}</span>
    </div>
  );
  const canvas = (
    <article className={ui.reportPaper}>
      <header className={ui.statementHeading}>
        {editable ? (
          <input
            data-print="hide"
            className={ui.reportTitleInput}
            aria-label="Report title"
            value={titleValue}
            maxLength={CUSTOM_REPORT_LIMITS.titleLength}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => {
              if (titleValue.trim() && titleValue.trim() !== layout.title) change((next) => void (next.title = titleValue.trim()));
              else setTitle(null);
            }}
          />
        ) : null}
        <h2 className={`${ui.statementTitle} ${editable ? ui.printOnly : ""}`}>{layout.title}</h2>
        <p className={ui.statementOrg}>{current?.displayName}</p>
        <p>{periodSummary(figures)}</p>
        {figures.filterLabel ? <p>Only lines tagged {figures.filterLabel}</p> : null}
      </header>
      {figures.blocks.map((block) => (
        <Fragment key={block.id}>
          <section
            className={`${ui.reportPaperBlock} ${editable && picked?.kind === "block" && picked.blockId === block.id ? ui.layoutBlockSelected : ""} ${block.pageBreakAfter ? ui.pageBreakAfter : ""}`}
            {...(block.pageBreakAfter ? { "data-block-page-break": "after" } : {})}
            onClick={
              editable
                ? (event) => {
                    // A click on a row picks the row (the table handles it); anywhere else in the block picks the block.
                    if (event.target instanceof Element && event.target.closest("tbody tr, thead th, input, button, a, select, textarea, label")) return;
                    setEditing(null);
                    setPicked({ kind: "block", blockId: block.id });
                    setSideTab("details");
                  }
                : undefined
            }
          >
            {editable ? (
              <div className={ui.blockTools} data-print="hide">
                <span className={ui.muted}>{block.kind === "table" ? "Table" : "Text"}</span>
              </div>
            ) : null}
            {block.kind === "table" ? (
              <ReportTable
                key={`${block.id}:${report.version}:${draft ? "d" : "s"}`}
                block={block}
                figures={figures}
                layoutBlock={tableBlocks.get(block.id)}
                editable={editable}
                busy={busy}
                onChange={(apply) => change(apply)}
                onEditRow={(row, isNew) => {
                  setSideTab("details");
                  setEditing({ kind: "row", blockId: block.id, row, isNew });
                }}
                onEditNote={(row) => setNoteFor({ blockId: block.id, row })}
                onError={setError}
                filter={layout.filter ?? null}
                onPick={(rowId) => {
                  setEditing(null);
                  setPicked({ kind: "row", blockId: block.id, rowId });
                  setSideTab("details");
                }}
                pickedRowId={picked?.kind === "row" && picked.blockId === block.id ? picked.rowId : null}
                onPickColumns={() => {
                  setEditing(null);
                  setPicked({ kind: "columns" });
                  setSideTab("details");
                }}
              />
            ) : (
              <NoteBlock
                key={`${block.id}:${report.version}`}
                block={block}
                editable={editable}
                busy={busy}
                onSave={(text) =>
                  change((next) => {
                    const note = next.blocks.find((entry) => entry.id === block.id) as Extract<ReportBlock, { kind: "text" }>;
                    note.text = text;
                  })
                }
              />
            )}
          </section>
          {editable && block.pageBreakAfter ? (
            <div className={ui.layoutPageBreakMark} data-print="hide">
              Page break
            </div>
          ) : null}
        </Fragment>
      ))}
      {figures.blocks.length === 0 ? <Empty>This report has no tables or notes.</Empty> : null}
      <ReportWarnings figures={figures} />
      <p className={ui.reportPaperFooter}>
        {report.kind === "published" ? `Published ${formatDateTime(report.publishedAt)}.` : `Worked out ${formatDateTime(figures.computedAt)} from the ledger.`}
      </p>
    </article>
  );
  const more: MoreMenuItem[] = [
    ...(editable
      ? [
          { label: "Save as…", onSelect: () => setSaveAs(true) },
          isDefault
            ? {
                label: `Stop using as the ${baseName} layout`,
                onSelect: () => void setDefault(false),
              }
            : {
                label: `Set as default layout for the ${baseName}`,
                disabled: Boolean(draft),
                onSelect: () => void setDefault(true),
              },
          {
            label: "Publish",
            disabled: Boolean(draft),
            onSelect: () => void publish(),
          },
        ]
      : []),
    { label: "Print", onSelect: () => window.print() },
    ...(can("bookkeeper")
      ? [
          {
            label: report.archivedAt ? "Bring back" : "Archive",
            onSelect: () => void setArchived(!report.archivedAt),
          },
        ]
      : []),
    ...(can("bookkeeper") && report.kind === "draft" ? [{ label: "Delete draft", danger: true, onSelect: () => void remove() }] : []),
  ];

  return (
    <>
      <div className={ui.actions} data-print="hide">
        <Link href={`/operations/reports?view=${report.archivedAt ? "archived" : report.kind === "published" ? "published" : "drafts"}`}>← Reports</Link>
        {report.kind === "published" ? <Badge tone="blue">Published</Badge> : <Badge>Draft</Badge>}
        {report.archivedAt ? <Badge tone="amber">Archived</Badge> : null}
        {isDefault ? <Badge tone="green">Default {baseName} layout</Badge> : null}
        {draft ? <Badge tone="amber">Unsaved changes</Badge> : null}
      </div>
      <div data-print="hide">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {message ? <Notice tone="success">{message}</Notice> : null}
      </div>
      {report.kind === "published" ? (
        <div data-print="hide">
          <Notice tone="info">
            A frozen copy, published {formatDateTime(report.publishedAt)} by {personName(report, "publishedBy")}. Its figures are as they were then and never change.
            {report.publishedFromId ? (
              <>
                {" "}
                <Link href={pageHref(report.publishedFromId)}>Open its draft</Link>
              </>
            ) : null}
          </Notice>
        </div>
      ) : null}
      {editable ? (
        <div className={ui.layoutToolbar} data-print="hide" role="toolbar" aria-label="Layout tools">
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() => insertBlock({ id: newLayoutId("n"), kind: "text", text: "Notes" })}
            title="Add a text block after what's picked"
          >
            Text
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              insertBlock({
                id: newLayoutId("t"),
                kind: "table",
                title: "New table",
                rows: [],
              })
            }
            title="Add a table after what's picked"
          >
            Table
          </Button>
          <Button size="small" variant="secondary" disabled={busy} onClick={addSection} title="Add a section heading after the picked row">
            Section
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setNoteFor(null);
              setPicked({ kind: "columns" });
              setSideTab("details");
            }}
            title="Change the columns"
          >
            Columns
          </Button>
          <Button size="small" variant="secondary" disabled={busy} onClick={togglePageBreak} title="Start a new page after what's picked">
            Page break
          </Button>
          <span className={ui.layoutToolbarRule} aria-hidden="true" />
          <Button size="small" variant="secondary" disabled={busy || !picked || picked.kind === "columns"} onClick={() => movePicked(-1)} aria-label="Move up" title="Move up">
            ↑
          </Button>
          <Button size="small" variant="secondary" disabled={busy || !picked || picked.kind === "columns"} onClick={() => movePicked(1)} aria-label="Move down" title="Move down">
            ↓
          </Button>
          <Button size="small" variant="secondary" disabled={busy || !picked || picked.kind === "columns"} onClick={() => void deletePicked()} aria-label="Delete" title="Delete">
            ✕
          </Button>
          <span className={ui.layoutToolbarRule} aria-hidden="true" />
          <ExportMenu
            organisationId={organisationId}
            report="custom-report"
            title={report.title}
            period={periodSummary(figures)}
            filters={figures.filterLabel ? [`Only lines tagged ${figures.filterLabel}`] : []}
            style="statement"
            tables={exportTables}
          />
          <div className={ui.layoutToolbarEnd}>
            {busy ? <span className={ui.muted}>Working…</span> : null}
            <FavouriteButton organisationId={organisationId} reportKey={`custom:${report.id}`} name={report.title} />
            <MoreMenu label="More report actions" items={more} />
            <Button size="small" variant="secondary" disabled={busy || !draft} onClick={cancelChanges}>
              Cancel
            </Button>
            <Button size="small" disabled={busy || !draft} onClick={() => void save()}>
              {busy ? "Saving…" : "Update layout"}
            </Button>
          </div>
        </div>
      ) : null}
      {editable ? null : (
        <div className={ui.toolbar} data-print="hide" role="group" aria-label="Report actions">
          <FavouriteButton organisationId={organisationId} reportKey={`custom:${report.id}`} name={report.title} />
          <MoreMenu label="More report actions" items={more} />
          {editable ? null : (
            <ExportMenu
              organisationId={organisationId}
              report="custom-report"
              title={report.title}
              period={periodSummary(figures)}
              filters={figures.filterLabel ? [`Only lines tagged ${figures.filterLabel}`] : []}
              style="statement"
              tables={exportTables}
            />
          )}
          {busy ? <span className={ui.muted}>Working…</span> : null}
        </div>
      )}

      {saveAs ? <SaveAsForm initial={`${layout.title} (copy)`} busy={busy} onCancel={() => setSaveAs(false)} onSave={(name) => void copy(name)} /> : null}
      {editable ? null : editorsPanel}
      {editable ? (
        <div className={ui.layoutEditor}>
          {canvas}
          <aside className={ui.layoutSide} data-print="hide" aria-label="Details">
            <div className={ui.tabs} role="tablist" aria-label="Side panel">
              <button
                type="button"
                role="tab"
                aria-selected={sideTab === "details"}
                className={`${ui.tab} ${sideTab === "details" ? ui.tabActive : ""}`}
                onClick={() => setSideTab("details")}
              >
                Details
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sideTab === "preview"}
                className={`${ui.tab} ${sideTab === "preview" ? ui.tabActive : ""}`}
                onClick={() => setSideTab("preview")}
              >
                Preview
              </button>
            </div>
            <div style={{ marginTop: 12 }}>{sideTab === "details" ? details : previewPanel}</div>
          </aside>
        </div>
      ) : (
        canvas
      )}
    </>
  );
}
