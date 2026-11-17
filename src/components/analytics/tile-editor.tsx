"use client";

import { DateInput } from "@/components/date-input";
import Link from "next/link";
import { useContext,useState } from "react";
import { ChartFormatPanel } from "@/components/analytics/chart-format-panel";
import { KeyFigureSettings } from "@/components/analytics/key-figure-settings";
import { FormulaField,SavedValuesPicker,SaveValueButton,ValueKindFields,ValueMeaning,ValueRules } from "@/components/analytics/saved-values";
import { type TileSwitches } from "@/lib/analytics/parameters";
import { SwitchSettings } from "@/components/analytics/parameter-controls";
import { CalculatedFieldsPanel } from "@/components/analytics/calculated-fields-panel";
import { RelationshipsPanel } from "@/components/analytics/relationships-panel";
import { FieldSettingsPanel } from "@/components/analytics/field-settings-panel";
import { PeriodField,QuickCalcField,quickChoices,quickLabel } from "@/components/analytics/quick-calc-field";
import { TileFilters } from "@/components/analytics/tile-filters";
import { Badge,Button,Field,Notice,ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { formatOptionsFor,mergeFormats,SECOND_GROUPING,SECOND_GROUPING_REQUIRED,VISUAL_NAMES,type ChartFormat,type DefaultableVisual,type VisualDefaults } from "@/lib/analytics/chart-format";
import { tileValueNames } from "@/lib/analytics/tile-chart";
import { chartGroupNames,datedGroups } from "@/lib/analytics/chart-spec";
import { useTileResult } from "@/components/analytics/use-tile-result";
import { isItemVisual } from "@/lib/analytics/items";
import { PanelTabs } from "@/components/analytics/panel-tabs";
import { effectiveDates,type TileDates } from "@/lib/analytics/report-filters";
import { isSpecialistVisual,PANEL_TAB_LABELS,PANEL_TABS,type PanelTab } from "@/lib/analytics/editor-panels";
import { dateHierarchy,DRILLABLE,INTERACTION_LABELS,INTERACTION_MODES,MAX_DRILL_LEVELS,type InteractionMode,type TileDrill } from "@/lib/analytics/report-view";
import type { ReportTheme } from "@/lib/charts/report-themes";
import type { Tile } from "@/lib/analytics/dashboards";
import { HEIGHT_LABELS,TILE_HEIGHTS,TILE_WIDTHS,WIDTH_LABELS,type TileHeight,type TileWidth } from "@/lib/analytics/layout";
import type {
Aggregate,ColumnInfo,
Grain,
Measure,PivotDimension,
PivotGrain,TileQuery,
Visual
} from "@/lib/analytics/query";
import { DATE_PRESETS,isDatePreset } from "@/lib/analytics/date-ranges";
import { filterComplete } from "@/lib/analytics/filters";
import { changeMeasure,fieldLabel,measureLabel,tableDescription,tableLabel } from "@/lib/analytics/labels";
import { todayInBrowser } from "@/lib/format";
import styles from "@/components/analytics-dashboards.module.css";
import { AGGREGATES,Filters,GRAINS,PIVOT_GRAINS,TableInfo,VISUALS,YearEndMonth,columnOptions,fieldFolders,isDate,isNumber } from "@/components/analytics/report-shared";
import { TileResult } from "@/components/analytics/tile-body";

function blankQuery(table: TableInfo | undefined): TileQuery {
  const date = table?.columns.find((column) => isDate(column.type));
  const text = table?.columns.find((column) => !isDate(column.type) && !isNumber(column.type));
  const money = table?.columns.find((column) => /^DECIMAL\(\d+,2\)$/.test(column.type)) ?? table?.columns.find((column) => isNumber(column.type));
  return {
    table: table?.name ?? "",
    groupBy: date ? { field: date.name, grain: "month" } : text ? { field: text.name } : null,
    pivot: null,
    measures: [money ? { label: "", aggregate: "sum" as const, field: money.name } : { label: "", aggregate: "count" as const }].map((measure) => ({
      ...measure,
      label: measureLabel(measure, table?.name ?? ""),
    })),
    filters: [],
    dateField: date?.name ?? null,
    sort: { by: "category", direction: "asc" },
    limit: null,
  };
}

/** A second grouping inside the first, for the chart types that use one. */
function SecondGrouping({ visual, query, columns, onChange }: { visual: Visual; query: TileQuery; columns: ColumnInfo[]; onChange: (query: TileQuery) => void }) {
  const setting = SECOND_GROUPING[visual];
  if (!setting || !query.groupBy) return null;
  const type = columns.find((column) => column.name === query.breakdown?.field)?.type ?? "";
  return (
    <>
      <Field label={setting.label} hint={setting.hint}>
        <select
          value={query.breakdown?.field ?? ""}
          onChange={(event) => {
            const field = event.target.value;
            const fieldType = columns.find((column) => column.name === field)?.type ?? "";
            onChange({ ...query, breakdown: field ? { field, ...(isDate(fieldType) ? { grain: "month" as Grain } : {}) } : null, measures: query.measures.map((measure) => ({ ...measure, compare: undefined })) });
          }}
        >
          {setting.none ? <option value="">{setting.none}</option> : <option value="">Choose a field</option>}
          {columnOptions(columns.filter((column) => column.name !== query.groupBy?.field || isDate(column.type)))}
        </select>
      </Field>
      {query.breakdown && isDate(type) ? (
        <Field label="By">
          <select aria-label={`${setting.label} by`} value={query.breakdown.grain ?? "month"} onChange={(event) => onChange({ ...query, breakdown: { field: query.breakdown!.field, grain: event.target.value as Grain } })}>
            {GRAINS.map((grain) => <option key={grain.value} value={grain.value}>{grain.label}</option>)}
          </select>
        </Field>
      ) : null}
    </>
  );
}

/** A chart's drill-down levels: dates by financial or calendar year, or fields one inside another. */
function DrillSettings({ drill, usable, query, columns, onChange }: { drill: TileDrill | undefined; usable: boolean; query: TileQuery; columns: ColumnInfo[]; onChange: (drill: TileDrill | undefined) => void }) {
  const groupField = query.groupBy?.field ?? "";
  const dated = isDate(columns.find((column) => column.name === groupField)?.type ?? "");
  const kind = !drill ? "" : drill.levels[0].grain === "fyear" ? "fyear" : drill.levels[0].grain ? "year" : "fields";
  const choose = (value: string) => {
    if (!value) return onChange(undefined);
    if (value === "fyear" || value === "year") return onChange({ levels: dateHierarchy(groupField, value === "fyear") });
    const next = columns.find((column) => column.name !== groupField && !isNumber(column.type));
    onChange({ levels: [{ field: groupField, ...(query.groupBy?.grain ? { grain: query.groupBy.grain } : {}) }, ...(next ? [{ field: next.name, ...(isDate(next.type) ? { grain: "month" as Grain } : {}) }] : [])] });
  };
  return (
    <fieldset className={styles.sizeFields}>
      <legend>Drill down</legend>
      {!usable ? <p className={ui.muted}>Group the chart by something (with no second grouping) to drill down.</p> : (
        <>
          <Field label="Levels" hint={kind === "fyear" ? "Financial years follow the balance date in Settings, named by the year they end (FY2027)." : "Readers choose Drill down on click, then a group, to see the next level inside it."}>
            <select value={kind} onChange={(event) => choose(event.target.value)}>
              <option value="">None</option>
              {dated ? <option value="fyear">Financial year, quarter, month, day</option> : null}
              {dated ? <option value="year">Calendar year, quarter, month, day</option> : null}
              <option value="fields">{fieldLabel(groupField)}, then other fields</option>
            </select>
          </Field>
          {kind === "fields" && drill ? (
            <>
              {drill.levels.slice(1).map((level, index) => (
                <div key={index} className={styles.pivotField}>
                  <Field label={`Level ${index + 2}`}>
                    <select value={level.field} onChange={(event) => {
                      const column = columns.find((entry) => entry.name === event.target.value);
                      const levels = [...drill.levels];
                      levels[index + 1] = { field: event.target.value, ...(column && isDate(column.type) ? { grain: "month" as Grain } : {}) };
                      onChange({ levels });
                    }}>
                      {columnOptions(columns.filter((column) => !isNumber(column.type) && (column.name === level.field || !drill.levels.some((entry) => entry.field === column.name))))}
                    </select>
                  </Field>
                  <Button size="small" variant="danger" aria-label={`Remove level ${index + 2}`} disabled={drill.levels.length <= 2} onClick={() => onChange({ levels: drill.levels.filter((_entry, at) => at !== index + 1) })}>Remove</Button>
                </div>
              ))}
              <div className={styles.addRow}>
                <Button size="small" variant="secondary" disabled={drill.levels.length >= MAX_DRILL_LEVELS} onClick={() => {
                  const column = columns.find((entry) => !isNumber(entry.type) && !drill.levels.some((level) => level.field === entry.name));
                  if (column) onChange({ levels: [...drill.levels, { field: column.name, ...(isDate(column.type) ? { grain: "month" as Grain } : {}) }] });
                }}>Add a level</Button>
              </div>
            </>
          ) : null}
        </>
      )}
    </fieldset>
  );
}

/** Remembered in this browser only: whether the chart panel shows advanced settings. */
const ADVANCED_KEY = "tohyee.analytics.advancedSettings";
function readAdvanced(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(ADVANCED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Adding or changing a tile, with a live preview. */
export function TileEditor({
  saving,
  organisationId,
  tables,
  tile,
  filters,
  onSave,
  onCancel,
  defaults,
  themeClass,
  theme,
  onSetDefault,
  others = [],
  onTablesChanged,
}: {
  saving: boolean;
  organisationId: string;
  tables: TableInfo[];
  /** A calculated field was added, changed or removed: the tables' columns are read again. */
  onTablesChanged?: () => void;
  tile: Tile | null;
  filters: Filters;
  onSave: (tile: Tile) => void;
  onCancel: () => void;
  /** The report's default look per chart type. */
  defaults?: VisualDefaults;
  /** The report theme's class, so the preview looks like the report. */
  themeClass?: string;
  /** The report's theme, for checking colours chosen on the chart. */
  theme?: ReportTheme;
  onSetDefault?: (visual: DefaultableVisual, format: ChartFormat | undefined) => void;
  /** The page's other tiles, for how a click on this one changes them. */
  others?: Array<{ id: string; title: string }>;
}) {
  const { can } = useWorkspace();
  const [fieldSearch, setFieldSearch] = useState("");
  const [title, setTitle] = useState(tile?.title ?? "");
  const [visual, setVisual] = useState<Visual>(tile && !isItemVisual(tile.visual) ? tile.visual : "column");
  const [width, setWidth] = useState<TileWidth>(tile?.width ?? "half");
  const [height, setHeight] = useState<TileHeight>(tile?.height ?? "medium");
  const [query, setQuery] = useState<TileQuery>(tile?.query ?? blankQuery(tables[0]));
  const [format, setFormat] = useState<ChartFormat | undefined>(tile?.format);
  // Drill-down levels and how clicks change other tiles.
  const [drill, setDrill] = useState<TileDrill | undefined>(tile?.drill);
  const [interactions, setInteractions] = useState<Record<string, InteractionMode>>(tile?.interactions ?? {});
  // Its own dates.
  const [tileDates, setTileDates] = useState<TileDates | undefined>(tile?.dates);
  const [switches, setSwitches] = useState<TileSwitches | undefined>(tile?.switches);
  const yearEndMonth = useContext(YearEndMonth);
  const [savedVersion, setSavedVersion] = useState(0);
  // The panel's tab, specialist chart types and advanced settings.
  const [tab, setTab] = useState<PanelTab>("data");
  const [moreTypes, setMoreTypes] = useState(() => isSpecialistVisual(visual));
  const [advanced, setAdvancedState] = useState(readAdvanced);
  const setAdvanced = (on: boolean) => {
    setAdvancedState(on);
    try {
      window.localStorage.setItem(ADVANCED_KEY, on ? "1" : "0");
    } catch {
      // Not remembered; it still applies to this chart.
    }
  };
  const drillUsable = DRILLABLE.includes(visual) && Boolean(query.groupBy) && !query.breakdown;
  const shownVisuals = VISUALS.filter((entry) => moreTypes || !isSpecialistVisual(entry.value) || entry.value === visual);
  const table = tables.find((entry) => entry.name === query.table);
  const columns = table?.columns ?? [];
  const numbers = columns.filter((column) => isNumber(column.type));
  const groupType = columns.find((column) => column.name === query.groupBy?.field)?.type ?? "";
  const pivotRows = query.pivot?.rows ?? [];
  const subColumns = query.pivot?.subColumns ?? [];
  const usedPivotFields = new Set([...pivotRows.map((dimension) => dimension.field), ...(query.pivot?.column ? [query.pivot.column.field] : []), ...subColumns.map((dimension) => dimension.field)]);
  const preview = useTileResult(organisationId, query.table ? query : null, tileDates && query.dateField ? { ...filters, ...effectiveDates(tileDates, filters, todayInBrowser(), yearEndMonth) } as Filters : filters, undefined, visual === "table" && format?.table?.totals === true);
  // The preview's groups, for colouring a group and limiting a date axis.
  const groupValues = preview?.result && query.groupBy ? preview.result.rows.map((row) => row.category) : null;

  // A label Tohyee filled in follows the value's column and calculation; a typed one stays.
  const setMeasure = (index: number, patch: Partial<Measure>) =>
    setQuery({ ...query, measures: query.measures.map((measure, at) => (at === index ? changeMeasure(measure, patch, query.table) : measure)) });
  const changeVisual = (next: Visual) => {
    if (next === "pivot") {
      const current = query.groupBy;
      const field = current?.field ?? columns[0]?.name;
      const fieldType = columns.find((column) => column.name === field)?.type ?? "";
      const dimension = field
        ? { field, ...(isDate(fieldType) ? { grain: current?.grain === "quarter" || current?.grain === "year" ? current.grain : "month" as const } : {}) }
        : null;
      setQuery({
        ...query,
        groupBy: null,
        pivot: { rows: dimension ? [dimension] : [], column: null },
        measures: query.measures.map((measure) => ({
          ...measure,
          ...(measure.aggregate === "count_distinct" ? { aggregate: "count" as const } : {}),
          compare: undefined,
        })),
      });
    } else if (visual === "pivot" && query.pivot) {
      const first = query.pivot.rows[0];
      setQuery({
        ...query,
        pivot: null,
        groupBy: first ? { field: first.field, ...(first.grain ? { grain: first.grain } : {}) } : null,
      });
    }
    if (query.breakdown && !SECOND_GROUPING[next]) {
      // Only some chart types use a second grouping.
      setQuery((current) => ({ ...current, breakdown: null }));
    }
    if (SECOND_GROUPING_REQUIRED.includes(next) && !query.breakdown) {
      // A heat map or Sankey needs a second grouping: start with the first other text field.
      const first = query.groupBy ?? (columns[0] ? { field: columns[0].name } : null);
      const other = columns.find((column) => column.name !== first?.field && !isDate(column.type) && !isNumber(column.type)) ?? columns.find((column) => column.name !== first?.field);
      if (first && other) {
        setQuery((current) => ({
          ...current,
          groupBy: current.groupBy ?? first,
          breakdown: { field: other.name, ...(isDate(other.type) ? { grain: "month" as Grain } : {}) },
          measures: current.measures.map((measure) => ({ ...measure, compare: undefined })),
        }));
      }
    }
    if (next === "calendar") {
      // A calendar heat map is grouped by a date, by day.
      const date = columns.find((column) => column.name === query.groupBy?.field && isDate(column.type)) ?? columns.find((column) => isDate(column.type));
      if (date) setQuery((current) => ({ ...current, groupBy: { field: date.name, grain: "day" }, breakdown: null, measures: current.measures.map((measure) => ({ ...measure, compare: undefined })) }));
    }
    if (next === "filledmap") {
      // A filled map is grouped by a region or district name: start with a field called that, one value.
      const area = columns.find((column) => !isNumber(column.type) && /region|district|territor|council|city/i.test(column.name));
      setQuery((current) => ({
        ...current,
        groupBy: area && !current.groupBy ? { field: area.name } : current.groupBy,
        measures: current.measures.slice(0, 1).map((measure) => ({ ...measure, compare: undefined })),
      }));
    }
    if (next === "pointmap") {
      // A map with points needs a latitude and a longitude (the average of each group's), then a value to size them.
      const latitude = columns.find((column) => isNumber(column.type) && /^(lat|latitude)$|latitude/i.test(column.name));
      const longitude = columns.find((column) => isNumber(column.type) && /^(lon|lng|long|longitude)$|longitude/i.test(column.name));
      if (latitude && longitude && !(query.measures[0]?.field === latitude.name && query.measures[1]?.field === longitude.name)) {
        setQuery((current) => ({
          ...current,
          measures: [
            { label: "Latitude", aggregate: "avg", field: latitude.name },
            { label: "Longitude", aggregate: "avg", field: longitude.name },
            ...current.measures.filter((measure) => measure.field !== latitude.name && measure.field !== longitude.name).slice(0, 1).map((measure) => ({ ...measure, compare: undefined })),
          ],
        }));
      }
    }
    if (next === "gauge" && query.groupBy) {
      // A gauge shows one total.
      setQuery((current) => ({ ...current, groupBy: null, measures: current.measures.map((measure) => ({ ...measure, compare: undefined })) }));
    }
    if (visual === "kpi" && next !== "kpi") {
      // The previous period, a target and the trend belong to key figures.
      setQuery((current) => ({
        ...current,
        sparkline: undefined,
        measures: current.measures.map((measure) => (measure.compare === "previous_period" ? { ...measure, compare: undefined } : measure)),
      }));
    }
    setVisual(next);
  };

  return (
    <section className={styles.editor} aria-label="Chart editor">
      <aside className={styles.fieldsPanel}>
        <h2>Data</h2><p className={ui.muted}>Fields in the selected source</p>
        <Field label="Search fields"><input type="search" value={fieldSearch} onChange={(event) => setFieldSearch(event.target.value)} placeholder="Find a field…" /></Field>
        <div className={styles.fieldList}>
          {/* Fields by their folder, with their descriptions; fields without a folder first. */}
          {fieldFolders(columns.filter((column) => `${column.name} ${fieldLabel(column.name)} ${column.settings?.description ?? ""}`.toLowerCase().includes(fieldSearch.toLowerCase().trim()))).map(([folder, entries]) => (
            <div key={folder || "-"} role="group" aria-label={folder || "Fields"}>
              {folder ? <div className={styles.fieldFolder}>{folder}</div> : null}
              {entries.map((column) => (
                <div className={styles.fieldItem} key={column.name} title={column.settings?.description ?? `${query.table}.${column.name}`}>
                  <span className={styles.fieldType}>{isNumber(column.type) ? "123" : isDate(column.type) ? "Date" : column.type === "BOOLEAN" ? "Y/N" : "ABC"}</span>
                  <span>{fieldLabel(column.name)}<small>{column.settings?.description ?? column.name}</small></span>
                </div>
              ))}
            </div>
          ))}
        </div>
        {!columns.length ? <p>No fields loaded. <Link href="/analytics/sources">Add a data source</Link>.</p> : null}
        {can("admin") ? <Link href="/analytics/shaping">Prepare or combine data →</Link> : null}
      </aside>
      <div className={styles.canvasPanel}>
        <div className={styles.canvasHeading}><span className={styles.eyebrow}>REPORT CANVAS · LIVE PREVIEW</span><h2>{title || "Untitled chart"}</h2><p className={ui.muted}>Using the report’s date range and filters</p></div>
        <div className={styles.visualPicker} role="group" aria-label="Chart type">
          {shownVisuals.map((entry) => <button type="button" key={entry.value} aria-pressed={visual === entry.value} onClick={() => changeVisual(entry.value)}>{entry.label}</button>)}
          <button type="button" className={styles.moreTypes} aria-expanded={moreTypes} onClick={() => setMoreTypes(!moreTypes)}>{moreTypes ? "Fewer chart types" : "More chart types…"}</button>
        </div>
      <h3 className={styles.subheading}>
        Preview {preview?.result?.truncated ? <Badge tone="amber">first 5,000 rows</Badge> : null}
      </h3>
      <div className={`${styles.preview} ${themeClass ?? ""}`}>
        {!preview ? (
          <p className={ui.muted}>Working it out…</p>
        ) : preview.error ? (
          <Notice tone="error">{preview.error}</Notice>
        ) : (
          <TileResult tile={{ title: title || "Preview", visual, format: mergeFormats(defaults?.[visual], format), height, query }} result={preview.result!} />
        )}
      </div>

      </div>
      <aside className={styles.propertiesPanel} aria-label="Chart properties">
        <h2>{tile ? "Chart properties" : "Add a chart"}</h2>
        <fieldset disabled={saving} className={styles.propertyFields}>
      <div className={styles.propertyGrid}>
        <Field label="Title">
          <input value={title} maxLength={100} placeholder="e.g. Sales by month" onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Show as" hint={moreTypes ? undefined : "More chart types (waterfall, maps, Sankey and others) are under the preview."}>
          <select value={visual} onChange={(event) => changeVisual(event.target.value as Visual)}>
            {shownVisuals.filter((entry) => !isSpecialistVisual(entry.value)).map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
            {shownVisuals.some((entry) => isSpecialistVisual(entry.value)) ? (
              <optgroup label="More chart types">
                {shownVisuals.filter((entry) => isSpecialistVisual(entry.value)).map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </Field>
      </div>
      <PanelTabs
        id={`chart-${tile?.id ?? "new"}`}
        label="Chart settings"
        tabs={PANEL_TABS.map((value) => ({ value, label: PANEL_TAB_LABELS[value] }))}
        chosen={tab}
        onChoose={setTab}
        panels={{
          data: (
            <>
      <div className={styles.propertyGrid}>
        <Field label="Data source" hint={tableDescription(query.table) || undefined}>
          <select value={query.table} onChange={(event) => setQuery(blankQuery(tables.find((entry) => entry.name === event.target.value)))}>
            {[...tables].sort((a, b) => tableLabel(a.name).localeCompare(tableLabel(b.name))).map((entry) => (
              <option key={entry.name} value={entry.name} title={entry.name}>
                {tableLabel(entry.name)}
              </option>
            ))}
          </select>
        </Field>
        <CalculatedFieldsPanel organisationId={organisationId} table={query.table} canEdit={can("bookkeeper")} onChanged={() => onTablesChanged?.()} />
        <RelationshipsPanel organisationId={organisationId} table={query.table} tables={tables} canEdit={can("bookkeeper")} onChanged={() => onTablesChanged?.()} />
        <FieldSettingsPanel organisationId={organisationId} table={query.table} columns={columns} canEdit={can("bookkeeper")} onChanged={() => onTablesChanged?.()} />
        {visual === "pivot" ? (
          <>
            {pivotRows.map((dimension, index) => (
              <div className={styles.pivotField} key={index}>
                <Field label={`Pivot row ${index + 1}`}>
                  <select
                    aria-label={`Pivot row ${index + 1}`}
                    value={dimension.field}
                    onChange={(event) => {
                      const field = event.target.value;
                      const type = columns.find((column) => column.name === field)?.type ?? "";
                      const rows = [...pivotRows];
                      rows[index] = { field, ...(isDate(type) ? { grain: "month" } : {}) };
                      setQuery({ ...query, pivot: { ...query.pivot, rows, column: query.pivot?.column ?? null } });
                    }}
                  >
                    {columnOptions(columns.filter((column) => !usedPivotFields.has(column.name) || column.name === dimension.field))}
                  </select>
                </Field>
                {isDate(columns.find((column) => column.name === dimension.field)?.type ?? "") ? (
                  <Field label="Group by">
                    <select
                      aria-label={`Pivot row ${index + 1} date grouping`}
                      value={dimension.grain ?? "month"}
                      onChange={(event) => {
                        const rows = [...pivotRows];
                        rows[index] = { ...dimension, grain: event.target.value as PivotGrain };
                        setQuery({ ...query, pivot: { ...query.pivot, rows, column: query.pivot?.column ?? null } });
                      }}
                    >
                      {PIVOT_GRAINS.map((grain) => <option key={grain.value} value={grain.value}>{grain.label}</option>)}
                    </select>
                  </Field>
                ) : null}
                <Button
                  size="small"
                  variant="danger"
                  aria-label={`Remove pivot row ${index + 1}`}
                  disabled={pivotRows.length === 1}
                  onClick={() => setQuery({ ...query, pivot: { ...query.pivot, rows: pivotRows.filter((_row, at) => at !== index), column: query.pivot?.column ?? null } })}
                >
                  Remove row
                </Button>
              </div>
            ))}
            <div className={styles.addRow}>
              <Button
                size="small"
                variant="secondary"
                disabled={pivotRows.length >= 5 || columns.every((column) => usedPivotFields.has(column.name))}
                onClick={() => {
                  const column = columns.find((entry) => !usedPivotFields.has(entry.name));
                  if (!column) return;
                  setQuery({
                    ...query,
                    pivot: {
                      ...query.pivot,
                      rows: [...pivotRows, { field: column.name, ...(isDate(column.type) ? { grain: "month" as const } : {}) }],
                      column: query.pivot?.column ?? null,
                    },
                  });
                }}
              >
                Add a row field
              </Button>
            </div>
            <Field label="Pivot column">
              <select
                value={query.pivot?.column?.field ?? ""}
                onChange={(event) => {
                  const field = event.target.value;
                  const type = columns.find((column) => column.name === field)?.type ?? "";
                  setQuery({
                    ...query,
                    pivot: {
                      rows: pivotRows,
                      column: field ? { field, ...(isDate(type) ? { grain: "month" as const } : {}) } : null,
                      // Columns inside need an outer one; a field can only be used once.
                      ...(field && subColumns.some((entry) => entry.field !== field) ? { subColumns: subColumns.filter((entry) => entry.field !== field) } : {}),
                    },
                  });
                }}
              >
                <option value="">None</option>
                {columnOptions(columns.filter((column) => !pivotRows.some((row) => row.field === column.name)))}
              </select>
            </Field>
            {query.pivot?.column && isDate(columns.find((column) => column.name === query.pivot?.column?.field)?.type ?? "") ? (
              <Field label="Column date grouping">
                <select
                  value={query.pivot.column.grain ?? "month"}
                  onChange={(event) => setQuery({
                    ...query,
                    pivot: { ...query.pivot, rows: pivotRows, column: { ...query.pivot!.column!, grain: event.target.value as PivotGrain } },
                  })}
                >
                  {PIVOT_GRAINS.map((grain) => <option key={grain.value} value={grain.value}>{grain.label}</option>)}
                </select>
              </Field>
            ) : null}
            {query.pivot?.column ? (
              <>
                {subColumns.map((dimension, index) => {
                  const setSub = (next: PivotDimension | null) => {
                    const list = [...subColumns];
                    if (next) list[index] = next;
                    else list.splice(index, 1);
                    setQuery({ ...query, pivot: { ...query.pivot!, subColumns: list.length ? list : undefined } });
                  };
                  const type = columns.find((column) => column.name === dimension.field)?.type ?? "";
                  return (
                    <div className={styles.pivotField} key={`sub-${index}`}>
                      <Field label={`Pivot column ${index + 2} (inside)`}>
                        <select
                          aria-label={`Pivot column ${index + 2}`}
                          value={dimension.field}
                          onChange={(event) => {
                            const field = event.target.value;
                            const fieldType = columns.find((column) => column.name === field)?.type ?? "";
                            setSub({ field, ...(isDate(fieldType) ? { grain: "month" as const } : {}) });
                          }}
                        >
                          {columnOptions(columns.filter((column) => !usedPivotFields.has(column.name) || column.name === dimension.field))}
                        </select>
                      </Field>
                      {isDate(type) ? (
                        <Field label="Group by">
                          <select aria-label={`Pivot column ${index + 2} date grouping`} value={dimension.grain ?? "month"} onChange={(event) => setSub({ ...dimension, grain: event.target.value as PivotGrain })}>
                            {PIVOT_GRAINS.map((grain) => <option key={grain.value} value={grain.value}>{grain.label}</option>)}
                          </select>
                        </Field>
                      ) : null}
                      <Button size="small" variant="danger" aria-label={`Remove pivot column ${index + 2}`} onClick={() => setSub(null)}>Remove column</Button>
                    </div>
                  );
                })}
                <div className={styles.addRow}>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={subColumns.length >= 2 || columns.every((column) => usedPivotFields.has(column.name))}
                    onClick={() => {
                      const column = columns.find((entry) => !usedPivotFields.has(entry.name));
                      if (!column) return;
                      setQuery({ ...query, pivot: { ...query.pivot!, subColumns: [...subColumns, { field: column.name, ...(isDate(column.type) ? { grain: "month" as const } : {}) }] } });
                    }}
                  >
                    Add a column inside
                  </Button>
                </div>
              </>
            ) : null}
          </>
        ) : visual === "gauge" ? null : (
          <>
            <Field label="Group by">
              <select
                value={query.groupBy?.field ?? ""}
                onChange={(event) => {
                  const field = event.target.value;
                  const type = columns.find((column) => column.name === field)?.type ?? "";
                  setQuery({
                    ...query,
                    groupBy: field ? { field, ...(isDate(type) ? { grain: "month" as Grain } : {}) } : null,
                    breakdown: field && field !== query.breakdown?.field ? query.breakdown : null,
                    // Grouped by a date, a value can compare with last year; the previous period and the trend are for one total.
                    measures: query.measures.map((measure) => ({
                      ...measure,
                      compare: field ? (isDate(type) && measure.compare === "previous_year" ? measure.compare : undefined) : measure.compare,
                      // A quick calculation needs a grouping.
                      ...(field ? {} : { quick: undefined, label: quickLabel(measure.label, undefined) }),
                    })),
                    sparkline: field ? undefined : query.sparkline,
                  });
                }}
              >
                <option value="">Nothing (one total)</option>
                {columnOptions(columns)}
              </select>
            </Field>
            {isDate(groupType) ? (
              <Field label="By">
                <select value={query.groupBy?.grain ?? "month"} onChange={(event) => setQuery({ ...query, groupBy: { field: query.groupBy!.field, grain: event.target.value as Grain } })}>
                  {GRAINS.map((grain) => <option key={grain.value} value={grain.value}>{grain.label}</option>)}
                </select>
              </Field>
            ) : null}
            <SecondGrouping visual={visual} query={query} columns={columns} onChange={setQuery} />
          </>
        )}
        <Field label="Date range applies to" hint="The dashboard's From and To.">
          <select value={query.dateField ?? ""} onChange={(event) => setQuery({ ...query, dateField: event.target.value || null })}>
            <option value="">No date</option>
            {columnOptions(columns.filter((column) => isDate(column.type)))}
          </select>
        </Field>
        {query.dateField ? (
          <Field label="Dates for this chart" hint={tileDates ? "This chart keeps these dates whatever the report's dates are." : undefined}>
            <select
              value={!tileDates ? "" : "preset" in tileDates ? tileDates.preset : "fixed"}
              onChange={(event) => {
                const value = event.target.value;
                setTileDates(!value ? undefined : value === "fixed" ? { from: filters.from || null, to: filters.to || null } : isDatePreset(value) ? { preset: value } : undefined);
              }}
            >
              <option value="">The report&apos;s dates</option>
              {DATE_PRESETS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              <option value="fixed">Fixed dates</option>
            </select>
          </Field>
        ) : null}
        {query.dateField && tileDates && !("preset" in tileDates) ? (
          <>
            <Field label="From">
              <DateInput value={tileDates.from ?? ""} onChange={(event) => setTileDates({ ...tileDates, from: event.target.value || null })} />
            </Field>
            <Field label="To">
              <DateInput value={tileDates.to ?? ""} onChange={(event) => setTileDates({ ...tileDates, to: event.target.value || null })} />
            </Field>
          </>
        ) : null}
        {visual !== "pivot" ? <Field label="Order by">
          <select
            value={`${query.sort.by}-${query.sort.direction}`}
            onChange={(event) => {
              const [by, direction] = event.target.value.split("-") as ["category" | "value", "asc" | "desc"];
              setQuery({ ...query, sort: { by, direction } });
            }}
          >
            <option value="category-asc">Group, A to Z / oldest first</option>
            <option value="category-desc">Group, Z to A / newest first</option>
            <option value="value-desc">First value, largest first</option>
            <option value="value-asc">First value, smallest first</option>
          </select>
        </Field> : null}
        {visual !== "pivot" ? <Field label="Top" hint="Blank for all.">
          <input
            inputMode="numeric"
            value={query.limit ?? ""}
            onChange={(event) => setQuery({ ...query, limit: event.target.value ? Number(event.target.value.replace(/\D/g, "")) || null : null })}
          />
        </Field> : null}
      </div>

      <h3 className={styles.subheading}>Values</h3>
      {query.measures.map((measure, index) => (
        <div key={index} className={styles.measureRow}>
          <input aria-label={`Value ${index + 1} label`} value={measure.label} maxLength={80} onChange={(event) => setMeasure(index, { label: event.target.value })} />
          {measure.aggregate === "formula" ? (
            <FormulaField index={index} measure={measure} siblings={query.measures} onChange={(formula) => setMeasure(index, { formula })} />
          ) : (
          <select aria-label={`Value ${index + 1} how`} value={measure.aggregate} onChange={(event) => {
              const aggregate = event.target.value as Aggregate;
              setMeasure(index, { aggregate, ...(aggregate === "count" || aggregate === "count_distinct" ? { negate: undefined } : {}) });
            }}>
            {AGGREGATES.filter((entry) => visual !== "pivot" || entry.value !== "count_distinct").map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          )}
          {measure.aggregate !== "count" && measure.aggregate !== "formula" ? (
            <select
              aria-label={`Value ${index + 1} of`}
              value={measure.field ?? ""}
              onChange={(event) => {
                // A field's own way of adding up when it's chosen.
                const summarise = columns.find((column) => column.name === event.target.value)?.settings?.summarise;
                setMeasure(index, { field: event.target.value, ...(summarise && summarise !== "none" && measure.aggregate !== "formula" ? { aggregate: summarise } : {}) });
              }}
            >
              <option value="">Choose a column</option>
              {columnOptions(["sum", "avg"].includes(measure.aggregate) ? numbers : columns)}
            </select>
          ) : null}
          {["sum", "avg"].includes(measure.aggregate) ? (
            <select aria-label={`Value ${index + 1} times`} value={measure.times ?? ""} onChange={(event) => setMeasure(index, { times: event.target.value || undefined })}>
              <option value="">× nothing</option>
              {columnOptions(numbers, "× ")}
            </select>
          ) : null}
          {["sum", "avg", "min", "max"].includes(measure.aggregate) ? (
            <label className={ui.checkbox} title="Each amount negated, e.g. so sales (credits) show as positive">
              <input type="checkbox" checked={measure.negate === true} onChange={(event) => setMeasure(index, { negate: event.target.checked || undefined })} /> other way
              round
            </label>
          ) : null}
          {((query.groupBy?.grain && !measure.period) || (query.groupBy && !query.groupBy.grain && measure.period)) && !(visual === "kpi" && index === 0) && !measure.quick ? (
            <label className={ui.checkbox}>
              <input
                type="checkbox"
                checked={measure.compare === "previous_year"}
                onChange={(event) => setMeasure(index, { compare: event.target.checked ? "previous_year" : undefined })}
              />{" "}
              and last year
            </label>
          ) : null}
          <PeriodField index={index} measure={measure} dated={Boolean(query.dateField || query.groupBy?.grain) && visual !== "pivot"} onChange={(patch) => setMeasure(index, patch)} />
          <QuickCalcField
            index={index}
            measure={measure}
            choices={quickChoices({ grouped: Boolean(query.groupBy), breakdown: Boolean(query.breakdown), pivot: visual === "pivot", pivotColumn: Boolean(query.pivot?.column) })}
            onChange={(patch) => setMeasure(index, patch)}
          />
          <ValueRules measure={measure} />
          <ValueKindFields index={index} measure={measure} columns={columns} pivot={visual === "pivot"} onChange={(patch) => setMeasure(index, patch)} />
          <ValueMeaning measure={measure} table={query.table} columns={columns} dateField={query.dateField ?? (query.groupBy?.grain ? query.groupBy.field : null)} place={{ dated: Boolean(query.groupBy?.grain), breakdown: Boolean(query.breakdown), pivot: visual === "pivot" }} />
          {visual !== "pivot" ? (
            <SaveValueButton
              organisationId={organisationId}
              table={query.table}
              measure={measure}
              siblings={query.measures}
              number={format?.series?.[tileValueNames(query.measures.slice(0, index)).length]?.number}
              onSaved={() => setSavedVersion((version) => version + 1)}
            />
          ) : null}
          <Button size="small" variant="danger" disabled={query.measures.length === 1} onClick={() => setQuery({ ...query, measures: query.measures.filter((_m, at) => at !== index) })}>
            Remove
          </Button>
        </div>
      ))}
      <div className={styles.addRow}>
        <Button
          size="small"
          variant="secondary"
          disabled={query.measures.length >= 6}
          onClick={() => setQuery({ ...query, measures: [...query.measures, { label: measureLabel({ aggregate: "count" }, query.table), aggregate: "count" }] })}
        >
          Add a value
        </Button>
        {visual !== "pivot" ? (
          <Button
            size="small"
            variant="secondary"
            disabled={query.measures.length >= 6}
            onClick={() =>
              setQuery({
                ...query,
                measures: [...query.measures, { label: `Calculated ${query.measures.filter((measure) => measure.aggregate === "formula").length + 1}`, aggregate: "formula", formula: "" }],
              })
            }
          >
            Add a calculated value
          </Button>
        ) : null}
      </div>
      {visual !== "pivot" && query.table ? (
        <SavedValuesPicker
          organisationId={organisationId}
          table={query.table}
          version={savedVersion}
          disabled={query.measures.length >= 6}
          onAdd={(measure, number) => {
            // A saved value's label must be its own on this chart, so a formula knows which one it means.
            const taken = new Set(query.measures.map((entry) => entry.label));
            let label = measure.label;
            for (let count = 2; taken.has(label); count += 1) label = `${measure.label} ${count}`;
            const measures = [...query.measures, { ...measure, label }];
            setQuery({ ...query, measures });
            if (number) {
              const at = tileValueNames(query.measures).length;
              const series = tileValueNames(measures).map((_name, position) => format?.series?.[position] ?? {});
              series[at] = { ...series[at], number };
              setFormat({ ...format, series });
            }
          }}
        />
      ) : null}

      <h3 className={styles.subheading}>Only include rows where</h3>
      <TileFilters organisationId={organisationId} table={query.table} columns={columns} filters={query.filters} onChange={(filters) => setQuery({ ...query, filters })} />

      {visual === "kpi" ? <KeyFigureSettings query={query} onQuery={setQuery} format={format} onFormat={setFormat} part="data" /> : null}

            </>
          ),
          style: (
            <>
      <fieldset className={styles.sizeFields}>
        <legend>Size in the report</legend>
        <div className={styles.propertyGrid}>
        <Field label="Width" hint="Of a row; on phones every chart is full width.">
          <select value={width} onChange={(event) => setWidth(event.target.value as TileWidth)}>
            {TILE_WIDTHS.map((entry) => <option key={entry} value={entry}>{WIDTH_LABELS[entry]}</option>)}
          </select>
        </Field>
        {visual !== "kpi" && visual !== "table" && visual !== "pivot" ? (
          <Field label="Height">
            <select value={height} onChange={(event) => setHeight(event.target.value as TileHeight)}>
              {TILE_HEIGHTS.map((entry) => <option key={entry} value={entry}>{HEIGHT_LABELS[entry]}</option>)}
            </select>
          </Field>
        ) : null}
        </div>
      </fieldset>
      <ChartFormatPanel
        visual={visual}
        values={tileValueNames(query.measures)}
        format={format}
        onChange={setFormat}
        inherited={defaults?.[visual]}
        onSetDefault={onSetDefault ? (look) => onSetDefault(visual, look) : undefined}
        theme={theme}
        groups={groupValues ? [...new Set(chartGroupNames(groupValues))] : undefined}
        datedGroups={groupValues ? datedGroups(groupValues) : false}
        groupName={query.groupBy ? fieldLabel(query.groupBy.field) : null}
        rowFields={(query.pivot?.rows ?? []).map((row) => fieldLabel(row.field))}
        smallMultiples={Boolean(query.breakdown)}
        advanced={advanced}
        extra={visual === "kpi" ? <KeyFigureSettings query={query} onQuery={setQuery} format={format} onFormat={setFormat} part="style" /> : null}
      />
      {onSetDefault ? <p className={ui.muted}>A default for {VISUAL_NAMES[visual].toLowerCase()} charts is kept when you apply this chart or save the report.</p> : null}

      {formatOptionsFor(visual).axes || formatOptionsFor(visual).rules ? <label className={`${ui.checkbox} ${styles.advancedToggle}`}>
        <input type="checkbox" checked={advanced} onChange={(event) => setAdvanced(event.target.checked)} /> Show advanced settings
        <span className={ui.muted}> (reference lines, trend and projection, colour rules, gridlines, log scale)</span>
      </label> : null}
            </>
          ),
          interactions: (
            <>
      <ChartFormatPanel
        part="interactions"
        visual={visual}
        values={tileValueNames(query.measures)}
        format={format}
        onChange={setFormat}
        inherited={defaults?.[visual]}
        onSetDefault={onSetDefault ? (look) => onSetDefault(visual, look) : undefined}
        theme={theme}
      />
      {DRILLABLE.includes(visual) ? (
        <DrillSettings drill={drill} usable={drillUsable} query={query} columns={columns} onChange={(next) => {
          setDrill(next);
          // The first level is what the chart is grouped by.
          if (next && query.groupBy && (next.levels[0].field !== query.groupBy.field || next.levels[0].grain !== query.groupBy.grain)) setQuery({ ...query, groupBy: next.levels[0] });
        }} />
      ) : null}
      {DRILLABLE.includes(visual) && others.length ? (
        <fieldset className={styles.sizeFields}>
          <legend>When a group on this chart is clicked</legend>
          <p className={ui.muted}>Filter shows only that group&apos;s rows; Highlight fades the other groups on a chart grouped the same way (on any other it filters).</p>
          <div className={styles.propertyGrid}>
            {others.map((other) => (
              <Field key={other.id} label={other.title}>
                <select value={interactions[other.id] ?? "filter"} onChange={(event) => {
                  const next = { ...interactions };
                  if (event.target.value === "filter") delete next[other.id];
                  else next[other.id] = event.target.value as InteractionMode;
                  setInteractions(next);
                }}>
                  {INTERACTION_MODES.map((mode) => <option key={mode} value={mode}>{INTERACTION_LABELS[mode]}</option>)}
                </select>
              </Field>
            ))}
          </div>
        </fieldset>
      ) : null}
      {visual !== "pivot" ? (
        <SwitchSettings
          switches={switches}
          onChange={setSwitches}
          values={query.measures.length}
          grouped={Boolean(query.groupBy) && !query.breakdown}
          canSwitchValues={!["kpi", "scatter", "pointmap"].includes(visual)}
          columns={columns}
          groupBy={query.groupBy}
          drills={Boolean(drillUsable && drill)}
        />
      ) : null}
      {visual === "pivot" ? <p className={ui.muted}>Clicking a number in the pivot table shows the rows behind it.</p> : null}
      {visual === "kpi" || visual === "table" ? <p className={ui.muted}>{visual === "kpi" ? "Key figures" : "Tables"} have no tooltips or clicks to set.</p> : null}
            </>
          ),
        }}
      />

      <div className={`${ui.rowButtons} ${styles.editorButtons}`}>
        <Button
          disabled={saving || !query.table || !preview?.result || Boolean(preview.error)}
          onClick={() =>
            onSave({
              id: tile?.id ?? `t${Date.now().toString(36)}`,
              title: title.trim() || query.measures[0]?.label || "Tile",
              visual,
              width,
              ...(height !== "medium" ? { height } : {}),
              query: { ...query, filters: query.filters.filter(filterComplete) },
              ...(format ? { format } : {}),
              ...(drillUsable && drill ? { drill } : {}),
              ...(DRILLABLE.includes(visual) && Object.keys(interactions).length ? { interactions } : {}),
              ...(tileDates && query.dateField ? { dates: tileDates } : {}),
              ...(switches && visual !== "pivot" ? { switches } : {}),
            })
          }
        >
          {saving ? "Saving…" : tile ? "Apply changes" : "Add to report"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
        </fieldset>
      </aside>
    </section>
  );
}
