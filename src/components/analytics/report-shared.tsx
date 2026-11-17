"use client";

import { createContext } from "react";
import { type SlicerRange } from "@/lib/analytics/slicers";
import type { Tile } from "@/lib/analytics/dashboards";
import { type TileHeight,type TileWidth } from "@/lib/analytics/layout";
import type {
Aggregate,ColumnInfo,
Grain,PivotGrain,Visual
} from "@/lib/analytics/query";
import { type DatePreset } from "@/lib/analytics/date-ranges";
import { fieldLabel } from "@/lib/analytics/labels";
import styles from "@/components/analytics-dashboards.module.css";

/** Each small chart's height, by the tile's height. */
export const MULTIPLE_HEIGHTS: Record<TileHeight, number> = { small: 160, medium: 200, large: 260 };

export type TableInfo = { name: string; columns: ColumnInfo[] };

/** A table's fields by folder: those without a folder first, then each folder A to Z. */
export function fieldFolders(columns: ColumnInfo[]): Array<[string, ColumnInfo[]]> {
  const folders = new Map<string, ColumnInfo[]>();
  for (const column of columns) {
    const folder = column.settings?.folder ?? "";
    folders.set(folder, [...(folders.get(folder) ?? []), column]);
  }
  return [...folders.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
}

export const VISUALS: Array<{ value: Visual; label: string }> = [
  { value: "column", label: "Columns" },
  { value: "bar", label: "Bars" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "combo", label: "Columns and line" },
  { value: "pie", label: "Pie" },
  { value: "donut", label: "Donut" },
  { value: "kpi", label: "Key figure" },
  { value: "table", label: "Table" },
  { value: "pivot", label: "Pivot table" },
  // .
  { value: "waterfall", label: "Waterfall" },
  { value: "funnel", label: "Funnel" },
  { value: "gauge", label: "Gauge" },
  { value: "bullet", label: "Bullet chart" },
  { value: "scatter", label: "Scatter or bubble" },
  { value: "histogram", label: "Histogram" },
  { value: "boxplot", label: "Box plot" },
  { value: "treemap", label: "Treemap" },
  { value: "heatmap", label: "Heat map" },
  { value: "calendar", label: "Calendar heat map" },
  { value: "sankey", label: "Sankey" },
  { value: "filledmap", label: "Filled map (NZ)" },
  { value: "pointmap", label: "Map with points (NZ)" },
];

export const ITEM_NAMES: Record<string, string> = { text: "Text", image: "Image", shape: "Shape", button: "Button", signoff: "Sign-off", directory: "Directory" };

export const AGGREGATES: Array<{ value: Aggregate; label: string }> = [
  { value: "sum", label: "Total" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Smallest" },
  { value: "max", label: "Largest" },
  { value: "count", label: "Count of rows" },
  { value: "count_distinct", label: "Count of different values" },
];

export const GRAINS: Array<{ value: Grain; label: string }> = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
];

export const PIVOT_GRAINS: Array<{ value: PivotGrain; label: string }> = [
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
];

export const isDate = (type: string) => type === "DATE" || type.startsWith("TIMESTAMP");
export const isNumber = (type: string) => /^(DECIMAL|BIGINT|INTEGER|SMALLINT|TINYINT|HUGEINT|DOUBLE|FLOAT|UBIGINT|UINTEGER)/.test(type);

/** "order_date" -> "Order date". */
export function heading(label: string): string {
  const text = label.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A column in a picker: its plain name, with the real one in a tooltip. */
export function columnOptions(columns: ColumnInfo[], prefix = "") {
  return columns.map((column) => (
    <option key={column.name} value={column.name} title={column.name}>
      {prefix}{fieldLabel(column.name)}
    </option>
  ));
}

/** What the dashboard is showing: its dates (and the preset they came from, if one was chosen) and slicer choices. */
export type Filters = { from: string; to: string; preset?: DatePreset | null; values: Record<string, string[]>; ranges?: Record<string, SlicerRange>; parameters?: Record<string, string> };
export type DateContext = { today: string; financialYearEndMonth: number };
export type PivotExportFor = { organisationId: string; organisationName: string; filters: Filters };

const GRAIN_NAMES: Record<string, string> = { fyear: "financial year", fquarter: "quarter", year: "year", quarter: "quarter", month: "month", week: "week", day: "day" };

/** A drill level as a reader sees it: "Account name", or "Posting date by quarter". */
export function levelName(level: { field: string; grain?: string } | null): string {
  if (!level) return "";
  return level.grain ? `${fieldLabel(level.field)} by ${GRAIN_NAMES[level.grain] ?? level.grain}` : fieldLabel(level.field);
}

const WIDTH_CLASSES: Record<TileWidth, string> = {
  quarter: styles.quarter,
  third: styles.third,
  half: styles.half,
  "two-thirds": styles.twoThirds,
  full: styles.full,
};

export function tileClass(tile: Tile): string {
  const card = tile.format?.card;
  return [
    styles.tile,
    WIDTH_CLASSES[tile.width] ?? styles.half,
    tile.visual === "text" && !tile.commentary ? styles.textTile : "",
    tile.commentary ? styles.commentaryTile : "",
    card?.background === "tinted" ? styles.tinted : card?.background === "none" ? styles.bare : "",
    card?.border === false ? styles.borderless : "",
  ].filter(Boolean).join(" ");
}

/** The organisation's balance month, for naming financial years and quarters. */
export const YearEndMonth = createContext(3);

/** Periods named for people: "FY2027", "Q3 2026" (months and days keep the chart's own names). */
export const NAMED_GRAINS = new Set(["year", "quarter", "fyear", "fquarter", "week"]);
