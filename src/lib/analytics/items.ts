import { hexColour } from "@/lib/analytics/chart-format";
import { ValidationError } from "@/lib/errors";

/**
 * A report's non-data items: text (rich,
 * with values), an image, a shape or line, and a button. They sit in the
 * report's grid like charts and are saved on the tile, checked here. Shared
 * with the browser.
 */

export const ITEM_VISUALS = ["text", "image", "shape", "button", "report", "signoff", "directory"] as const;
export type ItemVisual = (typeof ITEM_VISUALS)[number];

export function isItemVisual(visual: string): visual is ItemVisual {
  return (ITEM_VISUALS as readonly string[]).includes(visual);
}

export type ImageItem = {
  /** The stored image's id (one of this report's images). */
  id: string;
  /** Words for people who can't see it; blank for a purely decorative image. */
  alt?: string;
  /** Fit inside the tile (all of it shows) or fill it (edges may be cut off). */
  fit?: "contain" | "cover";
};

/** An accounting report placed on a page: a custom report, draft (worked out when it's read) or published (its frozen copy). */
export type ReportItem = { id: string };

export function parseReportItem(input: unknown, what: string): ReportItem {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (typeof raw.id !== "string" || !/^[1-9]\d{0,17}$/.test(raw.id)) throw new ValidationError(`${what}: choose the report to show.`);
  return { id: raw.id };
}

export const SHAPE_KINDS = ["rectangle", "rounded", "ellipse", "line", "arrow"] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
export type ShapeItem = {
  kind: ShapeKind;
  /** Inside colour (not for lines); left out, a wash of the theme's first colour. */
  fill?: string;
  /** Outline (or line) colour; left out, the theme's first colour. */
  stroke?: string;
  /** Outline or line width in pixels, 0 to 12. */
  strokeWidth?: number;
  /** A line or arrow can run across (the default), down, or corner to corner. */
  direction?: "across" | "down" | "diagonal";
  /** Words on the shape. */
  text?: string;
};

/**
 * What a button does: reset the filters, go to a
 * page, open a bookmark, or go back to the page before (after a
 * drill-through or another button). Adding one: give it a label here,
 * accept it in `parseButton`, and handle it in the report's
 * `runButtonAction` (analytics-dashboards.tsx).
 */
export const BUTTON_ACTIONS = {
  reset_filters: { label: "Reset to the report's default", available: true, target: null },
  go_to_page: { label: "Go to a page", available: true, target: "page" },
  bookmark: { label: "Open a bookmark", available: true, target: "bookmark" },
  back: { label: "Go back", available: true, target: null },
} as const;
export type ButtonAction = keyof typeof BUTTON_ACTIONS;
/** `target`: the page or bookmark a "go to a page" or "open a bookmark" button opens. */
export type ButtonItem = { label: string; action: ButtonAction; target?: string };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseImage(input: unknown, what: string): ImageItem {
  const raw = object(input);
  if (typeof raw.id !== "string" || !/^\d{1,18}$/.test(raw.id)) throw new ValidationError(`${what}: upload an image.`);
  const alt = typeof raw.alt === "string" ? raw.alt.trim() : "";
  if (alt.length > 250) throw new ValidationError(`${what}: the description can be up to 250 characters.`);
  const fit = raw.fit === "cover" ? "cover" : raw.fit === "contain" || raw.fit === undefined || raw.fit === null ? undefined : null;
  if (fit === null) throw new ValidationError(`${what}: choose how the image fits.`);
  return { id: raw.id, ...(alt ? { alt } : {}), ...(fit ? { fit } : {}) };
}

/**
 * A sign-off for a printed report (15 Nov 2026: typed per report): what's being approved, and who signs, each with a line
 * to sign on and, unless turned off, a line for the date.
 */
export type SignoffItem = {
  statement: string;
  signatories: Array<{ name: string; role?: string }>;
  /** Left out, each signatory has a date line. */
  dated?: false;
};
export const SIGNOFF_LIMITS = { statement: 1000, signatories: 8, name: 100 };

export function parseSignoff(input: unknown, what: string): SignoffItem {
  const raw = object(input);
  const statement = typeof raw.statement === "string" ? raw.statement.trim() : "";
  if (statement.length > SIGNOFF_LIMITS.statement) throw new ValidationError(`${what}: the statement can be up to ${SIGNOFF_LIMITS.statement.toLocaleString("en-NZ")} characters.`);
  if (!Array.isArray(raw.signatories) || raw.signatories.length === 0) throw new ValidationError(`${what}: add at least one person who signs.`);
  if (raw.signatories.length > SIGNOFF_LIMITS.signatories) throw new ValidationError(`${what}: up to ${SIGNOFF_LIMITS.signatories} people can sign.`);
  const signatories = raw.signatories.map((entry) => {
    const person = object(entry);
    const name = typeof person.name === "string" ? person.name.trim() : "";
    const role = typeof person.role === "string" ? person.role.trim() : "";
    if (!name) throw new ValidationError(`${what}: each person who signs needs a name.`);
    if (name.length > SIGNOFF_LIMITS.name || role.length > SIGNOFF_LIMITS.name) throw new ValidationError(`${what}: a name or role can be up to ${SIGNOFF_LIMITS.name} characters.`);
    return { name, ...(role ? { role } : {}) };
  });
  if (raw.dated !== undefined && raw.dated !== null && typeof raw.dated !== "boolean") throw new ValidationError(`${what}: dated is true or false.`);
  return { statement, signatories, ...(raw.dated === false ? { dated: false as const } : {}) };
}

/**
 * The organisation's directory on a printed report:
 * what Tohyee holds about the organisation (Settings › Directory), then
 * these extra lines typed for this report.
 */
export type DirectoryItem = { extra: Array<{ label: string; value: string }> };
export const DIRECTORY_ITEM_LIMITS = { extra: 12, label: 60, value: 200 };

export function parseDirectoryItem(input: unknown, what: string): DirectoryItem {
  const raw = object(input);
  if (raw.extra !== undefined && raw.extra !== null && !Array.isArray(raw.extra)) throw new ValidationError(`${what}: the extra lines are a list.`);
  const list = (raw.extra as unknown[] | undefined) ?? [];
  if (list.length > DIRECTORY_ITEM_LIMITS.extra) throw new ValidationError(`${what}: up to ${DIRECTORY_ITEM_LIMITS.extra} extra lines.`);
  const extra = list.flatMap((entry) => {
    const line = object(entry);
    const label = typeof line.label === "string" ? line.label.trim() : "";
    const value = typeof line.value === "string" ? line.value.trim() : "";
    if (!label && !value) return [];
    if (!label || !value) throw new ValidationError(`${what}: each extra line needs a label and what goes beside it.`);
    if (label.length > DIRECTORY_ITEM_LIMITS.label || value.length > DIRECTORY_ITEM_LIMITS.value) throw new ValidationError(`${what}: a label can be up to ${DIRECTORY_ITEM_LIMITS.label} characters and an entry up to ${DIRECTORY_ITEM_LIMITS.value}.`);
    return [{ label, value }];
  });
  return { extra };
}

export function parseShape(input: unknown, what: string): ShapeItem {
  const raw = object(input);
  const kind = raw.kind as ShapeKind;
  if (!SHAPE_KINDS.includes(kind)) throw new ValidationError(`${what}: choose a shape.`);
  let strokeWidth: number | undefined;
  if (raw.strokeWidth !== undefined && raw.strokeWidth !== null && raw.strokeWidth !== "") {
    strokeWidth = Number(raw.strokeWidth);
    if (!Number.isInteger(strokeWidth) || strokeWidth < 0 || strokeWidth > 12) throw new ValidationError(`${what}: the line width is a whole number from 0 to 12.`);
  }
  const direction = raw.direction === undefined || raw.direction === null || raw.direction === "" ? undefined : raw.direction;
  if (direction !== undefined && !["across", "down", "diagonal"].includes(direction as string)) throw new ValidationError(`${what}: choose which way the line runs.`);
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (text.length > 120) throw new ValidationError(`${what}: the words on a shape can be up to 120 characters.`);
  const lineLike = kind === "line" || kind === "arrow";
  return {
    kind,
    ...(!lineLike && raw.fill ? { fill: hexColour(raw.fill, `${what} fill colour`) } : {}),
    ...(raw.stroke ? { stroke: hexColour(raw.stroke, `${what} line colour`) } : {}),
    ...(strokeWidth !== undefined ? { strokeWidth } : {}),
    ...(lineLike && direction ? { direction: direction as ShapeItem["direction"] } : {}),
    ...(text && !lineLike ? { text } : {}),
  };
}

export function parseButton(input: unknown, what: string, targets: { pages: Set<string>; bookmarks: Set<string> } = { pages: new Set(), bookmarks: new Set() }): ButtonItem {
  const raw = object(input);
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label || label.length > 40) throw new ValidationError(`${what}: give the button a label (up to 40 characters).`);
  const action = raw.action as ButtonAction;
  if (!(action in BUTTON_ACTIONS)) throw new ValidationError(`${what}: choose what the button does.`);
  const kind = BUTTON_ACTIONS[action].target;
  if (kind === null) return { label, action };
  const target = typeof raw.target === "string" ? raw.target : "";
  if (!(kind === "page" ? targets.pages : targets.bookmarks).has(target)) throw new ValidationError(`${what}: choose the ${kind} the button opens.`);
  return { label, action, target };
}
