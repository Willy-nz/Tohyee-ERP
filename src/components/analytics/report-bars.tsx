"use client";

import { DateInput } from "@/components/date-input";
import { useState } from "react";
import { ParameterControls } from "@/components/analytics/parameter-controls";
import { TileFilters } from "@/components/analytics/tile-filters";
import { useApiData } from "@/components/hooks";
import { Button,Card,Empty,Field,Notice,ui } from "@/components/ui";
import { SlicerControl } from "@/components/analytics/slicer-control";
import { SLICER_STYLE_LABELS,slicerOnPage,stylesFor,type SlicerStyle } from "@/lib/analytics/slicers";
import { type PageFilter } from "@/lib/analytics/report-filters";
import { bookmarkName,type Bookmark,type BookmarkState } from "@/lib/analytics/bookmarks";
import { type ReportPage } from "@/lib/analytics/pages";
import { type DrillState } from "@/lib/analytics/report-view";
import type { Dashboard,DashboardSettings,Slicer,Tile } from "@/lib/analytics/dashboards";
import type {
Filter,
ColumnInfo
} from "@/lib/analytics/query";
import { api,errorMessage } from "@/lib/client/api";
import { DATE_PRESETS,isDatePreset,matchingPreset,presetRange } from "@/lib/analytics/date-ranges";
import { filterComplete } from "@/lib/analytics/filters";
import { fieldLabel,tableLabel } from "@/lib/analytics/labels";
import { formatDate,formatDateTime } from "@/lib/format";
import styles from "@/components/analytics-dashboards.module.css";
import { DateContext,Filters,TableInfo,columnOptions,isDate,isNumber } from "@/components/analytics/report-shared";

/** A tile's drill-down: drill on click, up a level, the next level for all, and where it's drilled to. */
export function DrillTools({ title, levels, state, on, path, current, onToggle, onUp, onExpand }: { title: string; levels: number; state: DrillState; on: boolean; path: string[]; current: string; onToggle: () => void; onUp: () => void; onExpand: () => void }) {
  return (
    <div className={styles.drillTools} role="group" aria-label={`Drill down ${title}`}>
      <Button size="small" variant="secondary" aria-pressed={on} title="When on, clicking a group shows the next level inside it" onClick={onToggle}>
        Drill down on click
      </Button>
      <Button size="small" variant="secondary" disabled={state.level === 0} aria-label={`Up a level on ${title}`} onClick={onUp}>↑ Up</Button>
      <Button size="small" variant="secondary" disabled={state.level >= levels - 1} title="The next level for every group" aria-label={`Next level for all on ${title}`} onClick={onExpand}>Next level for all</Button>
      <span className={styles.drillPath} aria-live="polite">
        {state.level === 0 ? current : `${state.all && path.length < state.level ? "All" : path.join(" › ")} › ${current}`}
      </span>
    </div>
  );
}

/**
 * Under a commentary box the connected AI wrote: who suggested it and
 * that it isn't checked, with Accept and Remove for people who can change the
 * report; once accepted, who accepted it. It also says when the report's
 * dates have moved on from the ones it was written about.
 */
export function CommentaryNote({ organisationId, dashboard, tile, canDecide, onChanged }: { organisationId: string; dashboard: Dashboard; tile: Tile; canDecide: boolean; onChanged: (dashboard: Dashboard) => void }) {
  const mark = tile.commentary!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const via = mark.via.replace(/"/g, "");
  const datesMoved = (mark.about.from ?? null) !== (dashboard.settings.from ?? null) || (mark.about.to ?? null) !== (dashboard.settings.to ?? null);
  const aboutText = mark.about.from && mark.about.to ? `${formatDate(mark.about.from)} to ${formatDate(mark.about.to)}` : mark.about.to ? `up to ${formatDate(mark.about.to)}` : mark.about.from ? `from ${formatDate(mark.about.from)}` : "all dates";
  async function decide(action: "accept" | "remove") {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ dashboard: Dashboard }>(`/api/analytics/dashboards/${dashboard.id}/commentary/${encodeURIComponent(tile.id)}`, {
        method: "POST",
        body: { organisationId, action, expectedVersion: dashboard.version },
      });
      onChanged(result.dashboard);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`${styles.commentaryNote} ${mark.status === "suggested" ? styles.commentarySuggested : ""}`} data-print={mark.status === "suggested" ? "hide" : undefined}>
      <p>
        {mark.status === "suggested" ? (
          <>
            <strong>Suggested by the AI, not checked.</strong> From {mark.byEmail}&apos;s {via}, {formatDateTime(mark.writtenAt)}.
          </>
        ) : (
          <>
            Written by the AI ({via}); accepted by {mark.acceptedByEmail ?? "a person"}
            {mark.acceptedAt ? `, ${formatDate(mark.acceptedAt.slice(0, 10))}` : ""}.
          </>
        )}{" "}
        {datesMoved ? <span>It was written about {aboutText}; the report now shows other dates.</span> : null}
      </p>
      {canDecide ? (
        <div className={styles.commentaryActions}>
          {mark.status === "suggested" ? (
            <Button size="small" disabled={busy} onClick={() => void decide("accept")}>
              Accept
            </Button>
          ) : null}
          <Button size="small" variant="secondary" disabled={busy} onClick={() => void decide("remove")}>
            Remove
          </Button>
        </div>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}

type ReportViewer = { userId: string; email: string; displayName: string; isActive: boolean };

/** Sharing a dashboard with report viewers, e.g. clients. They sign in and see only what's shared. */
export function ShareCard({ organisationId, dashboardId }: { organisationId: string; dashboardId: string }) {
  const shares = useApiData<{ shares: string[]; reportViewers: ReportViewer[] }>(`/api/analytics/dashboards/${dashboardId}/shares`, { organisationId });
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const current = chosen ?? shares.data?.shares ?? [];
  const people = shares.data?.reportViewers ?? [];

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ shares: string[] }>(`/api/analytics/dashboards/${dashboardId}/shares`, {
        method: "PUT",
        body: { organisationId, userIds: current },
      });
      setChosen(result.shares);
      shares.reload();
      setMessage({ tone: "success", text: result.shares.length ? `Shared with ${result.shares.length} ${result.shares.length === 1 ? "person" : "people"}.` : "Not shared with anyone." });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Share with clients"
      description="Report viewers sign in like anyone else and see only the dashboards shared with them, nothing of the books. Add someone as a Report viewer under Accounting › Members first."
    >
      {shares.error ? <Notice tone="error">{shares.error}</Notice> : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {!shares.data ? (
        <p className={ui.muted}>Loading…</p>
      ) : people.length === 0 ? (
        <Empty>This organisation has no report viewers yet.</Empty>
      ) : (
        <div className={styles.shareList}>
          {people.map((person) => (
            <label key={person.userId} className={ui.checkbox}>
              <input
                type="checkbox"
                checked={current.includes(person.userId)}
                onChange={(event) =>
                  setChosen(event.target.checked ? [...current, person.userId] : current.filter((entry) => entry !== person.userId))
                }
              />{" "}
              {person.displayName} <span className={ui.muted}>{person.email}{person.isActive ? "" : " · can't sign in"}</span>
            </label>
          ))}
          <div>
            <Button size="small" onClick={() => void save()} disabled={busy || chosen === null}>
              {busy ? "Saving…" : "Save sharing"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * Bookmarks: open one to see its page, dates, slicer
 * choices and hidden tiles. In edit mode, add one from the view shown,
 * update, rename or remove it, and choose tiles it hides.
 */
export function BookmarkBar({ bookmarks, shown, editing, pageTiles, onOpen, current, onChange }: { bookmarks: Bookmark[]; shown: string | null; editing: boolean; pageTiles: Tile[]; onOpen: (id: string) => void; current: () => BookmarkState; onChange: (bookmarks: Bookmark[]) => void }) {
  if (!editing && !bookmarks.length) return null;
  const update = (id: string, patch: Partial<Bookmark>) => onChange(bookmarks.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  return (
    <div className={styles.bookmarks}>
      {bookmarks.length ? (
        <div className={styles.bookmarkList} role="group" aria-label="Bookmarks">
          <span className={styles.bookmarkLabel}>Bookmarks</span>
          {bookmarks.map((bookmark) => (
            <Button key={bookmark.id} size="small" variant="secondary" aria-pressed={shown === bookmark.id} onClick={() => onOpen(bookmark.id)}>{bookmark.name}</Button>
          ))}
        </div>
      ) : null}
      {editing ? (
        <details className={styles.slicerSettings}>
          <summary>Bookmark settings</summary>
          <div className={styles.slicerSettingsBody}>
            <p className={ui.muted}>A bookmark keeps the page shown, its dates and slicer choices, and any tiles you hide in it. Choose a bookmark above to see it.</p>
            {bookmarks.map((bookmark) => (
              <fieldset key={bookmark.id} className={styles.slicerPages}>
                <legend>{bookmark.name}</legend>
                <Field label="Name"><input value={bookmark.name} maxLength={60} onChange={(event) => update(bookmark.id, { name: event.target.value })} /></Field>
                {bookmark.state.page === current().page && pageTiles.length ? (
                  <div className={styles.hiddenList}>
                    <span className={styles.bookmarkLabel}>Hidden in this bookmark</span>
                    {pageTiles.map((tile) => (
                      <label key={tile.id} className={ui.checkbox}>
                        <input type="checkbox" checked={bookmark.state.hidden?.includes(tile.id) ?? false} onChange={(event) => {
                          const list = event.target.checked ? [...(bookmark.state.hidden ?? []), tile.id] : (bookmark.state.hidden ?? []).filter((id) => id !== tile.id);
                          const state = { ...bookmark.state };
                          delete state.hidden;
                          update(bookmark.id, { state: list.length ? { ...state, hidden: list } : state });
                        }} /> {tile.title}
                      </label>
                    ))}
                  </div>
                ) : <p className={ui.muted}>Go to its page to choose the tiles it hides.</p>}
                <div className={ui.rowButtons}>
                  <Button size="small" variant="secondary" onClick={() => update(bookmark.id, { state: { ...current(), ...(bookmark.state.hidden && bookmark.state.page === current().page ? { hidden: bookmark.state.hidden } : {}) } })}>Update to the view shown</Button>
                  <Button size="small" variant="danger" onClick={() => onChange(bookmarks.filter((entry) => entry.id !== bookmark.id))}>Remove</Button>
                </div>
              </fieldset>
            ))}
            <div>
              <Button size="small" variant="secondary" disabled={bookmarks.length >= 20} onClick={() => onChange([...bookmarks, { id: `b${Date.now().toString(36)}`, name: bookmarkName(bookmarks), state: current() }])}>+ Add a bookmark of the view shown</Button>
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** A page's own filters: one data source's tests, on every tile of the page whose table has the column. */
export function PageFilters({ organisationId, tables, filters, onChange }: { organisationId: string; tables: TableInfo[]; filters: PageFilter[]; onChange: (filters: PageFilter[]) => void }) {
  const [table, setTable] = useState(filters[0]?.table ?? "");
  const columns = tables.find((entry) => entry.name === table)?.columns ?? [];
  // Rows being typed stay here; only complete ones go on the page.
  const [draft, setDraft] = useState<Filter[]>(filters.map((entry) => entry.filter));
  return (
    <fieldset className={styles.slicerPages}>
      <legend>Filters on this page</legend>
      <p className={ui.muted}>Every tile on this page whose data has the column shows only these rows.</p>
      <Field label="Data source">
        <select value={table} onChange={(event) => { setTable(event.target.value); setDraft([]); onChange([]); }}>
          <option value="">Choose a data source</option>
          {tables.map((entry) => <option key={entry.name} value={entry.name}>{tableLabel(entry.name)}</option>)}
        </select>
      </Field>
      {table ? (
        <TileFilters
          organisationId={organisationId}
          table={table}
          columns={columns}
          filters={draft}
          onChange={(next) => {
            setDraft(next.slice(0, 6));
            onChange(next.filter(filterComplete).slice(0, 6).map((filter) => {
              const copy = { ...filter };
              delete copy.join;
              return { table, filter: copy };
            }));
          }}
        />
      ) : null}
    </fieldset>
  );
}

/** A slicer's settings in edit mode: style, name, second level, pages and size. */
function SlicerSettings({ slicer, type, columns, pages, onChange, onRemove }: { slicer: Slicer; type: string; columns: ColumnInfo[]; pages: ReportPage[]; onChange: (slicer: Slicer) => void; onRemove: () => void }) {
  const set = (patch: Partial<Slicer>) => {
    const next: Slicer = { ...slicer, ...patch };
    for (const key of Object.keys(patch) as Array<keyof Slicer>) if (patch[key] === undefined) delete next[key];
    onChange(next);
  };
  return (
    <details className={styles.slicerSettings}>
      <summary>Slicer settings</summary>
      <div className={styles.slicerSettingsBody}>
        <Field label="Name">
          <input value={slicer.label} maxLength={60} onChange={(event) => set({ label: event.target.value })} />
        </Field>
        <Field label="Style">
          <select value={slicer.style ?? "list"} onChange={(event) => {
            const style = event.target.value as SlicerStyle;
            const child = style === "hierarchy" ? columns.find((column) => column.name !== slicer.field && !isNumber(column.type) && !isDate(column.type) && column.type !== "BOOLEAN")?.name : undefined;
            set({ style: style === "list" ? undefined : style, child });
          }}>
            {stylesFor(type).map((style) => <option key={style} value={style}>{SLICER_STYLE_LABELS[style]}</option>)}
          </select>
        </Field>
        {slicer.style === "hierarchy" ? (
          <Field label="Second level">
            <select value={slicer.child ?? ""} onChange={(event) => set({ child: event.target.value })}>
              {columnOptions(columns.filter((column) => column.name !== slicer.field && !isNumber(column.type) && !isDate(column.type) && column.type !== "BOOLEAN"))}
            </select>
          </Field>
        ) : null}
        <Field label="Size">
          <select value={`${slicer.look?.size ?? ""}|${slicer.look?.width ?? ""}`} onChange={(event) => {
            const [size, width] = event.target.value.split("|");
            set({ look: size || width ? { ...(size ? { size: size as "small" | "large" } : {}), ...(width ? { width: "wide" as const } : {}) } : undefined });
          }}>
            <option value="|">Normal</option>
            <option value="small|">Small</option>
            <option value="large|">Large</option>
            <option value="|wide">Wide</option>
            <option value="large|wide">Large and wide</option>
          </select>
        </Field>
        {pages.length > 1 ? (
          <fieldset className={styles.slicerPages}>
            <legend>Shows and filters on</legend>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={!slicer.pages} onChange={(event) => set({ pages: event.target.checked ? undefined : pages.map((page) => page.id) })} /> Every page (in step)
            </label>
            {slicer.pages ? pages.map((page) => (
              <label key={page.id} className={ui.checkbox}>
                <input type="checkbox" checked={slicer.pages!.includes(page.id)} onChange={(event) => {
                  const chosen = event.target.checked ? [...slicer.pages!, page.id] : slicer.pages!.filter((id) => id !== page.id);
                  set({ pages: chosen.length === pages.length ? undefined : chosen.length ? chosen : slicer.pages });
                }} /> {page.name}
              </label>
            )) : null}
          </fieldset>
        ) : null}
        <div>
          <Button size="small" variant="danger" onClick={onRemove}>Remove slicer</Button>
        </div>
      </div>
    </details>
  );
}

export function FilterBar({
  organisationId,
  settings,
  filters,
  onChange,
  editing,
  tables,
  dates,
  onSettings,
  dashboardId,
  pageId,
  pages,
}: {
  organisationId: string;
  dashboardId: string;
  /** The page shown: only its slicers show. */
  pageId: string;
  pages: ReportPage[];
  settings: DashboardSettings;
  filters: Filters;
  onChange: (filters: Filters) => void;
  editing: boolean;
  tables: TableInfo[];
  dates: DateContext;
  onSettings: (settings: DashboardSettings) => void;
}) {
  const [newSlicer, setNewSlicer] = useState("");
  // Any column: text and Yes/No as lists, numbers and dates as ranges, grouped by where they come from.
  const slicerTables = tables.filter((table) => table.columns.length > 0).map((table) => ({ table, columns: table.columns }));
  // The preset chosen, or the one these dates happen to be today, so the list shows where they came from.
  const preset = filters.preset ?? matchingPreset(filters, dates.today, dates.financialYearEndMonth);
  const presetName = DATE_PRESETS.find((entry) => entry.value === filters.preset)?.label;
  return (
    <div className={styles.filterBar}>
      <Field label="Dates">
        <select
          value={preset ?? ""}
          onChange={(event) => {
            const chosen = event.target.value;
            if (!isDatePreset(chosen)) return onChange({ ...filters, preset: null });
            const range = presetRange(chosen, dates.today, dates.financialYearEndMonth);
            onChange({ ...filters, from: range.from ?? "", to: range.to ?? "", preset: chosen });
          }}
        >
          <option value="">Custom</option>
          {DATE_PRESETS.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="From">
        <DateInput value={filters.from} onChange={(event) => onChange({ ...filters, from: event.target.value, preset: null })} />
      </Field>
      <Field label="To">
        <DateInput value={filters.to} onChange={(event) => onChange({ ...filters, to: event.target.value, preset: null })} />
      </Field>
      {settings.slicers.map((slicer, index) => (editing || slicerOnPage(slicer, pageId) ? (
        <SlicerControl
          key={`${slicer.table}.${slicer.field}`}
          organisationId={organisationId}
          dashboardId={dashboardId}
          slicer={slicer}
          chosen={filters.values[slicer.field] ?? []}
          childChosen={slicer.child ? filters.values[slicer.child] ?? [] : undefined}
          range={filters.ranges?.[slicer.field]}
          onChange={(values) => onChange({ ...filters, values: { ...filters.values, [slicer.field]: values } })}
          onChildChange={slicer.child ? (values) => onChange({ ...filters, values: { ...filters.values, [slicer.child!]: values } }) : undefined}
          onRange={(range) => {
            const ranges = { ...filters.ranges };
            if (range) ranges[slicer.field] = range;
            else delete ranges[slicer.field];
            onChange({ ...filters, ranges });
          }}
          settings={editing ? (
            <SlicerSettings
              slicer={slicer}
              type={tables.find((table) => table.name === slicer.table)?.columns.find((column) => column.name === slicer.field)?.type ?? "VARCHAR"}
              columns={tables.find((table) => table.name === slicer.table)?.columns ?? []}
              pages={pages}
              onChange={(next) => onSettings({ ...settings, slicers: settings.slicers.map((entry, at) => (at === index ? next : entry)) })}
              onRemove={() => onSettings({ ...settings, slicers: settings.slicers.filter((entry) => entry !== slicer) })}
            />
          ) : undefined}
        />
      ) : null))}
      {editing ? (
        <>
          <Field label="Add a slicer">
            <select value={newSlicer} onChange={(event) => setNewSlicer(event.target.value)}>
              <option value="">Choose a column</option>
              {slicerTables.map(({ table, columns }) => (
                <optgroup key={table.name} label={tableLabel(table.name)}>
                  {columns.map((column) => (
                    <option key={column.name} value={`${table.name}.${column.name}`} title={`${table.name}.${column.name}`}>
                      {tableLabel(table.name)} › {fieldLabel(column.name)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Button
            size="small"
            variant="secondary"
            disabled={!newSlicer}
            onClick={() => {
              const [table, field] = newSlicer.split(".");
              const type = tables.find((entry) => entry.name === table)?.columns.find((column) => column.name === field)?.type ?? "VARCHAR";
              const style = stylesFor(type)[0];
              onSettings({ ...settings, slicers: [...settings.slicers, { table, field, label: fieldLabel(field), ...(style !== "list" ? { style } : {}) }] });
              setNewSlicer("");
            }}
          >
            Add slicer
          </Button>
          <Button
            size="small"
            variant="secondary"
            onClick={() => onSettings({ ...settings, from: filters.from || null, to: filters.to || null, preset: filters.preset ?? null })}
            title={presetName ? `Open the dashboard with ${presetName.toLowerCase()}, moving on with the calendar` : "Open the dashboard with these dates"}
          >
            Keep these dates
          </Button>
        </>
      ) : null}
      <ParameterControls
        parameters={settings.parameters ?? []}
        values={filters.parameters ?? {}}
        onChange={(parameters) => onChange({ ...filters, parameters })}
        editing={editing}
        onSettings={(parameters) => {
          const next = { ...settings };
          if (parameters) next.parameters = parameters;
          else delete next.parameters;
          onSettings(next);
        }}
      />
    </div>
  );
}
