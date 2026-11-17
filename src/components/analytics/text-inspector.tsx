"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { TextValuesFields } from "@/components/analytics/items";
import { Button, Notice } from "@/components/ui";
import type { Tile } from "@/lib/analytics/dashboards";
import type { TableInfo } from "@/components/analytics/report-shared";
import { TILE_WIDTHS, WIDTH_LABELS, type TileWidth } from "@/lib/analytics/layout";
import { parseRichText, safeHref, valueNames, withoutColours } from "@/lib/analytics/rich-text";
import { clearColourSelection, colourSelection, listLines, MAX_HEADING, setBodyStyle, setHeading, wrapSelection, type InPlaceEdit, type TextChange } from "@/lib/analytics/text-edit";
import styles from "./text-inspector.module.css";

const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48];
/** A heading can be up to 32 px, as the format allows. */
const HEADING_SIZES = [12, 14, 16, 18, 20, 24, 28, 32];
const ALIGNMENTS = [
  { value: "left", label: "Left" },
  { value: "center", label: "Centre" },
  { value: "right", label: "Right" },
] as const;

/**
 * The colour of some text: the theme's colours a click away, any
 * other colour from the picker, and Reset back to the theme's. No colour
 * code is needed; the picker takes one too for those who have it.
 */
export function TextColourControl({
  label,
  value,
  swatches,
  target,
  emptyText = "Theme colour",
  onChoose,
  onReset,
}: {
  label: string;
  value: string | undefined;
  swatches: string[];
  /** What's shown when no colour is set. */
  emptyText?: string;
  /** What the colour goes on, e.g. "the chosen words" or "the whole box". */
  target?: string;
  onChoose: (colour: string) => void;
  onReset: () => void;
}) {
  const id = useId();
  return (
    <fieldset className={styles.colour} aria-describedby={target ? `${id}-target` : undefined}>
      <legend>{label}</legend>
      <div className={styles.colourRow}>
        <span className={styles.current} aria-hidden="true" style={value ? { background: value } : undefined} data-theme={value ? undefined : "true"} />
        <span className={styles.currentText}>{value ? value.toUpperCase() : emptyText}</span>
      </div>
      <div className={styles.swatches}>
        {swatches.map((colour) => (
          <button
            key={colour}
            type="button"
            className={styles.swatch}
            style={{ background: colour }}
            aria-label={`${label}: ${colour.toUpperCase()}`}
            aria-pressed={value === colour}
            title={colour.toUpperCase()}
            onClick={() => onChoose(colour)}
          />
        ))}
        <label className={styles.picker} title="Any colour">
          <input type="color" aria-label={`${label}: any colour`} value={value ?? "#000000"} onChange={(event) => onChoose(event.target.value.toLowerCase())} />
          <span aria-hidden="true">More…</span>
        </label>
        <Button type="button" size="small" variant="secondary" onClick={onReset}>
          Reset to theme
        </Button>
      </div>
      {target ? (
        <p id={`${id}-target`} className={styles.target}>
          Applies to {target}.
        </p>
      ) : null}
    </fieldset>
  );
}

/** The heading's words, whether it shows, and its colour; shared by text boxes and charts. */
function HeadingFields({ draft, swatches, onChange, autoFocus }: { draft: Tile; swatches: string[]; onChange: (tile: Tile) => void; autoFocus?: boolean }) {
  const id = useId();
  const shown = draft.format?.card?.showTitle !== false;
  return (
    <div className={styles.group}>
      <label htmlFor={id} className={styles.label}>Heading</label>
      <input id={id} value={draft.title} maxLength={MAX_HEADING} autoFocus={autoFocus} onChange={(event) => onChange(setHeading(draft, { title: event.target.value }))} />
      <label className={styles.check}>
        <input type="checkbox" checked={shown} onChange={(event) => onChange(setHeading(draft, { show: event.target.checked }))} /> Show the heading
      </label>
      <label className={styles.inline}>
        <span className={styles.label}>Heading size</span>
        <select value={draft.format?.card?.title?.size ?? ""} onChange={(event) => onChange(setHeading(draft, { size: event.target.value ? Number(event.target.value) : null }))}>
          <option value="">Theme size</option>
          {HEADING_SIZES.map((size) => <option key={size} value={size}>{size} px</option>)}
        </select>
      </label>
      <TextColourControl
        label="Heading colour"
        value={draft.format?.card?.title?.color}
        swatches={swatches}
        onChoose={(colour) => onChange(setHeading(draft, { color: colour }))}
        onReset={() => onChange(setHeading(draft, { color: null }))}
      />
    </div>
  );
}

/**
 * The compact editor docked beside the report while a text box or a heading
 * is changed in place. Every change shows at once on
 * the report as a draft; Save keeps it and Cancel drops it.
 */
export function TextInspector({
  edit,
  swatches,
  tables,
  saving,
  error,
  problems,
  changed,
  onChange,
  onSave,
  onCancel,
}: {
  edit: InPlaceEdit;
  swatches: string[];
  tables: TableInfo[];
  saving: boolean;
  error: string | null;
  problems: string[];
  changed: boolean;
  onChange: (tile: Tile) => void;
  onSave: () => void;
  /** `ask`: check before dropping changes (Escape); the Cancel button just drops them. */
  onCancel: (ask: boolean) => void;
}) {
  const { draft } = edit;
  const area = useRef<HTMLTextAreaElement>(null);
  const textId = useId();
  const linkId = useId();
  const [chosen, setChosen] = useState({ start: 0, end: 0 });
  const [linking, setLinking] = useState<string | null>(null);
  const restore = useRef<{ start: number; end: number } | null>(null);
  const text = draft.text ?? "";
  const body = draft.format?.card?.body ?? {};
  const someChosen = chosen.end > chosen.start;
  const target = someChosen ? "the chosen words" : "the whole box";
  const names = useMemo(() => valueNames(parseRichText(text)), [text]);
  const missing = names.filter((name) => !draft.query?.measures.some((measure) => measure.label.toLowerCase() === name.toLowerCase()));

  // After a button changes the words, the same words stay chosen.
  useEffect(() => {
    const next = restore.current;
    if (!next || !area.current) return;
    restore.current = null;
    area.current.focus();
    // Setting the selection fires "select", which updates what's chosen.
    area.current.setSelectionRange(next.start, next.end);
  });

  const selection = () => ({ start: area.current?.selectionStart ?? chosen.start, end: area.current?.selectionEnd ?? chosen.end });
  const track = () => {
    if (area.current) setChosen({ start: area.current.selectionStart, end: area.current.selectionEnd });
  };
  const applyText = (result: TextChange) => {
    restore.current = { start: result.start, end: result.end };
    onChange({ ...draft, text: result.text });
  };
  /** Bold or italic: the chosen words, or the whole box when none are chosen. */
  const emphasis = (marker: "**" | "*", style: "bold" | "italic") => {
    const { start, end } = selection();
    if (end > start) applyText(wrapSelection(text, start, end, marker, marker));
    else onChange(setBodyStyle(draft, { [style]: body[style] ? undefined : true }));
  };
  const addLink = () => {
    const href = linking ? safeHref(linking) : null;
    if (!href) return;
    const { start, end } = selection();
    const words = end > start ? text.slice(start, end) : "link";
    applyText(wrapSelection(`${text.slice(0, start)}${words}${text.slice(end)}`, start, start + words.length, "[", `](${href})`));
    setLinking(null);
  };

  const keys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      onCancel(true);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!problems.length && !saving) onSave();
    } else if (edit.mode === "text" && (event.ctrlKey || event.metaKey) && (event.target as HTMLElement) === area.current) {
      const key = event.key.toLowerCase();
      if (key === "b") emphasis("**", "bold");
      else if (key === "i") emphasis("*", "italic");
      else return;
      event.preventDefault();
    }
  };

  const title = edit.mode === "heading" ? `Heading: ${edit.original?.title ?? draft.title}` : edit.original ? "Edit text" : "New text box";
  return (
    <aside className={styles.inspector} aria-label={title} onKeyDown={keys}>
      <div className={styles.top}>
        <h2 className={styles.title}>{title}</h2>
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={() => onCancel(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={onSave} disabled={saving || problems.length > 0 || (!changed && Boolean(edit.original))}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      <p className={styles.state} role="status" aria-live="polite">
        {saving ? "Saving…" : changed ? "Draft: shown on the report, not saved yet." : "No changes yet."}
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {problems.length ? (
        <Notice tone="warning">
          {problems.map((problem) => (
            <span key={problem} className={styles.problem}>{problem}</span>
          ))}
        </Notice>
      ) : null}

      <div className={styles.scroll}>
        {edit.mode === "heading" ? (
          <>
            <HeadingFields draft={draft} swatches={swatches} onChange={onChange} autoFocus />
            <p className={styles.note}>Only the heading changes. The chart&apos;s data, fields and series colours stay as they are.</p>
          </>
        ) : (
          <>
            <div className={styles.group}>
              <label htmlFor={textId} className={styles.label}>Text</label>
              <div className={styles.toolbar} role="toolbar" aria-label="Text formatting" aria-controls={textId}>
                <Button type="button" size="small" variant="secondary" aria-label={`Bold (${target})`} aria-pressed={!someChosen && Boolean(body.bold)} title="Bold (Ctrl+B)" onClick={() => emphasis("**", "bold")}>
                  <strong>B</strong>
                </Button>
                <Button type="button" size="small" variant="secondary" aria-label={`Italic (${target})`} aria-pressed={!someChosen && Boolean(body.italic)} title="Italic (Ctrl+I)" onClick={() => emphasis("*", "italic")}>
                  <em>I</em>
                </Button>
                <Button type="button" size="small" variant="secondary" aria-expanded={linking !== null} onClick={() => setLinking(linking === null ? "https://" : null)}>
                  Link
                </Button>
                <Button type="button" size="small" variant="secondary" onClick={() => applyText(listLines(text, selection().start, selection().end, false))}>
                  • List
                </Button>
                <Button type="button" size="small" variant="secondary" onClick={() => applyText(listLines(text, selection().start, selection().end, true))}>
                  1. List
                </Button>
                {draft.query?.measures.length ? (
                  <select
                    aria-label="Insert a value"
                    value=""
                    onChange={(event) => {
                      if (!event.target.value) return;
                      const { start, end } = selection();
                      const token = `{${event.target.value}}`;
                      applyText({ text: `${text.slice(0, start)}${token}${text.slice(end)}`, start: start + token.length, end: start + token.length });
                    }}
                  >
                    <option value="">Insert a value…</option>
                    {draft.query.measures.map((measure) => <option key={measure.label} value={measure.label}>{measure.label}</option>)}
                  </select>
                ) : null}
              </div>
              {linking !== null ? (
                <div className={styles.linkRow}>
                  <label htmlFor={linkId} className={styles.label}>Link address</label>
                  <input
                    id={linkId}
                    value={linking}
                    autoFocus
                    onChange={(event) => setLinking(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addLink();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setLinking(null);
                      }
                    }}
                  />
                  <Button type="button" size="small" onClick={addLink} disabled={!safeHref(linking)}>
                    {someChosen ? "Link the chosen words" : "Add link"}
                  </Button>
                </div>
              ) : null}
              <textarea
                id={textId}
                ref={area}
                rows={8}
                value={text}
                autoFocus
                placeholder="Type the words for this box."
                onChange={(event) => {
                  onChange({ ...draft, text: event.target.value });
                  setChosen({ start: event.target.selectionStart, end: event.target.selectionEnd });
                }}
                onSelect={track}
                onKeyUp={track}
                onMouseUp={track}
              />
              <p className={styles.target}>
                Choose words in the box to format just them; with none chosen, size, bold, italic and colour apply to the whole box.
              </p>
            </div>

            <div className={styles.row}>
              <label className={styles.inline}>
                <span className={styles.label}>Text size</span>
                <select value={body.size ?? ""} onChange={(event) => onChange(setBodyStyle(draft, { size: event.target.value ? Number(event.target.value) : undefined }))}>
                  <option value="">Theme size</option>
                  {SIZES.map((size) => <option key={size} value={size}>{size} px</option>)}
                </select>
              </label>
              <div className={styles.inline} role="group" aria-label="Alignment">
                <span className={styles.label} aria-hidden="true">Alignment</span>
                <div className={styles.segments}>
                  {ALIGNMENTS.map((entry) => (
                    <Button
                      key={entry.value}
                      type="button"
                      size="small"
                      variant="secondary"
                      aria-pressed={(body.align ?? "left") === entry.value}
                      onClick={() => onChange(setBodyStyle(draft, { align: entry.value === "left" ? undefined : entry.value }))}
                    >
                      {entry.label}
                    </Button>
                  ))}
                </div>
              </div>
            </div>

            <TextColourControl
              label="Text colour"
              value={someChosen ? undefined : body.color}
              swatches={swatches}
              target={target}
              emptyText={someChosen ? "Pick a colour for the chosen words" : "Theme colour"}
              onChoose={(colour) => {
                const { start, end } = selection();
                if (end > start) applyText(colourSelection(text, start, end, colour));
                else onChange(setBodyStyle(draft, { color: colour }));
              }}
              onReset={() => {
                const { start, end } = selection();
                if (end > start) applyText(clearColourSelection(text, start, end));
                else onChange(setBodyStyle({ ...draft, text: withoutColours(text) }, { color: undefined }));
              }}
            />

            <HeadingFields draft={draft} swatches={swatches} onChange={onChange} />

            <label className={styles.inline}>
              <span className={styles.label}>Width</span>
              <select value={draft.width} onChange={(event) => onChange({ ...draft, width: event.target.value as TileWidth })}>
                {TILE_WIDTHS.map((entry) => <option key={entry} value={entry}>{WIDTH_LABELS[entry]}</option>)}
              </select>
            </label>

            <details className={styles.more} open={missing.length > 0 || undefined}>
              <summary>Values from your data</summary>
              <TextValuesFields
                query={draft.query}
                setQuery={(query) => onChange({ ...draft, query })}
                tables={tables}
                missing={missing}
                previewError={null}
              />
            </details>
          </>
        )}
      </div>
    </aside>
  );
}
