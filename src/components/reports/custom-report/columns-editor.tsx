"use client";

import { isReportRounding,REPORT_ROUNDINGS } from "@/lib/reports/rounding";
import { useState } from "react";
import { DateInput } from "@/components/date-input";
import { reportCategories } from "@/components/tracking";
import { Button,Card,Field,Notice,ui } from "@/components/ui";
import {
CUSTOM_REPORT_LIMITS,
type CustomReportBase,lastDayOfMonth,newLayoutId,
PERIOD_LENGTHS,
type PeriodLength,type ReportColumnsSetting,
type AddedColumn,
type AddedColumnKind,
ADDED_COLUMN_KINDS,
addedColumnKey,type ReportTrackingFilter
} from "@/lib/reports/custom-layout";
import type { TrackingSetup } from "@/lib/tracking/service";
import type { Budget } from "@/lib/budgets/service";
import { MoreMenu } from "@/components/more-menu";

export function ColumnsEditor({
  base,
  initial,
  initialFilter,
  tracking,
  budgets,
  rows,
  busy,
  onSave,
  onCancel,
}: {
  base: CustomReportBase;
  initial: ReportColumnsSetting;
  initialFilter: ReportTrackingFilter | null;
  tracking: TrackingSetup | null;
  budgets: Budget[];
  /** The report's rows, for a Percentage column (LE8). */
  rows: Array<{ id: string; label: string }>;
  busy: boolean;
  onSave: (setting: ReportColumnsSetting, filter: ReportTrackingFilter | null) => void;
  onCancel: () => void;
}) {
  const [setting, setSetting] = useState(initial);
  const [filter, setFilter] = useState(initialFilter ? `${initialFilter.categoryId}:${initialFilter.valueId}` : "");
  const [error, setError] = useState<string | null>(null);
  // Only a profit and loss can be filtered: balance sheet lines (AR, AP, GST, bank) aren't tagged (TC8).
  const categories = base === "profit_and_loss" ? reportCategories(tracking) : [];
  function save() {
    if (setting.difference && setting.periodCount < 2) return setError("A difference needs at least two period columns.");
    const [categoryId, valueId] = filter.split(":");
    const { budgetId, budgetDifference, ...rest } = setting;
    onSave(
      {
        ...rest,
        percent: setting.difference && setting.percent,
        yearToDate: base === "profit_and_loss" && setting.yearToDate,
        // A budget column for the first period (BU7), profit and loss only.
        ...(base === "profit_and_loss" && budgetId ? { budgetId, budgetDifference: Boolean(budgetDifference) } : {}),
      },
      filter && categoryId && valueId ? { categoryId, valueId } : null,
    );
  }
  return (
    <Card title="Columns" description="Whole months, quarters or years, newest first, ending on a month end.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label={base === "balance_sheet" ? "Newest column is as at the end of" : "Newest column ends with"}>
          <input
            type="month"
            value={setting.periodEnd.slice(0, 7)}
            onChange={(event) =>
              event.target.value &&
              setSetting({
                ...setting,
                periodEnd: lastDayOfMonth(`${event.target.value}-01`),
              })
            }
            required
          />
        </Field>
        <Field label="Each column is">
          <select
            value={setting.periodLength}
            onChange={(event) =>
              setSetting({
                ...setting,
                periodLength: event.target.value as PeriodLength,
              })
            }
          >
            {(Object.keys(PERIOD_LENGTHS) as PeriodLength[]).map((length) => (
              <option key={length} value={length}>
                {
                  {
                    month: "A month",
                    quarter: "A quarter (3 months)",
                    year: "A year (12 months)",
                  }[length]
                }
              </option>
            ))}
          </select>
        </Field>
        <Field label="How many columns">
          <input
            type="number"
            min={1}
            max={CUSTOM_REPORT_LIMITS.periods}
            value={setting.periodCount}
            onChange={(event) =>
              setSetting({
                ...setting,
                periodCount: Math.max(1, Math.min(CUSTOM_REPORT_LIMITS.periods, Number(event.target.value) || 1)),
              })
            }
          />
        </Field>
      </div>
      <Field label="Rounding" hint="Rounded reports always add up: each line is rounded and every total is added from the rounded lines above it.">
        <select
          value={setting.rounding ?? "none"}
          onChange={(event) => {
            const { rounding: _was, ...rest } = setting;
            void _was;
            setSetting(isReportRounding(event.target.value) ? { ...rest, rounding: event.target.value } : rest);
          }}
        >
          <option value="none">To the cent</option>
          {Object.entries(REPORT_ROUNDINGS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <div className={ui.actions}>
        <label className={ui.checkbox}>
          <input type="checkbox" checked={setting.difference} onChange={(event) => setSetting({ ...setting, difference: event.target.checked })} /> Difference (newest less the one
          before)
        </label>
        <label className={ui.checkbox}>
          <input
            type="checkbox"
            checked={setting.difference && setting.percent}
            disabled={!setting.difference}
            onChange={(event) => setSetting({ ...setting, percent: event.target.checked })}
          />{" "}
          % change
        </label>
        {base === "profit_and_loss" ? (
          <label className={ui.checkbox}>
            <input type="checkbox" checked={setting.yearToDate} onChange={(event) => setSetting({ ...setting, yearToDate: event.target.checked })} /> Year to date
          </label>
        ) : null}
      </div>
      {categories.length > 0 || filter ? (
        <Field label="Only lines tagged" hint="Counts only lines tagged with this value or a value under it.">
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="">Everything (no filter)</option>
            {categories.map((category) => (
              <optgroup key={category.id} label={category.name}>
                {category.values
                  .filter((value) => value.isActive || filter === `${category.id}:${value.id}`)
                  .map((value) => (
                    <option key={value.id} value={`${category.id}:${value.id}`}>
                      {category.name}: {value.path}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </Field>
      ) : null}
      {base === "profit_and_loss" ? (
        <div className={ui.grid3}>
          <Field label="Budget column" hint="The budget for the first (newest) period.">
            <select
              value={setting.budgetId ?? ""}
              onChange={(event) =>
                setSetting({
                  ...setting,
                  budgetId: event.target.value || undefined,
                })
              }
            >
              <option value="">No budget column</option>
              {budgets
                .filter((budget) => !budget.archivedAt || budget.id === setting.budgetId)
                .map((budget) => (
                  <option key={budget.id} value={budget.id}>
                    {budget.name}
                    {budget.trackingLabel ? ` (${budget.trackingLabel})` : ""}
                  </option>
                ))}
            </select>
          </Field>
          <label className={ui.checkbox}>
            <input
              type="checkbox"
              checked={Boolean(setting.budgetId && setting.budgetDifference)}
              disabled={!setting.budgetId}
              onChange={(event) =>
                setSetting({
                  ...setting,
                  budgetDifference: event.target.checked,
                })
              }
            />{" "}
            Actual less budget
          </label>
        </div>
      ) : null}
      <AddedColumnsEditor base={base} setting={setting} rows={rows} budgets={budgets} onChange={(added) => setSetting({ ...setting, added })} />
      <div className={ui.actions}>
        <Button onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save columns"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

/** The columns a column added at `index` can use (LE4): the usual ones, then money columns added before it. */
function usableColumns(setting: ReportColumnsSetting, index: number): Array<{ key: string; label: string }> {
  const out = Array.from({ length: setting.periodCount }, (_, at) => ({ key: `p${at}`, label: at === 0 ? "Newest period" : `Period ${at + 1} (earlier)` }));
  if (setting.difference) out.push({ key: "diff", label: "Difference" });
  if (setting.yearToDate) out.push({ key: "ytd", label: "Year to date" });
  if (setting.budgetId) out.push({ key: "bud", label: "Budget" });
  if (setting.budgetId && setting.budgetDifference) out.push({ key: "bdiff", label: "Actual less budget" });
  for (const column of (setting.added ?? []).slice(0, index)) {
    if (column.kind === "date" || column.kind === "budget" || column.kind === "formula" || (column.kind === "variance" && !column.percentOfSecond)) {
      out.push({ key: addedColumnKey(column), label: column.heading || ADDED_COLUMN_KINDS[column.kind] });
    }
  }
  return out;
}

/** Add column (LE4-LE9): Date, Budget, Formula, Notes, Percentage and Variance columns after the usual ones. */
function AddedColumnsEditor({
  base,
  setting,
  rows,
  budgets,
  onChange,
}: {
  base: CustomReportBase;
  setting: ReportColumnsSetting;
  rows: Array<{ id: string; label: string }>;
  budgets: Budget[];
  onChange: (added: AddedColumn[]) => void;
}) {
  const added = setting.added ?? [];
  const monthStart = `${setting.periodEnd.slice(0, 7)}-01`;
  const kinds = (Object.keys(ADDED_COLUMN_KINDS) as AddedColumnKind[]).filter((kind) => base === "profit_and_loss" || kind !== "budget");
  const update = (index: number, column: AddedColumn) => onChange(added.map((entry, at) => (at === index ? column : entry)));
  function add(kind: AddedColumnKind) {
    const id = newLayoutId("c");
    const from = base === "balance_sheet" ? null : monthStart;
    const column: AddedColumn =
      kind === "date"
        ? { id, kind, from, to: setting.periodEnd }
        : kind === "budget"
          ? { id, kind, budgetId: budgets.find((budget) => !budget.archivedAt)?.id ?? "", from: monthStart, to: setting.periodEnd }
          : kind === "formula"
            ? { id, kind, terms: [{ column: "p0", sign: 1 }] }
            : kind === "notes"
              ? { id, kind }
              : kind === "percentage"
                ? { id, kind, column: "p0", ofRowId: rows[0]?.id ?? "" }
                : { id, kind, first: "p0", second: setting.periodCount > 1 ? "p1" : "p0" };
    onChange([...added, column]);
  }
  const columnSelect = (index: number, value: string, label: string, set: (value: string) => void) => (
    <Field label={label}>
      <select value={value} onChange={(event) => set(event.target.value)}>
        {usableColumns(setting, index).map((entry) => (
          <option key={entry.key} value={entry.key}>
            {entry.label}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
      {added.map((column, index) => (
        <div key={column.id} style={{ display: "grid", gap: 8, padding: 12, border: "1px solid var(--border)", borderRadius: 6 }}>
          <strong>{ADDED_COLUMN_KINDS[column.kind]} column</strong>
          <Field label="Heading" hint="Blank uses a heading of its own.">
            <input value={column.heading ?? ""} maxLength={CUSTOM_REPORT_LIMITS.labelLength} onChange={(event) => update(index, { ...column, heading: event.target.value || undefined })} />
          </Field>
          {column.kind === "date" || column.kind === "budget" ? (
            <>
              {column.kind === "budget" ? (
                <Field label="Budget">
                  <select value={column.budgetId} onChange={(event) => update(index, { ...column, budgetId: event.target.value })}>
                    <option value="">Choose a budget</option>
                    {budgets
                      .filter((budget) => !budget.archivedAt || budget.id === column.budgetId)
                      .map((budget) => (
                        <option key={budget.id} value={budget.id}>
                          {budget.name}
                        </option>
                      ))}
                  </select>
                </Field>
              ) : null}
              {column.from !== null ? (
                <Field label="From">
                  <DateInput value={column.from} onChange={(event) => update(index, { ...column, from: event.target.value } as AddedColumn)} />
                </Field>
              ) : null}
              <Field label={column.from === null ? "As at" : "To"}>
                <DateInput value={column.to} onChange={(event) => update(index, { ...column, to: event.target.value })} />
              </Field>
            </>
          ) : null}
          {column.kind === "formula" ? (
            <>
              {column.terms.map((term, at) => (
                <div key={at} className={ui.actions}>
                  <select
                    aria-label="Add or take away"
                    value={term.sign}
                    onChange={(event) => update(index, { ...column, terms: column.terms.map((entry, k) => (k === at ? { ...entry, sign: Number(event.target.value) as 1 | -1 } : entry)) })}
                  >
                    <option value={1}>+ add</option>
                    <option value={-1}>− take away</option>
                  </select>
                  <select
                    aria-label="Column"
                    value={term.column}
                    onChange={(event) => update(index, { ...column, terms: column.terms.map((entry, k) => (k === at ? { ...entry, column: event.target.value } : entry)) })}
                  >
                    {usableColumns(setting, index).map((entry) => (
                      <option key={entry.key} value={entry.key}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                  <Button size="small" variant="secondary" onClick={() => update(index, { ...column, terms: column.terms.filter((_, k) => k !== at) })}>
                    Remove
                  </Button>
                </div>
              ))}
              <div>
                <Button size="small" variant="secondary" onClick={() => update(index, { ...column, terms: [...column.terms, { column: "p0", sign: 1 }] })}>
                  Add a column to it
                </Button>
              </div>
            </>
          ) : null}
          {column.kind === "notes" ? <p className={ui.muted} style={{ margin: 0 }}>Type each row&apos;s text in its Details.</p> : null}
          {column.kind === "percentage" ? (
            <>
              {columnSelect(index, column.column, "Column", (value) => update(index, { ...column, column: value }))}
              <Field label="As a % of the row">
                <select value={column.ofRowId} onChange={(event) => update(index, { ...column, ofRowId: event.target.value })}>
                  {rows.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.label}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : null}
          {column.kind === "variance" ? (
            <>
              {columnSelect(index, column.first, "First column", (value) => update(index, { ...column, first: value }))}
              {columnSelect(index, column.second, "Second column", (value) => update(index, { ...column, second: value }))}
              <label className={ui.checkbox}>
                <input type="checkbox" checked={Boolean(column.percentOfSecond)} onChange={(event) => update(index, { ...column, percentOfSecond: event.target.checked || undefined })} /> % of second
              </label>
            </>
          ) : null}
          <div>
            <Button size="small" variant="secondary" onClick={() => onChange(added.filter((_, at) => at !== index))}>
              Remove this column
            </Button>
          </div>
        </div>
      ))}
      {added.length < CUSTOM_REPORT_LIMITS.addedColumns ? (
        <div>
          <MoreMenu label="Add column" text="Add column" items={kinds.map((kind) => ({ label: ADDED_COLUMN_KINDS[kind], onSelect: () => add(kind) }))} />
        </div>
      ) : null}
    </div>
  );
}
