"use client";

import { useContext,useMemo,useState } from "react";
import { Chart } from "@/components/analytics/chart";
import { KeyFigureView } from "@/components/analytics/key-figure";
import { applyChoice,choiceFormat,type TileChoice,type TileSwitches } from "@/lib/analytics/parameters";
import { FormattedCell,tableLook,totalRowClass } from "@/components/analytics/table-look";
import { columnRange,tableTotals } from "@/lib/analytics/conditional";
import { Button,Empty,Notice,ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { tileChartSpec } from "@/lib/analytics/tile-chart";
import { chartGroupNames } from "@/lib/analytics/chart-spec";
import { calendarHeight,calendarYears } from "@/lib/analytics/chart-relationships";
import { MAP_ATTRIBUTION,mapNote } from "@/lib/analytics/maps";
import { additiveValues } from "@/lib/analytics/small-multiples";
import { SmallMultiplesView } from "@/components/analytics/small-multiples";
import { useTileResult } from "@/components/analytics/use-tile-result";
import { ButtonItemView,ImageItemView,DirectoryItemView,ShapeItemView,SignoffItemView,TextItemView } from "@/components/analytics/items";
import { ReportItemView } from "@/components/analytics/report-item";
import { type ButtonAction } from "@/lib/analytics/items";
import { effectiveDates } from "@/lib/analytics/report-filters";
import { drillView,periodLabel,type DrillState,type TileView } from "@/lib/analytics/report-view";
import type { Tile } from "@/lib/analytics/dashboards";
import { CHART_HEIGHTS } from "@/lib/analytics/layout";
import type {
Filter,PivotDrillResult,
PivotDrillSelection,QueryResult,
ResultColumn,
TileQuery
} from "@/lib/analytics/query";
import { api,errorMessage } from "@/lib/client/api";
import { booleanText,showValue } from "@/lib/analytics/display";
import { fieldLabel } from "@/lib/analytics/labels";
import { todayInBrowser } from "@/lib/format";
import { cmp,dec,sum,toPlainString } from "@/lib/money/decimal";
import styles from "@/components/analytics-dashboards.module.css";
import { Filters,MULTIPLE_HEIGHTS,NAMED_GRAINS,PivotExportFor,YearEndMonth,heading } from "@/components/analytics/report-shared";
import { PivotTable } from "@/components/analytics/pivot-table";

/** A tile's answer: its saved question (`saved`, all a report viewer can run) or a question being built (`query`). */
/**
 * `asSaved`: the tile's question is the saved one, so it's run by the
 * report and tile (what report viewers can do). A tile added or changed in
 * the draft isn't saved yet, so its question is sent as it is.
 */
/** A tile as drilled: grouped by the level shown, so its chart (and projection) knows what it's showing. */
function drilledTile(tile: Tile, drill: DrillState | undefined): Tile {
  if (!drill || !tile.query) return tile;
  try {
    return { ...tile, query: { ...tile.query, groupBy: drillView(tile.query, tile.drill, drill, tile.title).groupBy } };
  } catch {
    return tile;
  }
}

/** What a reader has done to a tile: its view for the server, a click handler and the group to highlight. */
export type TileInteraction = {
  view?: TileView;
  /** The draft's tiles, for a view on a tile that isn't saved yet (sent with its question). */
  viewTiles?: Tile[];
  onPick?: (value: string | null) => void;
  highlight?: { value: string | null } | null;
  /** For a draft tile: its page's filters and range slicers, and dates that are its own. */
  draftWhere?: Filter[];
};
type TileBodyProps = { organisationId: string; dashboardId: string; tile: Tile; filters: Filters; asSaved: boolean; onAction?: (action: ButtonAction, target?: string) => void; /** A placed report is read by its saved tile: false while that tile is new or changed and not saved. */ reportSaved?: boolean } & TileInteraction;

export function TileBody(props: TileBodyProps) {
  const { tile } = props;
  const height = CHART_HEIGHTS[tile.height ?? "small"];
  if (tile.visual === "text") return <TextItemView organisationId={props.organisationId} dashboardId={props.dashboardId} tile={tile} filters={props.filters} saved={props.asSaved} />;
  if (tile.visual === "image" && tile.image) return <ImageItemView organisationId={props.organisationId} dashboardId={props.dashboardId} image={tile.image} height={height} />;
  if (tile.visual === "shape" && tile.shape) return <ShapeItemView shape={tile.shape} height={height} />;
  if (tile.visual === "button" && tile.button) return <ButtonItemView button={tile.button} onAction={props.onAction} />;
  if (tile.visual === "signoff" && tile.signoff) return <SignoffItemView signoff={tile.signoff} />;
  if (tile.visual === "directory" && tile.directory) return <DirectoryItemView organisationId={props.organisationId} dashboardId={props.dashboardId} directory={tile.directory} saved={props.reportSaved !== false} />;
  if (tile.visual === "report") return <ReportItemView organisationId={props.organisationId} dashboardId={props.dashboardId} tileId={tile.id} saved={props.reportSaved !== false} values={props.filters.values} />;
  return <QueryTileBody {...props} />;
}

function QueryTileBody({ organisationId, dashboardId, tile: savedTile, filters: reportFilters, asSaved, view, viewTiles, onPick: pick, highlight, draftWhere }: TileBodyProps) {
  const yearEnd = useContext(YearEndMonth);
  // The reader's switches: a saved tile sends its choice; a draft tile makes it here.
  const [choice, setChoice] = useState<TileChoice>({});
  const chosenQuery = (() => {
    if (!savedTile.query || !savedTile.switches) return savedTile.query;
    try {
      return applyChoice(savedTile.query, savedTile.switches, choice);
    } catch {
      return savedTile.query;
    }
  })();
  const tile: Tile = savedTile.switches ? { ...savedTile, query: chosenQuery, format: choiceFormat(savedTile.format, savedTile.query?.measures ?? [], choice, savedTile.switches) } : savedTile;
  // Grouped another way than saved, a click can't say which field it means to the other tiles, so it doesn't filter them.
  const onPick = choice.grouping ? undefined : pick;
  // A tile with its own dates keeps them (the server does this for saved tiles).
  const filters = !asSaved && tile.dates ? { ...reportFilters, ...effectiveDates(tile.dates, reportFilters, todayInBrowser(), yearEnd) } as Filters : reportFilters;
  const state = useTileResult(organisationId, asSaved ? savedTile.query : tile.query, filters, asSaved ? { dashboardId, tileId: tile.id } : undefined, !asSaved && tile.visual === "table" && tile.format?.table?.totals === true, view || draftWhere?.length ? { view, tiles: viewTiles, drill: tile.drill, where: draftWhere } : undefined, asSaved ? choice : undefined);
  // Drilled, the chart shows another level: say so to the chart (its projection works on what's shown).
  const shownTile = drilledTile(tile, view?.drill);
  const switcher = savedTile.switches && savedTile.query ? <TileSwitcher query={savedTile.query} switches={savedTile.switches} choice={choice} onChoose={setChoice} title={savedTile.title} /> : null;
  const { current } = useWorkspace();
  const [opened, setDrill] = useState<{ title: string; result: PivotDrillResult; filtersKey: string } | null>(null);
  const [drillError, setDrillError] = useState<string | null>(null);
  // Rows opened under other dates or slicers no longer match the tile, so they're put away.
  const filtersKey = JSON.stringify([filters, view]);
  const drill = opened?.filtersKey === filtersKey ? opened : null;
  if (!state) return <>{switcher}<p className={ui.muted}>Working it out…</p></>;
  if (state.error) return <>{switcher}<Notice tone="error">{state.error}</Notice></>;
  const openDrill = async (selection: PivotDrillSelection, title: string) => {
    setDrill(null);
    setDrillError(null);
    try {
      const result = await api<PivotDrillResult>("/api/analytics/query", {
        method: "POST",
        body: {
          organisationId,
          ...(asSaved ? { dashboardId, tileId: tile.id } : { query: tile.query }),
          filters: { from: filters.from || null, to: filters.to || null, values: filters.values },
          drill: selection,
          ...(view ? { view, ...(asSaved ? {} : { viewTiles, viewDrill: tile.drill }) } : {}),
        },
      });
      setDrill({ title, result, filtersKey });
    } catch (error) {
      setDrillError(errorMessage(error));
    }
  };
  return (
    <>
      {switcher}
      {drillError ? <Notice tone="error">{drillError}</Notice> : null}
      <TileResult
        tile={shownTile}
        result={state.result!}
        onDrill={tile.visual === "pivot" ? (selection, title) => void openDrill(selection, title) : undefined}
        onPick={onPick}
        highlight={highlight}
        exportFor={{ organisationId, organisationName: current?.id === organisationId ? current.displayName : "Organisation", filters }}
      />
      {drill ? (
        <div className={styles.drill}>
          <div className={styles.drillHeader}>
            <h3>{drill.title}</h3>
            <Button size="small" variant="secondary" onClick={() => setDrill(null)}>Close rows</Button>
          </div>
          {drill.result.rows.length === 0 ? (
            <Empty>No matching rows.</Empty>
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table} aria-label={drill.title}>
                <thead>
                  <tr>{drill.result.columns.map((column) => <th key={column.key} scope="col" className={column.role === "measure" ? ui.num : undefined}>{fieldLabel(column.label)}</th>)}</tr>
                </thead>
                <tbody>
                  {drill.result.rows.map((row, index) => (
                    <tr key={index}>
                      {drill.result.columns.map((column) => (
                        <td key={column.key} className={column.role === "measure" ? ui.num : undefined}>{showValue(row[column.key], column)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {drill.result.truncated ? <p className={ui.muted}>Showing the first 500 rows.</p> : null}
        </div>
      ) : null}
    </>
  );
}

/** What the reader can switch on a tile: the value shown, and the grouping. */
function TileSwitcher({ query, switches, choice, onChoose, title }: { query: TileQuery; switches: TileSwitches; choice: TileChoice; onChoose: (choice: TileChoice) => void; title: string }) {
  const groupings = query.groupBy ? [query.groupBy, ...(switches.groupings ?? [])] : [];
  const grainName = (grain?: string) => ({ day: "by day", week: "by week", month: "by month", quarter: "by quarter", year: "by year", fquarter: "by financial quarter", fyear: "by financial year" })[grain ?? ""];
  return (
    <div className={styles.switcher}>
      {switches.values ? (
        <label>
          Show{" "}
          <select aria-label={`${title}: value shown`} value={choice.value ?? 0} onChange={(event) => onChoose({ ...choice, value: Number(event.target.value) })}>
            {query.measures.map((measure, index) => (
              <option key={index} value={index}>
                {measure.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {switches.groupings?.length ? (
        <label>
          By{" "}
          <select aria-label={`${title}: grouped by`} value={choice.grouping ?? 0} onChange={(event) => onChoose({ ...choice, grouping: Number(event.target.value) })}>
            {groupings.map((grouping, index) => (
              <option key={index} value={index}>
                {fieldLabel(grouping.field)}
                {grouping.grain ? ` (${grainName(grouping.grain) ?? grouping.grain})` : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

export function TileResult({
  tile,
  result,
  onDrill,
  exportFor,
  onPick,
  highlight,
}: {
  tile: Pick<Tile, "title" | "visual" | "format" | "height"> & { query?: TileQuery | null };
  result: QueryResult;
  onDrill?: (selection: PivotDrillSelection, title: string) => void;
  exportFor?: PivotExportFor;
  /** A group clicked (its value as the server gave it), to filter other tiles or drill down. */
  onPick?: (value: string | null) => void;
  /** The group to show at full strength, the rest faded. */
  highlight?: { value: string | null } | null;
}) {
  const measures = result.columns.filter((column) => column.role === "measure");
  const yearEndMonth = useContext(YearEndMonth);
  const periodGrain = result.columns.find((column) => column.key === "category")?.grain;
  const spec = useMemo(() => {
    const built = tileChartSpec(tile, measures, { query: tile.query, truncated: result.truncated });
    return built && periodGrain && NAMED_GRAINS.has(periodGrain) ? { ...built, periodName: (value: string) => periodLabel(value, periodGrain, yearEndMonth) } : built;
  }, [tile, measures, result.truncated, periodGrain, yearEndMonth]);

  if (tile.visual === "pivot") {
    return result.pivot ? (
      <>
        {result.notes?.map((note) => <Notice key={note} tone="warning">{note}</Notice>)}
        <PivotTable title={tile.title} pivot={result.pivot} onDrill={onDrill} exportFor={exportFor} format={tile.format} />
      </>
    ) : (
      <Notice tone="error">This pivot table needs to be saved again.</Notice>
    );
  }
  // On paper there's nothing to change, so say why it's empty.
  if (result.rows.length === 0) return <Empty>Nothing matches these dates and filters.</Empty>;
  return (
    <>
      {/* What the figures can't show, e.g. amounts in two currencies left blank. */}
      {result.notes?.map((note) => <Notice key={note} tone="warning">{note}</Notice>)}
      <TileFigures tile={tile} result={result} measures={measures} spec={spec} onPick={onPick} highlight={highlight} />
    </>
  );
}

function TileFigures({
  tile,
  result,
  measures,
  spec,
  onPick,
  highlight,
}: {
  tile: Pick<Tile, "title" | "visual" | "format" | "height"> & { query?: TileQuery | null };
  result: QueryResult;
  measures: ResultColumn[];
  spec: ReturnType<typeof tileChartSpec>;
  onPick?: (value: string | null) => void;
  highlight?: { value: string | null } | null;
}) {
  const yearEndMonth = useContext(YearEndMonth);
  // Yes/No groups are named Yes and No on the chart too, and coded groups in words.
  const categoryColumn = result.columns.find((column) => column.key === "category");
  const breakdownColumn = result.columns.find((column) => column.key === "breakdown");
  const yesNo = categoryColumn?.format === "boolean";
  const grain = categoryColumn?.grain;
  const word = (column: ResultColumn | undefined, value: string | null | undefined) =>
    value === null || value === undefined || !column ? value : column.format === "boolean" ? booleanText(value) : (column.valueLabels?.[value] ?? value);
  const renamed = yesNo || Boolean(categoryColumn?.valueLabels) || Boolean(breakdownColumn?.valueLabels);
  // Year, quarter and week groups are named for people on the chart; the rows keep their dates (for projections and clicks).
  const named = renamed
    ? result.rows.map((row) => ({ ...row, category: word(categoryColumn, row.category) ?? null, ...(breakdownColumn ? { breakdown: word(breakdownColumn, row.breakdown) ?? null } : {}) }))
    : result.rows;
  const rows = tile.visual === "pie" || tile.visual === "donut" ? foldSlices(named, measures[0]?.key ?? "m0") : named;
  // Each group as drawn, back to its value as the server gave it (for clicks), and which to highlight.
  const rawOf = new Map(named.map((row, index) => [String(row.category), result.rows[index].category ?? null]));
  const pickRow = onPick
    ? (index: number) => {
        const label = rows[index]?.category;
        if (label !== undefined && rawOf.has(String(label))) onPick(rawOf.get(String(label)) ?? null);
      }
    : undefined;
  const highlighted = highlight ? rows.map((row, index) => (rawOf.get(String(row.category)) === highlight.value ? index : -1)).filter((index) => index >= 0) : null;
  if (tile.visual === "kpi") return <KeyFigureView result={result} format={tile.format} />;
  if (!spec) {
    // Table styles and conditional formatting, by each value's position among the tile's values.
    const look = tableLook(tile.format?.table);
    const ranges = measures.map((column) => columnRange(result.rows.map((row) => row[column.key])));
    // A quick calculation is never added up from the rows shown.
    const aggregates = (tile.query?.measures ?? []).flatMap((measure) => (measure.quick || (measure.period && tile.query?.groupBy?.grain) ? ["quick"] : measure.compare ? [measure.aggregate, measure.aggregate] : [measure.aggregate]));
    const totals = tile.format?.table?.totals ? tableTotals(result.columns, result.rows, aggregates, result.totals) : null;
    return (
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${look.className}`} style={look.style}>
          <thead>
            <tr>
              {result.columns.map((column) => (
                <th key={column.key} className={column.role === "measure" ? ui.num : undefined}>
                  {column.role === "category" ? fieldLabel(column.label) : heading(column.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, index) => (
              <tr key={index}>
                {result.columns.map((column) => {
                  const valueIndex = measures.indexOf(column);
                  return valueIndex < 0 ? (
                    <td key={column.key} className={highlight && column.key === "category" && row.category !== highlight.value ? styles.fadedCell : undefined}>
                      {onPick && column.key === "category" ? (
                        <button type="button" className={styles.groupButton} aria-pressed={highlight ? row.category === highlight.value : undefined} onClick={() => onPick(row.category ?? null)}>
                          {grain && NAMED_GRAINS.has(grain) && row.category ? periodLabel(row.category, grain, yearEndMonth) : showValue(row[column.key], column)}
                        </button>
                      ) : grain && NAMED_GRAINS.has(grain) && column.key === "category" && row.category ? periodLabel(row.category, grain, yearEndMonth) : showValue(row[column.key], column)}
                    </td>
                  ) : (
                    <FormattedCell key={column.key} className={ui.num} format={tile.format} valueIndex={valueIndex} value={row[column.key] ?? null} range={ranges[valueIndex]} field={row.category ?? null}>
                      {/* The value's own number format on the tile (e.g. a percentage), else its field's. */}
                      {showValue(row[column.key], { ...column, number: tile.format?.series?.[valueIndex]?.number ?? column.number })}
                    </FormattedCell>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {totals ? (
            <tfoot>
              <tr className={totalRowClass(tile.format?.table, styles.pivotTotal)}>
                {result.columns.map((column, index) => (
                  <th key={column.key} scope={index === 0 ? "row" : undefined} className={column.role === "measure" ? ui.num : undefined}>
                    {index === 0 ? (result.truncated ? "Total of the rows shown" : "Total") : totals[column.key] === null ? "" : showValue(totals[column.key], column)}
                  </th>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
        {result.truncated ? <p className={ui.muted}>Showing the first 5,000 rows.</p> : null}
      </div>
    );
  }
  if (tile.query?.breakdown && (tile.visual === "column" || tile.visual === "bar" || tile.visual === "line")) {
    // Small multiples: one small chart for each value of the second grouping.
    return <SmallMultiplesView spec={spec} rows={rows} additive={additiveValues(tile.query.measures)} height={MULTIPLE_HEIGHTS[tile.height ?? "medium"]} />;
  }
  if (tile.visual === "filledmap" || tile.visual === "pointmap") {
    // Groups that can't go on the map are named under it (the hidden data table still has every row).
    const note = mapNote(tile.visual, rows, chartGroupNames(rows.map((row) => row.category)), measures.map((column) => column.key), tile.format?.map?.areas);
    return (
      <>
        <Chart spec={spec} rows={rows} height={CHART_HEIGHTS[tile.height ?? "medium"]} onPick={pickRow} highlight={highlighted} />
        {note ? <p className={styles.mapNote}>{note}</p> : null}
        <p className={styles.mapNote}>{MAP_ATTRIBUTION}</p>
      </>
    );
  }
  // A calendar heat map is as tall as the years it shows (up to three).
  const height = tile.visual === "calendar"
    ? Math.max(CHART_HEIGHTS[tile.height ?? "medium"], calendarHeight(calendarYears(rows.map((row) => String(row.category ?? ""))).length))
    : CHART_HEIGHTS[tile.height ?? "medium"];
  return (
    <>
      {pickRow ? <GroupChooser names={spec.periodName && rows.every((row) => typeof row.category === "string") ? rows.map((row) => spec.periodName!(String(row.category))) : chartGroupNames(rows.map((row) => row.category))} chosen={highlighted?.length === 1 ? highlighted[0] : null} onChoose={pickRow} /> : null}
      <Chart spec={spec} rows={rows} height={height} onPick={pickRow} highlight={highlighted} />
    </>
  );
}

/** Choosing a chart's group from the keyboard, as a click on it does. */
function GroupChooser({ names, chosen, onChoose }: { names: string[]; chosen: number | null; onChoose: (index: number) => void }) {
  return (
    <label className={styles.groupChooser}>
      <span className={styles.visuallyHidden}>Choose a group to filter by or drill into</span>
      <select value={chosen ?? ""} onChange={(event) => event.target.value !== "" && onChoose(Number(event.target.value))}>
        <option value="">Choose a group…</option>
        {names.map((name, index) => (name === "Other" ? null : <option key={index} value={index}>{name || "(blank)"}</option>))}
      </select>
    </label>
  );
}

/** A pie keeps its 7 largest slices and adds the rest up (exactly) as Other, so no two slices share a colour. */
function foldSlices(rows: QueryResult["rows"], key: string): QueryResult["rows"] {
  if (rows.length <= 8) return rows;
  const sorted = [...rows].sort((a, b) => cmp(dec(b[key] ?? "0"), dec(a[key] ?? "0")));
  const other = sum(sorted.slice(7).map((row) => dec(row[key] ?? "0")));
  return [...sorted.slice(0, 7), { category: "Other", [key]: toPlainString(other) }];
}
