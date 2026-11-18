"use client";

import type { CSSProperties, ReactNode } from "react";
import { pageStyle } from "@/components/analytics/report-pages";
import type { Dashboard, Tile } from "@/lib/analytics/dashboards";
import { reportPages, tilePage } from "@/lib/analytics/pages";
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, isBuiltInTheme } from "@/lib/charts/report-themes";
import styles from "./report-preview.module.css";

const COLUMNS: Record<string, number> = { quarter: 3, third: 4, half: 6, "two-thirds": 8, full: 12 };
const ROWS: Record<string, number> = { small: 1, medium: 2, large: 3 };
/** Enough tiles to show the page's shape; the rest fade out below. */
const MOST_TILES = 12;

/**
 * A small picture of a report's first page for the reports list: its theme's
 * colours, its background picture, and each tile in its place and size,
 * drawn as the kind of chart it is. No figures are loaded.
 */
export function ReportPreview({ report, organisationId }: { report: Dashboard; organisationId: string }) {
  const theme = BUILT_IN_THEMES[isBuiltInTheme(report.settings.theme) ? report.settings.theme : DEFAULT_THEME_ID];
  const { light, dark } = theme;
  const colours = {
    "--mini-page": `light-dark(${light.page}, ${dark.page})`,
    "--mini-card": `light-dark(${light.card}, ${dark.card})`,
    "--mini-text": `light-dark(${light.mutedText}, ${dark.mutedText})`,
    ...Object.fromEntries([0, 1, 2, 3].map((index) => [`--mini-${index + 1}`, `light-dark(${light.series[index]}, ${dark.series[index]})`])),
  } as CSSProperties;
  const pages = reportPages(report.settings.pages);
  // A hidden drill-through page should not be the picture shown in the library.
  const first = pages.find((entry) => !entry.hidden) ?? pages[0];
  const tiles = report.tiles.filter((tile) => !first || tilePage(tile, report.settings.pages) === first.id);
  const page = first ? pageStyle(first, { organisationId, dashboardId: report.id }).style : {};
  // The page's own width isn't wanted here: the picture fills the card.
  const background: CSSProperties = { background: page.background, colorScheme: "light dark" };
  return (
    <div className={styles.preview} style={{ ...colours, ...background }} aria-hidden="true">
      {tiles.length ? (
        <div className={styles.grid}>
          {tiles.slice(0, MOST_TILES).map((tile) => (
            <div
              key={tile.id}
              className={`${styles.tile} ${tile.visual === "text" || tile.visual === "image" ? styles.plain : ""}`}
              style={{ gridColumn: `span ${COLUMNS[tile.width] ?? 12}`, gridRow: `span ${ROWS[tile.height ?? "medium"] ?? 2}` }}
            >
              {tile.visual !== "image" && tile.visual !== "shape" && tile.visual !== "button" ? <span className={styles.tileTitle}>{tile.title}</span> : null}
              <span className={styles.tileVisual}><Glyph tile={tile} organisationId={organisationId} dashboardId={report.id} /></span>
            </div>
          ))}
        </div>
      ) : first?.picture ? null : (
        <span className={styles.blank}>Blank report</span>
      )}
    </div>
  );
}

function Glyph({ tile, organisationId, dashboardId }: { tile: Tile; organisationId: string; dashboardId: string }): ReactNode {
  switch (tile.visual) {
    case "kpi":
    case "gauge":
    case "bullet":
      return (
        <span className={styles.kpi}>
          <i />
          <b />
        </span>
      );
    case "text":
    case "signoff":
    case "directory":
    case "report":
      return (
        <span className={styles.lines}>
          <b />
          <i />
          <i />
        </span>
      );
    case "table":
    case "pivot":
    case "heatmap":
    case "calendar":
      return (
        <span className={styles.table}>
          {[0, 1, 2, 3].map((row) => (
            <i key={row} />
          ))}
        </span>
      );
    case "image":
      return tile.image ? (
        <span
          className={styles.picture}
          style={{
            backgroundImage: `url("/api/analytics/dashboards/${encodeURIComponent(dashboardId)}/images/${encodeURIComponent(tile.image.id)}?organisationId=${encodeURIComponent(organisationId)}")`,
            backgroundSize: tile.image.fit === "cover" ? "cover" : "contain",
          }}
        />
      ) : null;
    case "pie":
    case "donut":
      return (
        <svg viewBox="0 0 40 40" className={styles.svg}>
          <circle cx="20" cy="20" r="14" fill="none" stroke="var(--mini-1)" strokeWidth="9" strokeDasharray="50 88" />
          <circle cx="20" cy="20" r="14" fill="none" stroke="var(--mini-2)" strokeWidth="9" strokeDasharray="25 88" strokeDashoffset="-50" />
          <circle cx="20" cy="20" r="14" fill="none" stroke="var(--mini-3)" strokeWidth="9" strokeDasharray="13 88" strokeDashoffset="-75" />
        </svg>
      );
    case "line":
    case "area":
    case "combo":
    case "scatter":
      return (
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className={styles.svg}>
          {tile.visual === "area" ? <path d="M0 32 L20 24 L40 27 L60 14 L80 18 L100 8 L100 40 L0 40 Z" fill="var(--mini-1)" opacity="0.25" /> : null}
          <polyline points="0,32 20,24 40,27 60,14 80,18 100,8" fill="none" stroke="var(--mini-1)" strokeWidth="3" vectorEffect="non-scaling-stroke" />
          {tile.visual === "combo" ? <polyline points="0,20 25,22 50,16 75,20 100,15" fill="none" stroke="var(--mini-2)" strokeWidth="2" vectorEffect="non-scaling-stroke" /> : null}
          {tile.visual === "scatter" ? [ [12, 26], [32, 16], [51, 23], [72, 9], [87, 15] ].map(([cx, cy]) => <circle key={cx} cx={cx} cy={cy} r="3.3" fill="var(--mini-2)" />) : null}
        </svg>
      );
    case "bar":
      return (
        <span className={styles.barsAcross}>
          {[90, 70, 52, 34].map((width, index) => (
            <i key={width} style={{ width: `${width}%`, background: `var(--mini-${(index % 4) + 1})` }} />
          ))}
        </span>
      );
    case "treemap":
      return (
        <span className={styles.treemap}>
          <i style={{ background: "var(--mini-1)" }} />
          <i style={{ background: "var(--mini-2)" }} />
          <i style={{ background: "var(--mini-3)" }} />
        </span>
      );
    case "shape":
    case "button":
      return null;
    default:
      // Columns, waterfalls, funnels, histograms and the rest: upright bars.
      return (
        <span className={styles.bars}>
          {[45, 70, 55, 90, 65].map((height, index) => (
            <i key={index} style={{ height: `${height}%` }} />
          ))}
        </span>
      );
  }
}
