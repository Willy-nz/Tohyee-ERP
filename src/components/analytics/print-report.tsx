"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DashboardView } from "@/components/analytics-dashboards";
import { type AnalyticsEmbed, AnalyticsEmbedContext } from "@/components/analytics/embed-context";
import { api, errorMessage } from "@/lib/client/api";
import { downloadReportPdf, pdfFileName } from "@/components/analytics/report-pdf";
import { useApiData } from "@/components/hooks";
import { useWorkspace } from "@/components/workspace";
import { Button, Notice } from "@/components/ui";
import type { Dashboard } from "@/lib/analytics/dashboards";
import { reportPages } from "@/lib/analytics/pages";
import { CONTENTS_PLACES, type ContentsPlace, MOST_SHEETS_A_PAGE, PAPERS, type Paper, hasCover, type PageOutline, type PrintSheet, printSheets, sheetCarriesOn, sheetScale, type SheetSlice, sheetSlices, sheetTotal, type SolidBox, type TableBox } from "@/lib/analytics/paper";
import styles from "./print-report.module.css";

/** A statement's section heading, or a table's column headings: a row with nothing after its first cell. */
function headingRow(row: Element): boolean {
  if (row.parentElement?.tagName === "THEAD") return true;
  const cells = Array.from((row as HTMLTableRowElement).cells ?? []);
  return cells.length > 0 && cells.slice(1).every((cell) => (cell.textContent ?? "").trim() === "") && (cells[0].textContent ?? "").trim() !== "";
}

/** Text and commentary tiles, as the report marks them: their writing may run over sheets. */
const FLOWING_TILES = 'section[data-flows="true"]';

/** What a sheet's edge mustn't cut through, measured from the top of the page as drawn at full size. */
function solidBoxes(inner: HTMLElement): SolidBox[] {
  const origin = inner.getBoundingClientRect();
  const drawn = inner.offsetHeight > 0 ? origin.height / inner.offsetHeight : 1;
  const boxes: SolidBox[] = [];
  const add = (element: Element, heading = false) => {
    const rect = element.getBoundingClientRect();
    if (rect.height > 0) boxes.push({ top: Math.round((rect.top - origin.top) / drawn), bottom: Math.round((rect.bottom - origin.top) / drawn), ...(heading ? { heading } : {}) });
  };
  inner.querySelectorAll("tr").forEach((row) => add(row, headingRow(row)));
  inner.querySelectorAll("h1, h2, h3, h4").forEach((heading) => add(heading, true));
  // The lines between a tile's title and its table (a subtitle, "Draft: worked out…") go with the title: a sheet doesn't end after them either.
  const lead = new Set<Element>();
  inner.querySelectorAll("section").forEach((section) => {
    const table = section.querySelector("table");
    if (!table) return;
    const tableTop = table.getBoundingClientRect().top;
    section.querySelectorAll("p").forEach((line) => {
      if (line.getBoundingClientRect().bottom <= tableTop + 1) lead.add(line);
    });
  });
  // Writing carries on down onto the next sheet: a text or commentary tile isn't kept in one piece,
  // and its paragraphs can be cut between lines, never through one.
  const flows = (element: Element) => element.closest(FLOWING_TILES) !== null;
  const lines = (element: Element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rows: SolidBox[] = [];
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.height <= 0) continue;
      const top = Math.round((rect.top - origin.top) / drawn);
      const bottom = Math.round((rect.bottom - origin.top) / drawn);
      const same = rows.find((row) => top < row.bottom - 1 && bottom > row.top + 1);
      if (same) {
        same.top = Math.min(same.top, top);
        same.bottom = Math.max(same.bottom, bottom);
      } else rows.push({ top, bottom });
    }
    // No line of a paragraph is left alone at a sheet's foot or top: the first two lines stay
    // together, and the last two. A paragraph of three lines or fewer can't be cut without leaving one alone.
    if (rows.length <= 3) return [];
    rows.sort((first, second) => first.top - second.top);
    const [one, two, ...rest] = rows;
    const last = rest.pop()!;
    const beforeLast = rest.pop()!;
    return [{ top: one.top, bottom: two.bottom }, ...rest, { top: beforeLast.top, bottom: last.bottom }];
  };
  inner.querySelectorAll("svg, canvas, img, p, li").forEach((element) => {
    if ((element.tagName === "P" || element.tagName === "LI") && flows(element)) {
      const rows = lines(element);
      if (rows.length > 1) {
        boxes.push(...rows);
        return;
      }
    }
    add(element, lead.has(element));
  });
  // A tile with no table in it (a figure, a chart, a picture) stays in one piece; writing doesn't have to.
  inner.querySelectorAll("section").forEach((section) => {
    if (!section.querySelector("tr") && !section.matches(FLOWING_TILES)) add(section);
  });
  return boxes;
}

/** A table's column headings, copied to draw again at the top of a sheet the table carries on to. */
type RepeatedHead = { html: string; left: number; width: number; height: number };

/** The page's tables that have column headings, with a copy of each one's headings at the widths it's drawn at. */
function tableHeads(inner: HTMLElement): { boxes: TableBox[]; heads: RepeatedHead[] } {
  const origin = inner.getBoundingClientRect();
  const drawn = inner.offsetHeight > 0 ? origin.height / inner.offsetHeight : 1;
  const boxes: TableBox[] = [];
  const heads: RepeatedHead[] = [];
  inner.querySelectorAll("table").forEach((table) => {
    const head = table.tHead;
    const last = head?.rows[head.rows.length - 1];
    if (!head || !last) return;
    const rect = table.getBoundingClientRect();
    const headRect = head.getBoundingClientRect();
    if (rect.height <= 0 || headRect.height <= 0) return;
    const widths = Array.from(last.cells).map((cell) => cell.getBoundingClientRect().width / drawn);
    boxes.push({ top: Math.round((rect.top - origin.top) / drawn), bottom: Math.round((rect.bottom - origin.top) / drawn), headBottom: Math.round((headRect.bottom - origin.top) / drawn) });
    const copy = document.createElement("table");
    copy.className = table.className;
    copy.setAttribute("aria-hidden", "true");
    copy.style.cssText = `width:${rect.width / drawn}px;table-layout:fixed;margin:0`;
    const columns = document.createElement("colgroup");
    for (const width of widths) {
      const column = document.createElement("col");
      column.style.width = `${width}px`;
      columns.appendChild(column);
    }
    copy.appendChild(columns);
    copy.appendChild(head.cloneNode(true));
    // The copy is only to look at: nothing in it takes a click or an id.
    copy.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
    heads.push({ html: copy.outerHTML, left: (rect.left - origin.left) / drawn, width: rect.width / drawn, height: Math.ceil(headRect.height / drawn) });
  });
  return { boxes, heads };
}

/** The page's tile titles that show, with how far down the page each is. */
function tileTitles(inner: HTMLElement): Array<{ title: string; top: number }> {
  const origin = inner.getBoundingClientRect();
  const drawn = inner.offsetHeight > 0 ? origin.height / inner.offsetHeight : 1;
  const titles: Array<{ title: string; top: number }> = [];
  inner.querySelectorAll("section h2").forEach((heading) => {
    const rect = heading.getBoundingClientRect();
    const title = (heading.textContent ?? "").trim();
    // A hidden title is a pixel high: it isn't on the paper, so it isn't in the contents.
    if (rect.height > 4 && title) titles.push({ title, top: (rect.top - origin.top) / drawn });
  });
  return titles;
}

type Slice = SheetSlice & { head?: RepeatedHead };
const WHOLE: Slice[] = [{ from: 0, to: 0 }];

/**
 * One report page on paper. The page is drawn at the sheet's width. A page
 * a little longer than the sheet is shrunk to fit, and the screen says so
 * (the note doesn't print). A much longer one, usually an accounting report,
 * carries on over more sheets, cut between rows.
 */
/** What goes round a sheet: a running header, or nothing at all on a cover. */
type Furniture = { header: { left: string; right: string } | null; bare: boolean };

function PageSheets({ organisationId, dashboardId, pageId, name, number, of, paper, onCount, onOutline, furniture }: { organisationId: string; dashboardId: string; pageId: string; name: string; number: number; of: number; paper: Paper; onCount: (pageId: string, count: number) => void; onOutline: (pageId: string, outline: PageOutline) => void; furniture: Furniture }) {
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // The room on the sheet changes with what's round it, so the page is measured again.
  const bare = furniture.bare;
  const headed = furniture.header !== null;
  const [scale, setScale] = useState(1);
  const [slices, setSlices] = useState<Slice[]>(WHOLE);
  useEffect(() => {
    const outer = frame.current;
    const inner = content.current;
    if (!outer || !inner || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const room = outer.clientHeight;
      const needs = inner.scrollHeight;
      const carriesOn = sheetCarriesOn(room, needs);
      const nextScale = carriesOn ? 1 : sheetScale(room, needs);
      setScale((current) => (Math.abs(current - nextScale) > 0.005 ? nextScale : current));
      let nextSlices = WHOLE;
      if (carriesOn) {
        const tables = tableHeads(inner);
        nextSlices = sheetSlices(room, needs, solidBoxes(inner), tables.boxes).map((slice) => (slice.table === undefined ? slice : { ...slice, head: tables.heads[slice.table] }));
      }
      setSlices((current) => (JSON.stringify(current) === JSON.stringify(nextSlices) ? current : nextSlices));
      // Which sheet each tile starts on, for the contents.
      onOutline(
        pageId,
        tileTitles(inner).map((tile) => ({ title: tile.title, sheet: Math.max(0, carriesOn ? nextSlices.findIndex((slice) => tile.top < slice.to - 0.5) : 0) })),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    measure();
    return () => observer.disconnect();
  }, [paper, bare, headed, onOutline, pageId]);
  useEffect(() => onCount(pageId, slices.length), [onCount, pageId, slices.length]);
  // The report's own page, read-only, with its saved dates: what the embed context is for.
  const embed = useMemo<AnalyticsEmbed>(() => ({ pageId, tileId: null, showFilters: false, print: paper, imageSource: async (path) => path }), [pageId, paper]);
  const carriesOn = slices.length > 1;
  return (
    <>
      {slices.map((slice, index) => (
        <section key={index} className={`${styles.sheet} ${paper === "portrait" ? styles.portrait : styles.landscape} ${furniture.bare ? styles.bare : furniture.header ? styles.withHead : ""}`} aria-label={`Sheet ${number + index}: ${name}${index ? " (continued)" : ""}`}>
          {furniture.header && !furniture.bare ? (
            <div className={styles.head}>
              <span>{furniture.header.left}</span>
              <span>{furniture.header.right}</span>
            </div>
          ) : null}
          <div ref={index === 0 ? frame : undefined} className={styles.frame}>
            {/* Each sheet of a long page shows its own slice of the same page. */}
            {slice.head ? <div className={styles.repeatedHead} style={{ marginLeft: slice.head.left, width: slice.head.width, height: slice.head.height }} dangerouslySetInnerHTML={{ __html: slice.head.html }} /> : null}
            <div className={carriesOn ? styles.slice : undefined} style={carriesOn ? { height: slice.to - slice.from } : undefined}>
              <div
                ref={index === 0 ? content : undefined}
                className={styles.fit}
                style={carriesOn ? { transform: `translateY(${-slice.from}px)` } : scale < 1 ? { transform: `scale(${scale})`, width: `${100 / scale}%`, marginLeft: `${(100 - 100 / scale) / 2}%` } : undefined}
              >
                <AnalyticsEmbedContext.Provider value={embed}>
                  <DashboardView organisationId={organisationId} dashboardId={dashboardId} startEditing={false} />
                </AnalyticsEmbedContext.Provider>
              </div>
            </div>
          </div>
          {furniture.bare ? null : (
            <div className={styles.foot}>
              <span>
                {name}
                {index ? " (continued)" : ""}
              </span>
              <span>
                Page {number + index} of {of}
              </span>
            </div>
          )}
        </section>
      ))}
      {carriesOn ? (
        <p className={styles.shrunk} data-print="hide">
          {`“${name}” is too long for one sheet, so it carries on over ${slices.length} sheets, cut between rows.${slices.length >= MOST_SHEETS_A_PAGE ? ` That's the most one page can take: the rest is left off.` : ""}`}
        </p>
      ) : scale < 1 ? (
        <p className={styles.shrunk} data-print="hide">
          {`“${name}” is a little longer than a sheet, so it's shrunk to ${Math.round(scale * 100)}% to fit. Fewer tiles on the page, or a second page, would print larger.`}
        </p>
      ) : null}
    </>
  );
}

/** The contents sheet: the pages after it by name, with the sheet each is on. */
function ContentsSheet({ sheet, reportName, of, paper, header }: { sheet: Extract<PrintSheet, { kind: "contents" }>; reportName: string; of: number; paper: Paper; header: Furniture["header"] }) {
  return (
    <section className={`${styles.sheet} ${paper === "portrait" ? styles.portrait : styles.landscape} ${header ? styles.withHead : ""}`} aria-label={`Sheet ${sheet.number}: Contents`}>
      {header ? (
        <div className={styles.head}>
          <span>{header.left}</span>
          <span>{header.right}</span>
        </div>
      ) : null}
      <div className={`${styles.frame} ${styles.contents}`}>
        <h2>Contents</h2>
        <ol>
          {sheet.entries.map((entry) => (
            <li key={`${entry.number}:${entry.name}:${entry.tile ? "tile" : "page"}`} className={entry.tile ? styles.contentsTile : undefined}>
              <span>{entry.name}</span>
              <span className={styles.dots} aria-hidden="true" />
              <span>{entry.number}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className={styles.foot}>
        <span>{reportName} · Contents</span>
        <span>
          Page {sheet.number} of {of}
        </span>
      </div>
    </section>
  );
}

/**
 * Print or save as PDF: every page of a report (hidden
 * ones left out), one per A4 sheet, with the report's name and "Page n of N"
 * at the foot. The browser makes the PDF: its print window has "Save as PDF".
 */
export function PrintReport({ organisationId, dashboardId }: { organisationId: string; dashboardId: string }) {
  const { can, organisations } = useWorkspace();
  const loaded = useApiData<{ dashboard: Dashboard }>(`/api/analytics/dashboards/${dashboardId}`, { organisationId });
  // What the person has chosen here; until they choose, the report's own saved paper.
  const [chosen, setChosen] = useState<{ size?: Paper; contents?: ContentsPlace | "none"; header?: boolean; cover?: boolean; contentsTiles?: boolean }>({});
  // Each page's tile titles and the sheet each starts on, as each page measures itself.
  const [outlines, setOutlines] = useState<Record<string, PageOutline>>({});
  const onOutline = useCallback((pageId: string, outline: PageOutline) => setOutlines((current) => (JSON.stringify(current[pageId] ?? []) === JSON.stringify(outline) ? current : { ...current, [pageId]: outline })), []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sheetsRef = useRef<HTMLDivElement>(null);
  const [making, setMaking] = useState<{ done: number; of: number } | null>(null);
  // How many sheets each page takes, as each page measures itself.
  const [counts, setCounts] = useState<Record<string, number>>({});
  const onCount = useCallback((pageId: string, count: number) => setCounts((current) => (current[pageId] === count || (count === 1 && current[pageId] === undefined) ? current : { ...current, [pageId]: count })), []);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return null;
  const dashboard = loaded.data.dashboard;
  const saved = { size: dashboard.settings.paper?.size ?? "landscape", contents: dashboard.settings.paper?.contents ?? "none", header: dashboard.settings.paper?.header === true, cover: dashboard.settings.paper?.cover === true, contentsTiles: dashboard.settings.paper?.contentsTiles === true } as const;
  const paper: Paper = chosen.size ?? saved.size;
  const contents = chosen.contents ?? saved.contents;
  const header = chosen.header ?? saved.header;
  const cover = chosen.cover ?? saved.cover;
  const contentsTiles = (chosen.contentsTiles ?? saved.contentsTiles) && contents !== "none";
  const pages = reportPages(dashboard.settings.pages).filter((page) => !page.hidden);
  const sheets = printSheets(pages, contents === "none" ? undefined : contents, counts, contentsTiles ? outlines : undefined);
  const total = sheetTotal(sheets);
  const changed = paper !== saved.size || contents !== saved.contents || header !== saved.header || cover !== saved.cover || contentsTiles !== (saved.contentsTiles && saved.contents !== "none");
  // The running header: whose report it is on the left, the report on the right.
  const running = header ? { left: organisations.find((organisation) => organisation.id === organisationId)?.displayName ?? "", right: dashboard.name } : null;
  const coverFirst = hasCover({ contents: contents === "none" ? undefined : contents, cover: cover || undefined }, pages.length);
  // Download PDF: the sheets as they show, so the printer can't turn them portrait.
  const download = async () => {
    const found = [...(sheetsRef.current?.querySelectorAll<HTMLElement>(`.${styles.sheet}`) ?? [])];
    if (!found.length) return;
    setError(null);
    setMaking({ done: 0, of: found.length });
    try {
      await downloadReportPdf(found, paper, pdfFileName(dashboard.name), (done, of) => setMaking({ done, of }));
    } catch (caught) {
      setError(`The PDF couldn't be made: ${errorMessage(caught)}. Print, then Save as PDF, still works.`);
    } finally {
      setMaking(null);
    }
  };
  const keep = async () => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/analytics/dashboards/${dashboardId}`, {
        method: "PATCH",
        body: { organisationId, expectedVersion: dashboard.version, settings: { ...dashboard.settings, paper: { size: paper, contents, header, cover, contentsTiles } } },
      });
      setChosen({});
      loaded.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      {/* The paper's size and margins for the printer; the sheets carry their own margins. */}
      <style>{`@page { size: A4 ${paper}; margin: 0; }`}</style>
      <div className={styles.bar} data-print="hide">
        <Link href={`/analytics/dashboards/${dashboardId}`}>← {dashboard.name}</Link>
        <label>
          Paper{" "}
          <select value={paper} onChange={(event) => setChosen({ ...chosen, size: event.target.value as Paper })}>
            {PAPERS.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        {pages.length > 1 ? (
          <label>
            Contents{" "}
            <select value={contents} onChange={(event) => setChosen({ ...chosen, contents: event.target.value as ContentsPlace | "none" })}>
              {CONTENTS_PLACES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {pages.length > 1 && contents !== "none" ? (
          <label title="Each page's tiles are listed under it in the contents, by title.">
            <input type="checkbox" checked={contentsTiles} onChange={(event) => setChosen({ ...chosen, contentsTiles: event.target.checked })} /> List tiles in contents
          </label>
        ) : null}
        <label>
          <input type="checkbox" checked={header} onChange={(event) => setChosen({ ...chosen, header: event.target.checked })} /> Running header
        </label>
        {pages.length > 1 ? (
          <label title="The first page prints with nothing at its top or foot.">
            <input type="checkbox" checked={coverFirst} disabled={contents === "after_cover"} onChange={(event) => setChosen({ ...chosen, cover: event.target.checked })} /> First page is a cover
          </label>
        ) : null}
        {changed && can("bookkeeper") ? (
          <Button variant="secondary" disabled={saving} onClick={keep}>
            {saving ? "Saving…" : "Keep for this report"}
          </Button>
        ) : null}
        <Button disabled={making !== null} onClick={() => void download()}>
          {making ? `Making the PDF… sheet ${Math.min(making.done + 1, making.of)} of ${making.of}` : "Download PDF"}
        </Button>
        <Button variant="secondary" onClick={() => window.print()}>
          Print
        </Button>
        <span>
          {total} {total === 1 ? "sheet" : "sheets"}. Download PDF makes the file here, {paper === "portrait" ? "portrait" : "landscape"}, exactly as the sheets show below, whatever your printer&apos;s settings. To print, choose {paper === "portrait" ? "Portrait" : "Landscape"} in the print window if it asks, with margins None and background graphics on.
        </span>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={styles.sheets} ref={sheetsRef}>
        {sheets.map((sheet) =>
          sheet.kind === "contents" ? (
            <ContentsSheet key={`contents-${paper}`} sheet={sheet} reportName={dashboard.name} of={total} paper={paper} header={running} />
          ) : (
            <PageSheets key={`${sheet.pageId}-${paper}`} organisationId={organisationId} dashboardId={dashboardId} pageId={sheet.pageId} name={pages.length > 1 ? `${dashboard.name} · ${sheet.name}` : dashboard.name} number={sheet.number} of={total} paper={paper} onCount={onCount} onOutline={onOutline} furniture={{ header: running, bare: coverFirst && sheet.pageId === pages[0].id }} />
          ),
        )}
      </div>
    </>
  );
}
