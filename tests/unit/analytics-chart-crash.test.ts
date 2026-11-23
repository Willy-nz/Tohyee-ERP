import * as echarts from "echarts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { ChartFormatPanel } from "@/components/analytics/chart-format-panel";
import { TileResult } from "@/components/analytics/tile-body";
import { chartProblem, chartRows, projectedRows, toEChartsOption, type ChartTheme } from "@/lib/analytics/chart-spec";
import type { ChartFormat } from "@/lib/analytics/chart-format";
import { tileChartSpec } from "@/lib/analytics/tile-chart";
import { MAP_IDS } from "@/lib/analytics/maps";
import type { ResultColumn } from "@/lib/analytics/query";
import regions from "@/lib/analytics/maps/nz-regions.json";
import districts from "@/lib/analytics/maps/nz-districts.json";

/**
 * Every chart, with awkward data and settings, is worked out and drawn the
 * way the browser draws it. None may throw: a chart that throws blanks the
 * whole page. One that can't be drawn yet must say why (chartProblem).
 */

const theme: ChartTheme = { text: "#1b2533", mutedText: "#546072", grid: "#e9edf2", background: "#ffffff", palette: ["#1f5fae", "#d66919", "#009e98", "#8a5cc2"] };

const KINDS = ["column", "bar", "line", "area", "combo", "pie", "donut", "kpi", "waterfall", "funnel", "gauge", "bullet", "scatter", "histogram", "boxplot", "treemap", "heatmap", "calendar", "sankey", "filledmap", "pointmap"];

type Row = Record<string, string | number | null>;
const many = Array.from({ length: 150 }, (_, i): Row => ({ category: `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, breakdown: `B${i % 5}`, m0: String(i * 3.5), m1: String(-i), m2: String(i % 7), m3: "1" }));

const DATA: Record<string, Row[]> = {
  months: [
    { category: "2026-04-01", m0: "934.66", m1: "3070.50", m2: "-2135.84", m3: "12" },
    { category: "2026-05-01", m0: "4052.01", m1: "2168.20", m2: "1883.81", m3: "30" },
    { category: "2026-06-01", m0: "633.70", m1: null, m2: "0", m3: null },
  ],
  empty: [],
  one: [{ category: "Only", m0: "10", m1: "5", m2: "1", m3: "1" }],
  noGroup: [{ m0: "18202.75", m1: "8684.85", m2: "3", m3: "1" }],
  nullGroup: [{ category: null, m0: "5", m1: "3", m2: "1", m3: "1" }, { category: "", m0: "2", m1: "1", m2: null, m3: "2" }],
  zeros: [{ category: "A", m0: "0", m1: "0", m2: "0", m3: "0" }, { category: "B", m0: "0", m1: "0", m2: "0", m3: "0" }],
  negatives: [{ category: "A", m0: "-10", m1: "-5", m2: "-1", m3: "-3" }, { category: "B", m0: "-2", m1: "-1", m2: "-9", m3: "-1" }],
  allNull: [{ category: "A", m0: null, m1: null, m2: null, m3: null }, { category: "B", m0: null, m1: null, m2: null, m3: null }],
  odd: [{ category: "A", m0: "0.0000001", m1: "", m2: "-0", m3: "1.5" }, { category: "B", m0: "12.5", m1: " 3 ", m2: "-0.00", m3: "100000000" }],
  numbers: [{ category: 2026, m0: 12, m1: -3.25, m2: 0, m3: 7 }, { category: 0, m0: 1, m1: 2, m2: 3, m3: 4 }],
  huge: [{ category: "A", m0: "99999999999999999999.99", m1: "0.000001", m2: "-99999999999999999999", m3: "1" }],
  duplicates: [{ category: "A", m0: "1", m1: "2", m2: "3", m3: "4" }, { category: "A", m0: "5", m1: "6", m2: "7", m3: "8" }],
  breakdown: [
    { category: "Otago", breakdown: "Rings", m0: "10", m1: "-45.87", m2: "170.5", m3: "3" },
    { category: "Otago", breakdown: "Necklaces", m0: "4", m1: "-45.87", m2: "170.5", m3: "1" },
    { category: "Canterbury", breakdown: null, m0: "7", m1: "-43.5", m2: "172.6", m3: "2" },
    { category: "Manawatu-Wanganui", breakdown: "Rings", m0: "2", m1: "999", m2: "-999", m3: null },
    { category: "Atlantis", breakdown: "Rings", m0: "1", m1: "abc", m2: null, m3: "1" },
  ],
  many,
};

const FORMATS: Record<string, ChartFormat | undefined> = {
  none: undefined,
  busy: {
    labels: { show: true, position: "outside" as never, content: { category: true, value: true, percent: true }, density: "all" },
    legend: { show: "show", position: "right" as never, title: "Key" },
    stack: "percent",
    smooth: true,
    markers: true,
    zoom: true,
    donutTotal: true,
    colorByCategory: true,
    negativeRed: true,
    categoryColors: [{ name: "A", color: "#ff0000" }],
    series: [{ hex: "#123456" } as never, { as: "line", axis: "right" } as never],
    referenceLines: [
      { kind: "average" } as never,
      { kind: "percentile", percentile: 90 } as never,
      { kind: "band", value: "1", to: "5" } as never,
      { kind: "target", series: 7, value: "abc" } as never,
    ],
    chartRules: [{ op: "<", value: "0", color: "#b32228" } as never, { op: ">", value: "x", color: "#000", series: 9 } as never],
    valueAxis: { min: "10", max: "1", log: true } as never,
    waterfall: { total: true, connectors: true },
    funnel: { percent: "previous" },
    gauge: { min: "100", max: "0", target: "abc" } as never,
    bullet: {} as never,
    scatter: { trend: true },
    histogram: { bins: 0, width: "-5" },
    boxplot: { outliers: true },
    smallMultiples: { max: 0 },
    map: { areas: "districts" },
  },
  stacked: { stack: "stacked", labels: { show: true }, legend: { show: "hide" }, histogram: { bins: 500 }, gauge: { min: "0", max: "0" } as never },
};

function columns(n: number, format: ResultColumn["format"]): ResultColumn[] {
  return ["Sales", "Costs", "Orders", "Size"].slice(0, n).map((label, index) => ({ key: `m${index}`, label, format, role: "measure" }) as ResultColumn);
}

/** Works the chart out and draws it, as chart.tsx does; returns why it can't be drawn, or null. */
function draw(kind: string, measures: ResultColumn[], rows: Row[], format: ChartFormat | undefined, extra: { breakdown?: boolean; compact?: boolean; grain?: boolean; highlight?: boolean }): string | null {
  const spec = tileChartSpec({ visual: kind, format, query: extra.breakdown ? { breakdown: { field: "x" } } : {} }, measures, {
    compact: extra.compact,
    query: { groupBy: { field: "posting_date", grain: extra.grain ? "month" : undefined }, sort: { by: "value", direction: "desc" }, limit: 10 } as never,
    truncated: true,
  });
  if (!spec) return null;
  let option;
  try {
    option = toEChartsOption(spec, rows, theme);
    chartRows(spec, rows);
    projectedRows(spec, rows);
  } catch (error) {
    // Allowed only if the person is told why, in words (chart.tsx shows this in place of the chart).
    return chartProblem(spec, error);
  }
  if (!("series" in option)) return null; // a key figure, drawn as HTML
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: extra.compact ? 240 : 640, height: extra.compact ? 160 : 400 });
  try {
    chart.setOption(option as echarts.EChartsOption, true);
    chart.renderToSVGString();
    chart.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: 0 });
    chart.dispatchAction({ type: "highlight", seriesIndex: 0, dataIndex: 0 });
  } finally {
    chart.dispose();
  }
  return null;
}

beforeAll(() => {
  echarts.registerMap(MAP_IDS.regions, regions as never);
  echarts.registerMap(MAP_IDS.districts, districts as never);
});

describe("no chart takes the page down", () => {
  for (const kind of KINDS) {
    it(kind, () => {
      const failures: string[] = [];
      for (const [dataName, rows] of Object.entries(DATA)) {
        for (const [formatName, format] of Object.entries(FORMATS)) {
          for (const n of [1, 3]) {
            for (const valueFormat of n === 1 ? (["money"] as const) : (["percent"] as const)) {
              for (const extra of [{}, { breakdown: true, grain: true, compact: true }]) {
                try {
                  const problem = draw(kind, columns(n, valueFormat), rows, format, extra);
                  if (problem?.startsWith("This chart can't be drawn")) failures.push(`${dataName}/${formatName}/${n} ${valueFormat} ${JSON.stringify(extra)}: ${problem}`);
                } catch (error) {
                  failures.push(`${dataName}/${formatName}/${n} ${valueFormat} ${JSON.stringify(extra)}: ${error instanceof Error ? error.stack?.split("\n").slice(0, 3).join(" | ") : String(error)}`);
                }
              }
            }
          }
        }
      }
      // One of each kind of failure, so a single run shows them all.
      const seen = new Set<string>();
      const distinct = failures.filter((failure) => {
        const reason = failure.slice(failure.indexOf(": ") + 2, failure.indexOf(": ") + 90);
        if (seen.has(reason)) return false;
        seen.add(reason);
        return true;
      });
      expect(distinct).toEqual([]);
    });
  }
});

describe("no tile's figures take the page down (tables, key figures, small multiples and maps too)", () => {
  const VISUALS = [...KINDS, "table"];
  const TILE_FORMATS: Record<string, ChartFormat | undefined> = {
    ...FORMATS,
    table: {
      table: { totals: true, banded: true } as never,
      conditional: [{ series: 0, op: "<", value: "-", color: "#b32228" } as never, { series: 5, scale: { low: "#ffffff", high: "#000000" } } as never],
      dataBars: [{ value: 0 }, { value: 9 }],
      icons: [{ value: 1, set: "arrows" as never }],
      kpi: { rules: [{ op: "<", value: "", color: "#b32228" }], sparkline: "area", change: "percent" } as never,
      series: [{ number: { style: "percent", decimals: 30 } } as never],
    },
  };
  const categoryColumns = (rows: Row[], grain?: string): ResultColumn[] => [
    ...(rows.some((row) => "category" in row) ? [{ key: "category", label: "posting_date", format: grain ? "date" : "text", role: "category", ...(grain ? { grain } : {}) } as ResultColumn] : []),
    ...(rows.some((row) => "breakdown" in row) ? [{ key: "breakdown", label: "product", format: "text", role: "category" } as ResultColumn] : []),
  ];
  for (const visual of VISUALS) {
    it(visual, () => {
      const failures: string[] = [];
      for (const [dataName, rows] of Object.entries(DATA)) {
        for (const [formatName, format] of Object.entries(TILE_FORMATS)) {
          for (const n of [1, 2]) {
            for (const grain of [undefined, "fyear"]) {
              for (const breakdown of [false, true]) {
                const measures = columns(n, n === 2 ? "percent" : "money");
                const result = { columns: [...categoryColumns(rows, grain), ...measures], rows: rows as never, truncated: breakdown, ...(breakdown ? { notes: ["A note"] } : {}) } as never;
                const tile = { title: "Tile", visual, format, height: "medium", query: { table: "t", measures: measures.map(() => ({ aggregate: "sum", field: "amount" })), ...(breakdown ? { breakdown: { field: "product" } } : {}), groupBy: { field: "posting_date", grain } } } as never;
                try {
                  renderToStaticMarkup(createElement(TileResult, { tile, result, onPick: () => undefined, highlight: { value: "A" } }));
                } catch (error) {
                  failures.push(`${dataName}/${formatName}/${n} ${grain ?? "-"} ${breakdown ? "breakdown" : ""}: ${error instanceof Error ? error.stack?.split("\n").slice(0, 3).join(" | ") : String(error)}`);
                }
              }
            }
          }
        }
      }
      const seen = new Set<string>();
      expect(failures.filter((failure) => {
        const reason = failure.slice(failure.indexOf(": ") + 2, failure.indexOf(": ") + 90);
        return seen.has(reason) ? false : (seen.add(reason), true);
      })).toEqual([]);
    });
  }
});

describe("the format panel opens for every visual", () => {
  const VISUALS = [...KINDS, "table", "pivot"];
  for (const visual of VISUALS) {
    it(visual, () => {
      for (const format of Object.values(FORMATS)) {
        for (const values of [[], ["Sales"], ["Sales", "Costs", "Orders"]]) {
          for (const part of ["style", "interactions"] as const) {
            for (const advanced of [false, true]) {
              renderToStaticMarkup(
                createElement(ChartFormatPanel, {
                  visual: visual as never, values, format, onChange: () => undefined, onSetDefault: () => undefined, inherited: FORMATS.stacked,
                  groups: ["A", "B"], datedGroups: true, groupName: "Month", rowFields: ["Account"], smallMultiples: true, part, advanced,
                }),
              );
            }
          }
        }
      }
    });
  }
});
