/**
 * Changing a text box or a heading in place on the report. The editor works on a draft copy of the tile: the report shows the
 * draft as it's typed, Save puts it in the report and saves, and Cancel
 * drops it, so the saved report never changes until Save. Shared with the
 * browser; nothing here reads or writes the database.
 */

import type { ChartFormat, TextStyle } from "@/lib/analytics/chart-format";
import type { Tile } from "@/lib/analytics/dashboards";
import { colourSpan, MAX_RICH_TEXT, withoutColours } from "@/lib/analytics/rich-text";

export const MAX_HEADING = 100;

/** What's being edited in place: a text box's words and look, or any tile's heading. */
export type InPlaceEdit = {
  mode: "text" | "heading";
  /** The tile as it was before; null for a new text box (Cancel leaves nothing behind). */
  original: Tile | null;
  /** The draft as it was when the editor opened, to tell whether anything has changed. */
  start: Tile;
  draft: Tile;
};

/** A new, empty text box, not in the report until it's saved. */
export function newTextTile(id: string): Tile {
  return { id, title: "Text", visual: "text", width: "full", query: null, text: "", textFormat: "rich" };
}

/** Plain notes, written so they read the same as rich text (the markers kept as typed). */
export function escapeMarkers(text: string): string {
  return text.replace(/[\\*{}[\]]/g, (marker) => `\\${marker}`);
}

/**
 * Opens a tile for editing. Plain notes become rich text in the draft only,
 * with their characters kept as they are, so the formatting buttons work and
 * the words don't change. The saved report isn't touched.
 */
export function startEdit(tile: Tile | null, mode: InPlaceEdit["mode"], newId: string): InPlaceEdit {
  const draft = tile ? (mode === "text" && tile.textFormat !== "rich" ? { ...tile, text: escapeMarkers(tile.text ?? ""), textFormat: "rich" as const } : tile) : newTextTile(newId);
  return { mode, original: tile, start: draft, draft };
}

/** True once the draft is different from how it opened. */
export function hasChanged(edit: InPlaceEdit): boolean {
  return JSON.stringify(edit.start) !== JSON.stringify(edit.draft);
}

/** What stops the draft being saved. Cancel and leaving always work, whatever this says. */
export function draftProblems(edit: InPlaceEdit): string[] {
  const problems: string[] = [];
  const { draft } = edit;
  if (draft.title.trim().length > MAX_HEADING) problems.push(`The heading can be up to ${MAX_HEADING} characters.`);
  if (edit.mode === "text") {
    const text = draft.text ?? "";
    if (text.length > MAX_RICH_TEXT) problems.push(`The text can be up to ${MAX_RICH_TEXT.toLocaleString("en-NZ")} characters; it has ${text.length.toLocaleString("en-NZ")}.`);
    if (!edit.original && !text.trim()) problems.push("Type some text first, or Cancel to leave without adding a box.");
  }
  return problems;
}

/** The draft as it's saved: the heading trimmed (or the box's name when it's blank), the text trimmed, no empty format. */
export function finishDraft(edit: InPlaceEdit): Tile {
  const tile: Tile = { ...edit.draft, title: edit.draft.title.trim() || (edit.mode === "text" ? "Text" : (edit.original?.title ?? "Chart")) };
  if (edit.mode === "text") {
    const text = (tile.text ?? "").trim();
    if (text) tile.text = text;
    else delete tile.text;
  }
  return withFormat(tile, tile.format);
}

/** The report's tiles with the draft in its place, or added at the end when it's new. */
export function withDraft(tiles: Tile[], draft: Tile): Tile[] {
  return tiles.some((tile) => tile.id === draft.id) ? tiles.map((tile) => (tile.id === draft.id ? draft : tile)) : [...tiles, draft];
}

function withFormat(tile: Tile, format: ChartFormat | undefined): Tile {
  const next = { ...tile };
  delete next.format;
  const card = format?.card ? Object.fromEntries(Object.entries(format.card).filter(([, value]) => value !== undefined && !(typeof value === "object" && value !== null && Object.keys(value).length === 0))) : undefined;
  const rest = { ...format };
  delete rest.card;
  const clean: ChartFormat = { ...rest, ...(card && Object.keys(card).length ? { card } : {}) };
  return Object.keys(clean).length ? { ...next, format: clean } : next;
}

function cleanStyle<T extends object>(style: T): T | undefined {
  const kept = Object.fromEntries(Object.entries(style).filter(([, value]) => value !== undefined)) as T;
  return Object.keys(kept).length ? kept : undefined;
}

/** Changes the whole box's look (size, bold, italic, colour, alignment); undefined puts that part back to the theme's. */
export function setBodyStyle(tile: Tile, patch: Partial<TextStyle>): Tile {
  const card = { ...tile.format?.card };
  const body = cleanStyle({ ...card.body, ...patch });
  if (body) card.body = body;
  else delete card.body;
  return withFormat(tile, { ...tile.format, card });
}

/** Changes the heading: its words, whether it shows, and its colour (undefined for the theme's). Nothing about the data changes. */
export function setHeading(tile: Tile, patch: { title?: string; show?: boolean; color?: string | null }): Tile {
  const card = { ...tile.format?.card };
  if (patch.show !== undefined) {
    if (patch.show) delete card.showTitle;
    else card.showTitle = false;
  }
  if (patch.color !== undefined) {
    const title = cleanStyle({ ...card.title, color: patch.color ?? undefined });
    if (title) card.title = title;
    else delete card.title;
  }
  return withFormat({ ...tile, ...(patch.title !== undefined ? { title: patch.title } : {}) }, { ...tile.format, card });
}

/** A change to the words, with where the selection is afterwards. */
export type TextChange = { text: string; start: number; end: number };

/** Puts markers around the chosen words (e.g. ** for bold); with nothing chosen, puts them at the cursor with the cursor between. */
export function wrapSelection(text: string, start: number, end: number, before: string, after: string): TextChange {
  const chosen = text.slice(start, end);
  return { text: `${text.slice(0, start)}${before}${chosen}${after}${text.slice(end)}`, start: start + before.length, end: start + before.length + chosen.length };
}

/** Makes each chosen line a list item ("- " or "1. "). */
export function listLines(text: string, start: number, end: number, numbered: boolean): TextChange {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const toBreak = text.indexOf("\n", end);
  const to = toBreak === -1 ? text.length : toBreak;
  const lines = text.slice(from, to).split("\n").map((line, index) => `${numbered ? `${index + 1}. ` : "- "}${line.replace(/^\s*(?:[-*•]|\d{1,3}[.)])\s+/, "")}`);
  const joined = lines.join("\n");
  return { text: `${text.slice(0, from)}${joined}${text.slice(to)}`, start: from, end: from + joined.length };
}

/** Colours the chosen words (any colour already on them is replaced). */
export function colourSelection(text: string, start: number, end: number, colour: string): TextChange {
  const chosen = withoutColours(text.slice(start, end));
  const span = colourSpan(chosen, colour);
  const open = span.indexOf("}") + 1;
  return { text: `${text.slice(0, start)}${span}${text.slice(end)}`, start: start + open, end: start + open + chosen.length };
}

/** Takes the colour off the chosen words, back to the box's colour. */
export function clearColourSelection(text: string, start: number, end: number): TextChange {
  const chosen = withoutColours(text.slice(start, end));
  return { text: `${text.slice(0, start)}${chosen}${text.slice(end)}`, start, end: start + chosen.length };
}

/** The colours offered with one click: the theme's text colours, then its first chart colours. */
export function themeSwatches(colours: { text: string; mutedText: string; series: string[] }): string[] {
  const all = [colours.text, colours.mutedText, ...colours.series.slice(0, 6)].map((colour) => colour.toLowerCase()).filter((colour) => /^#[0-9a-f]{6}$/.test(colour));
  return [...new Set(all)];
}
