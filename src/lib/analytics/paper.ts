/** Paper a report prints on. */
export type Paper = "landscape" | "portrait";

export const PAPERS: { value: Paper; label: string }[] = [
  { value: "landscape", label: "A4, landscape" },
  { value: "portrait", label: "A4, portrait" },
];

/**
 * A page is shrunk to fit one sheet down to this, so a report page prints as
 * one slide where it can (was 70%); longer than that, it carries on
 * over more sheets.
 */
export const SMALLEST_SHEET_SCALE = 0.5;

/**
 * How much a report page is shrunk to fit one sheet: 1 when it fits, and
 * otherwise the share of its height the sheet has room for. A page is drawn
 * wider by the same share, so its tiles keep their shape.
 */
export function sheetScale(room: number, needs: number): number {
  if (!(room > 0) || !(needs > room)) return 1;
  return Math.max(SMALLEST_SHEET_SCALE, room / needs);
}

/** True when the page is too long to shrink onto one sheet, so it carries on over more. */
export function sheetCarriesOn(room: number, needs: number): boolean {
  return room > 0 && needs * SMALLEST_SHEET_SCALE > room + 0.5;
}

/**
 * Something a sheet's edge mustn't cut through: a table row, a chart, a line
 * of text. Top and bottom from the page's top. `heading` marks a heading (a
 * tile's title, a statement's section heading, a table's column headings):
 * a sheet never ends straight after one.
 */
export type SolidBox = { top: number; bottom: number; heading?: boolean };

/** A table on the page, for repeating its column headings where it carries on. */
export type TableBox = { top: number; bottom: number; headBottom: number };

/** One sheet's slice of a long page; `table` is the table (by position in the list given) whose column headings go at its top. */
export type SheetSlice = { from: number; to: number; table?: number };

/** The most sheets one report page carries on over; the rest is left off and the screen says so. */
export const MOST_SHEETS_A_PAGE = 30;

/**
 * Where a long page is cut into sheets: each slice is
 * at most a sheet tall and ends at the edge of a row, chart or paragraph,
 * never through one and never straight after a heading, even when that
 * leaves the sheet short. Only when nothing ends cleanly on the
 * sheet (one thing taller than a sheet) is it cut at the sheet's edge, so a
 * page always moves on.
 * A slice that starts part-way down a table leaves room for that table's
 * column headings, which are drawn again at its top.
 */
export function sheetSlices(room: number, needs: number, solids: SolidBox[], tables: TableBox[] = []): SheetSlice[] {
  if (!(room > 0) || !(needs > 0)) return [{ from: 0, to: Math.max(0, needs) }];
  const edges = [...new Set(solids.flatMap((box) => [box.top, box.bottom]))].sort((a, b) => a - b);
  const cuts = (y: number) => solids.some((box) => box.top + 0.5 < y && y < box.bottom - 0.5);
  // Straight after a heading: the last thing to end at or before the cut is a heading, with nothing but headings ending there.
  const strands = (y: number) => {
    let last = -Infinity;
    let heading = false;
    for (const box of solids) {
      if (box.bottom > y + 0.5) continue;
      if (box.bottom > last + 0.5) {
        last = box.bottom;
        heading = Boolean(box.heading);
      } else if (Math.abs(box.bottom - last) <= 0.5 && !box.heading) {
        heading = false;
      }
    }
    return heading && y < needs - 0.5;
  };
  const continued = (from: number) => tables.findIndex((table) => table.headBottom - 0.5 <= from && from < table.bottom - 0.5 && from > table.top + 0.5);
  const slices: SheetSlice[] = [];
  let from = 0;
  for (;;) {
    const table = from > 0 ? continued(from) : -1;
    const head = table >= 0 ? tables[table].headBottom - tables[table].top : 0;
    // Column headings that would leave under half a sheet aren't repeated.
    const space = head > 0 && head < room / 2 ? room - head : room;
    const slice: SheetSlice = { from, to: from, ...(space < room ? { table } : {}) };
    if (needs - from <= space + 0.5 || slices.length >= MOST_SHEETS_A_PAGE - 1) {
      slice.to = Math.min(needs, from + space);
      slices.push(slice);
      return slices;
    }
    const limit = from + space;
    let to = limit;
    // The lowest clean edge on the sheet; a short sheet is better than a tile cut in two, so the
    // search carries on above a third of the way down, and only a single thing taller than a sheet is cut.
    for (let index = edges.length - 1; index >= 0; index -= 1) {
      const edge = edges[index];
      if (edge > limit) continue;
      if (edge <= from + 0.5) break;
      if (!cuts(edge) && !strands(edge)) {
        to = edge;
        break;
      }
    }
    slice.to = to;
    slices.push(slice);
    from = to;
  }
}

/** Where the contents sheet goes: the first sheet, or the second, behind a cover page. */
export type ContentsPlace = "first" | "after_cover";

export const CONTENTS_PLACES: { value: ContentsPlace | "none"; label: string }[] = [
  { value: "none", label: "No contents" },
  { value: "first", label: "Contents first" },
  { value: "after_cover", label: "Contents after the cover" },
];

/**
 * How a report prints, saved with the report. Left
 * out: A4 landscape, no contents, no running header, no cover. `header`
 * puts the organisation's and the report's name at the top of each sheet.
 * `cover` says the first page is a cover: it prints with nothing at its top
 * or foot.
 */
export type PaperSettings = { size: Paper; contents?: ContentsPlace; header?: true; cover?: true; contentsTiles?: true };

/** A tile's title on a page, with which of the page's sheets it starts on (0 for the first), for the contents. */
export type PageOutline = Array<{ title: string; sheet: number }>;

/** The most tiles the contents list under one page; a page with more lists its first ones. */
export const MOST_TILES_IN_CONTENTS = 12;

/** True when the first page prints as a cover: said outright, or implied by a contents sheet placed behind it. */
export function hasCover(paper: Pick<PaperSettings, "contents" | "cover"> | undefined, pages: number): boolean {
  return pages > 1 && Boolean(paper?.cover || paper?.contents === "after_cover");
}

/** Thrown for a paper setting that isn't one of the choices; the caller turns it into its own error. */
export class PaperError extends Error {}

export function parsePaper(input: unknown): PaperSettings | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) throw new PaperError('paper is { size: "landscape" or "portrait", contents: "first" or "after_cover", header: true or false, cover: true or false }; all optional.');
  const raw = input as Record<string, unknown>;
  const size = raw.size ?? "landscape";
  if (size !== "landscape" && size !== "portrait") throw new PaperError('Paper size is "landscape" or "portrait" (both A4).');
  const contents = raw.contents === undefined || raw.contents === null || raw.contents === "none" ? undefined : raw.contents;
  if (contents !== undefined && contents !== "first" && contents !== "after_cover") throw new PaperError('Contents is "first", "after_cover" or "none".');
  for (const name of ["header", "cover", "contentsTiles"] as const) {
    if (raw[name] !== undefined && raw[name] !== null && typeof raw[name] !== "boolean") throw new PaperError(`${name} is true or false.`);
  }
  const header = raw.header === true;
  const cover = raw.cover === true;
  // Tiles are only listed where there's a contents sheet to list them on.
  const contentsTiles = raw.contentsTiles === true && Boolean(contents);
  // The default isn't stored, so a report nobody has set up for paper stays as it was.
  if (size === "landscape" && !contents && !header && !cover) return undefined;
  return { size, ...(contents ? { contents } : {}), ...(header ? { header } : {}), ...(cover ? { cover } : {}), ...(contentsTiles ? { contentsTiles } : {}) };
}

export type PrintSheet =
  /** `number` is the page's first sheet; `count` how many sheets it takes (more than 1 when it carries on). */
  | { kind: "page"; pageId: string; name: string; number: number; count: number }
  /** `tile` marks a tile's title listed under its page. */
  | { kind: "contents"; number: number; entries: { name: string; number: number; tile?: true }[] };

/**
 * The sheets a report prints as, in order, numbered from 1. The contents
 * sheet lists the pages that come after it, by name, with their sheet
 * numbers. A report with one page has nothing to list, so it gets none.
 * With `outlines`, each page's tiles are listed under it by title, with the
 * sheet each starts on; a tile named as its page is left out.
 */
export function printSheets(
  pages: { id: string; name: string }[],
  contents: ContentsPlace | undefined,
  counts: Record<string, number> = {},
  outlines?: Record<string, PageOutline>,
): PrintSheet[] {
  const place = pages.length > 1 ? contents : undefined;
  const before = place === "after_cover" ? 1 : 0;
  const sheets: PrintSheet[] = [];
  let next = 1;
  pages.forEach((page, index) => {
    if (place && index === before) {
      sheets.push({ kind: "contents", number: next, entries: [] });
      next += 1;
    }
    const count = Math.max(1, Math.floor(counts[page.id] ?? 1));
    sheets.push({ kind: "page", pageId: page.id, name: page.name, number: next, count });
    next += count;
  });
  for (const sheet of sheets) {
    if (sheet.kind !== "contents") continue;
    sheet.entries = sheets.flatMap((other) => {
      if (other.kind !== "page" || other.number <= sheet.number) return [];
      const tiles = (outlines?.[other.pageId] ?? [])
        .filter((tile) => tile.title.trim() !== "" && tile.title.trim().toLowerCase() !== other.name.trim().toLowerCase())
        .slice(0, MOST_TILES_IN_CONTENTS)
        .map((tile) => ({ name: tile.title.trim(), number: other.number + Math.min(Math.max(0, tile.sheet), other.count - 1), tile: true as const }));
      return [{ name: other.name, number: other.number }, ...tiles];
    });
  }
  return sheets;
}

/** How many sheets of paper the list prints as. */
export function sheetTotal(sheets: PrintSheet[]): number {
  return sheets.reduce((total, sheet) => total + (sheet.kind === "page" ? sheet.count : 1), 0);
}
