"use client";

import Link from "next/link";
import { IllustratedIcon } from "@/components/illustrated-icon";
import { useRouter,useSearchParams } from "next/navigation";
import { useCallback,useEffect,useMemo,useRef,useState } from "react";
import { PinTileMenu } from "@/components/analytics/pin-tile-menu";
import { useAnalyticsEmbed } from "@/components/analytics/embed-context";
import { ReportFreshnessLine } from "@/components/analytics/report-freshness";
import { isTohyee,ReportThemeStyle,reportTheme } from "@/components/analytics/report-theme";
import { ThemePanel } from "@/components/analytics/theme-panel";
import { DashboardHistoryCard } from "@/components/analytics/dashboard-history";
import { useChoose, useConfirm } from "@/components/confirm-dialog";
import { useLeaveWarning } from "@/components/use-leave-warning";
import { copyName,hasUnsavedChanges,recordChange,redo,redoLabel,replaceSaved,startHistory,undo,undoLabel,type EditHistory } from "@/lib/analytics/edit-history";
import { useApiData } from "@/components/hooks";
import { Button,Empty,Notice,ui } from "@/components/ui";
import { MoreMenu } from "@/components/more-menu";
import { useWorkspace } from "@/components/workspace";
import { pasteFormat,VISUAL_NAMES,type ChartFormat,type DefaultableVisual,type VisualDefaults } from "@/lib/analytics/chart-format";
import { tileWithDefaults } from "@/lib/analytics/tile-chart";
import { cardStyle } from "@/lib/analytics/chart-spec";
import { ItemEditor } from "@/components/analytics/items";
import { TextInspector } from "@/components/analytics/text-inspector";
import { draftProblems,finishDraft,hasChanged,startEdit,themeSwatches,withDraft,type InPlaceEdit } from "@/lib/analytics/text-edit";
import { isItemVisual,type ButtonAction } from "@/lib/analytics/items";
import { ArrangeBar } from "@/components/analytics/arrange-bar";
import { PageTabs,pageStyle } from "@/components/analytics/report-pages";
import { rangeFilters,slicerOnPage } from "@/lib/analytics/slicers";
import { tileDatesText } from "@/lib/analytics/report-filters";
import { type BookmarkState } from "@/lib/analytics/bookmarks";
import { addPage,movePage,openingPage,removePage,reportPages,tilePage,tilesOnPage,withPage,type ReportPage } from "@/lib/analytics/pages";
import { DRILLABLE,drillDown,drillUp,drillView,expandAll,interactionMode,periodLabel,selectionLevel,TOP,type DrillState,type Selection,type TileView } from "@/lib/analytics/report-view";
import type { Dashboard,Tile } from "@/lib/analytics/dashboards";
import { duplicateTile,moveTileTo } from "@/lib/analytics/layout";
import type {
Filter
} from "@/lib/analytics/query";
import { api,ApiError,errorMessage } from "@/lib/client/api";
import { presetRange } from "@/lib/analytics/date-ranges";
import { booleanText } from "@/lib/analytics/display";
import { valueLabel } from "@/lib/analytics/value-labels";
import { fieldLabel } from "@/lib/analytics/labels";
import { formatDate,formatDateTime,todayInBrowser } from "@/lib/format";
import styles from "@/components/analytics-dashboards.module.css";
import { DateContext,Filters,TableInfo,YearEndMonth,levelName,tileClass } from "@/components/analytics/report-shared";
import { RequireAnalytics } from "@/components/analytics/report-list";
import { BookmarkBar,CommentaryNote,DrillTools,FilterBar,PageFilters,ShareCard } from "@/components/analytics/report-bars";
import { TileBody,TileInteraction } from "@/components/analytics/tile-body";
import { TileEditor } from "@/components/analytics/tile-editor";

/** One dashboard: its date range and slicers, and its tiles; Edit to change them. */
export function DashboardView({ organisationId, dashboardId, startEditing }: { organisationId: string; dashboardId: string; startEditing: boolean }) {
  return (
    <RequireAnalytics organisationId={organisationId}>
      <DashboardViewInner organisationId={organisationId} dashboardId={dashboardId} startEditing={startEditing} />
    </RequireAnalytics>
  );
}

function DashboardViewInner({ organisationId, dashboardId, startEditing }: { organisationId: string; dashboardId: string; startEditing: boolean }) {
  const router = useRouter();
  const { can } = useWorkspace();
  // On a PowerPoint slide: read-only, the chosen page or tile.
  const embed = useAnalyticsEmbed();
  const confirm = useConfirm();
  const choose = useChoose();
  const loaded = useApiData<{ dashboard: Dashboard } & Partial<DateContext>>(`/api/analytics/dashboards/${dashboardId}`, { organisationId });
  const tables = useApiData<{ tables: TableInfo[] }>(can("bookkeeper") && !embed ? "/api/analytics/tables" : null, { organisationId });
  // What the server has (the last save, or the report as loaded), and this
  // editing session's draft with its Undo and Redo.
  const [saved, setSaved] = useState<Dashboard | null>(null);
  const [history, setHistory] = useState<EditHistory<Dashboard> | null>(null);
  // Someone else saved first: who and when, until Reload or Save a copy.
  const [conflict, setConflict] = useState<{ updatedByEmail: string; updatedAt: string } | null>(null);
  const [editing, setEditing] = useState(startEditing && can("bookkeeper") && !embed);
  const [sharing, setSharing] = useState(false);
  // The report's edit history: saved versions, by people and through an AI.
  const [showHistory, setShowHistory] = useState(false);
  const [theming, setTheming] = useState(false);
  // Present: the report full screen, a page at a time, like slides.
  const [presenting, setPresenting] = useState(false);
  const presentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!presenting) return;
    // Leaving the browser's full screen (Esc, or its own button) ends the show.
    const onFullScreen = () => {
      if (!document.fullscreenElement) setPresenting(false);
    };
    document.addEventListener("fullscreenchange", onFullScreen);
    return () => document.removeEventListener("fullscreenchange", onFullScreen);
  }, [presenting]);
  // The format painter: a tile's format, copied to paste on others.
  const [copied, setCopied] = useState<{ from: string; title: string; format: ChartFormat | undefined } | null>(null);
  const [editingTile, setEditingTile] = useState<Tile | "new" | "new-text" | null>(null);
  // A text box or a heading being changed in place, beside the report.
  const [inPlace, setInPlace] = useState<InPlaceEdit | null>(null);
  const [inPlaceError, setInPlaceError] = useState<string | null>(null);
  // Drag and drop (the arrows do the same from the keyboard).
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filters | null>(null);
  // Tiles chosen for lining up and sizing.
  const [chosenTiles, setChosenTiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The page shown, kept in the address (?page=) so a link opens it.
  const search = useSearchParams();
  const [pageChoice, setPageChoice] = useState<string | null>(() => (embed ? embed.pageId : search.get("page")));
  // What the reader has drilled to, clicked and drilled through to; none of it is saved.
  const [drills, setDrills] = useState<Record<string, DrillState>>({});
  const [drillMode, setDrillMode] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<(Selection & { label: string; tileTitle: string }) | null>(null);
  const [through, setThrough] = useState<{ selection: Selection; label: string; from: string; to: string } | null>(null);
  // A bookmark's hidden tiles, the bookmark shown, and the pages seen before, for Back.
  const [hidden, setHidden] = useState<string[]>([]);
  const [bookmarkShown, setBookmarkShown] = useState<string | null>(null);
  const [pageHistory, setPageHistory] = useState<string[]>([]);

  const base = saved ?? loaded.data?.dashboard ?? null;
  const dashboard = history?.present ?? base;
  const unsaved = Boolean(base && dashboard && hasUnsavedChanges(base, dashboard));
  const inPlaceChanged = Boolean(inPlace && hasChanged(inPlace));
  // Another editor is open, so the report's own buttons wait.
  const occupied = Boolean(editingTile || inPlace);
  // Each saved tile's question, to tell which tiles in the draft are as saved.
  const savedQueries = useMemo(() => new Map((base?.tiles ?? []).map((tile) => [tile.id, JSON.stringify(tile.query)])), [base]);
  const chosenFilters: Filters = filters ?? { from: dashboard?.settings.from ?? "", to: dashboard?.settings.to ?? "", preset: dashboard?.settings.preset ?? null, values: {} };
  // What-if parameters: the reader's values over the report's starting ones.
  const shown: Filters = dashboard?.settings.parameters?.length
    ? { ...chosenFilters, parameters: { ...Object.fromEntries(dashboard.settings.parameters.map((parameter) => [parameter.name, parameter.value])), ...chosenFilters.parameters } }
    : chosenFilters;
  const dates: DateContext = { today: loaded.data?.today ?? todayInBrowser(), financialYearEndMonth: loaded.data?.financialYearEndMonth ?? 3 };
  const canEdit = can("bookkeeper") && !embed;
  /**
   * What a report's buttons do. Only resetting
   * the filters exists so far; pages and bookmarks (phase 3) add their
   * actions here and in BUTTON_ACTIONS.
   */
  /** Back to the report as it opens: its dates and slicers, nothing clicked, drilled or drilled through. */
  const resetView = () => {
    setFilters(null);
    setDrills({});
    setPicked(null);
    setThrough(null);
    setHidden([]);
    setBookmarkShown(null);
  };

  useLeaveWarning(unsaved || inPlaceChanged, async () => {
    // Unsaved text or a heading: save it, drop it, or stay.
    if (inPlace && inPlaceChanged) {
      const answer = await choose(
        unsaved ? "Your text isn't saved, and nor are other changes to this report. Saving saves them all." : "Your changes to this text aren't saved.",
        { title: "Leave without saving?", confirmLabel: "Save and leave", otherLabel: "Discard and leave", cancelLabel: "Keep editing" },
      );
      if (answer === "confirm") return saveInPlace();
      return answer === "other";
    }
    return confirm("Your changes to this report aren't saved. Leave without saving them?", { title: "Leave without saving?", confirmLabel: "Leave", danger: true });
  });

  /** A change to the draft, named for Undo (e.g. "remove Sales by month"); `key` makes a run of the same change (typing) one step. */
  function change(next: Dashboard, label: string, key?: string) {
    if (!base) return;
    setHistory((current) => recordChange(current ?? startHistory(base), next, label, key));
  }

  const step = useCallback((direction: "undo" | "redo") => {
    setHistory((current) => (current ? (direction === "undo" ? undo(current) : redo(current)) : current));
  }, []);

  // Ctrl+Z / Cmd+Z and Ctrl+Shift+Z / Ctrl+Y while editing, except in a text box (which has its own Undo).
  useEffect(() => {
    if (!editing || occupied) return;
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) step("undo");
      else if ((key === "z" && event.shiftKey) || key === "y") step("redo");
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [editing, occupied, step]);

  /**
   * Saves the draft, naming the version it started from. A
   * save that fails, or is refused because someone else saved first, leaves
   * the draft as it is.
   */
  async function save(next?: { dashboard: Dashboard; label: string }): Promise<boolean> {
    if (!dashboard || !base) return false;
    if (!next && !unsaved) return true;
    const sent = next?.dashboard ?? dashboard;
    // A text box's own Save shows its problems in its editor, which stays open with the draft.
    const fail = next ? setInPlaceError : setError;
    setBusy(true);
    setError(null);
    setInPlaceError(null);
    setConflict(null);
    try {
      const { dashboard: result } = await api<{ dashboard: Dashboard }>(`/api/analytics/dashboards/${dashboardId}`, {
        method: "PATCH",
        body: { organisationId, expectedVersion: base.version, name: sent.name, description: sent.description, settings: sent.settings, tiles: sent.tiles },
      });
      setSaved(result);
      setHistory((current) => {
        const withChange = next ? recordChange(current ?? startHistory(base), sent, next.label) : current;
        return withChange ? replaceSaved(withChange, sent, result) : withChange;
      });
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "dashboard_conflict") {
        setConflict({ updatedByEmail: String(caught.details?.updatedByEmail ?? "Someone"), updatedAt: String(caught.details?.updatedAt ?? "") });
        if (next) fail("Not saved: someone else saved this report after you started. Your text is still here; Cancel, then save your changes as a copy or reload.");
      } else {
        fail(`${errorMessage(caught)} Your changes haven't been saved; they're still here, so you can try again.`);
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** The report as it's saved now, in place of the draft (after a conflict, or on starting to edit). */
  async function reloadSaved(ask: boolean) {
    if (ask && unsaved) {
      const ok = await confirm("Your changes will be replaced by the report as it's saved now. To keep them, save them as a copy first.", {
        title: "Reload the saved report?",
        confirmLabel: "Reload",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const { dashboard: fresh } = await api<{ dashboard: Dashboard }>(`/api/analytics/dashboards/${dashboardId}`, { query: { organisationId } });
      setSaved(fresh);
      setHistory(null);
      setConflict(null);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  /** The draft as a new report (after a conflict), so nobody's work is lost. It isn't shared with anyone yet. */
  async function saveCopy() {
    if (!dashboard) return;
    setBusy(true);
    setError(null);
    try {
      const { dashboard: copy } = await api<{ dashboard: Dashboard }>("/api/analytics/dashboards", {
        method: "POST",
        body: { organisationId, name: copyName(dashboard.name), description: dashboard.description, settings: dashboard.settings, tiles: dashboard.tiles },
      });
      setHistory(null);
      setConflict(null);
      router.push(`/analytics/dashboards/${copy.id}?edit=1`);
    } catch (caught) {
      setError(`${errorMessage(caught)} Your changes are still here.`);
    } finally {
      setBusy(false);
    }
  }

  async function beginEditing() {
    // Start from the latest save, so a report left open a while isn't a stale starting point.
    if (!history) await reloadSaved(false);
    setEditing(true);
  }

  async function remove() {
    if (!dashboard) return;
    const ok = await confirm(`Delete the ${dashboard.name} dashboard? The data it shows isn't touched.`, { title: "Delete dashboard?", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await api(`/api/analytics/dashboards/${dashboardId}`, { method: "DELETE", query: { organisationId } });
      setHistory(null);
      router.push("/analytics");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  /** Pastes the copied format on a tile (its key figure target stays its own). */
  function paste(tile: Tile) {
    if (!dashboard || !copied) return;
    const format = pasteFormat(copied.format, tile.format);
    const tiles = dashboard.tiles.map((entry) => {
      if (entry.id !== tile.id) return entry;
      const next = { ...entry };
      delete next.format;
      return format ? { ...next, format } : next;
    });
    change({ ...dashboard, tiles }, `paste the format on ${tile.title}`);
  }

  /** Keeps (or with undefined, clears) the report's default look for a chart type. */
  function setVisualDefault(visual: DefaultableVisual, format: ChartFormat | undefined) {
    if (!dashboard) return;
    const defaults: VisualDefaults = { ...dashboard.settings.visualDefaults };
    if (format) defaults[visual] = format;
    else delete defaults[visual];
    const settings = { ...dashboard.settings };
    delete settings.visualDefaults;
    change(
      { ...dashboard, settings: Object.keys(defaults).length ? { ...settings, visualDefaults: defaults } : settings },
      format ? `set the default for ${VISUAL_NAMES[visual]}` : `reset the default for ${VISUAL_NAMES[visual]}`,
    );
  }

  function moveTile(index: number, to: number) {
    if (!dashboard) return;
    const tiles = moveTileTo(dashboard.tiles, index, to);
    if (tiles !== dashboard.tiles) change({ ...dashboard, tiles }, `move ${dashboard.tiles[index].title}`);
  }

  function putTile(tile: Tile) {
    if (!dashboard) return;
    const exists = dashboard.tiles.some((entry) => entry.id === tile.id);
    const tiles = exists ? dashboard.tiles.map((entry) => (entry.id === tile.id ? tile : entry)) : [...dashboard.tiles, tile];
    change({ ...dashboard, tiles }, exists ? `change ${tile.title}` : `add ${tile.title}`);
    setEditingTile(null);
  }

  /** Opens a text box (or a new one, with null) or any tile's heading in place. Nothing in the report changes yet. */
  function openInPlace(tile: Tile | null, mode: InPlaceEdit["mode"], pageId: string) {
    setInPlaceError(null);
    setEditingTile(null);
    const opened = startEdit(tile, mode, `t${Date.now().toString(36)}`);
    // A new box goes on the page shown.
    if (!tile && dashboard) {
      const draft = withPage(opened.draft, pageId, dashboard.settings.pages);
      setInPlace({ ...opened, start: draft, draft });
    } else setInPlace(opened);
  }

  // The box being edited stays in view: a new one is added at the end of the page.
  const inPlaceId = inPlace?.draft.id ?? null;
  useEffect(() => {
    if (!inPlaceId) return;
    // The editor and report fill the screen; then the box itself is brought into view if it's further down.
    const frame = requestAnimationFrame(() => {
      document.querySelector("[data-in-place-layout]")?.scrollIntoView({ block: "start" });
      document.querySelector('section[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [inPlaceId]);

  /** Saves the text or heading: it goes in the report and the report is saved. On failure the draft stays open. */
  async function saveInPlace(): Promise<boolean> {
    if (!dashboard || !inPlace) return true;
    if (draftProblems(inPlace).length) {
      setInPlaceError("This can't be saved yet. Fix what's shown, or choose Cancel to leave it as it was.");
      return false;
    }
    if (!hasChanged(inPlace) && inPlace.original) {
      setInPlace(null);
      return true;
    }
    const tile = finishDraft(inPlace);
    const label = inPlace.original ? (inPlace.mode === "heading" ? `change the heading of ${inPlace.original.title}` : `change ${tile.title}`) : `add ${tile.title}`;
    const ok = await save({ dashboard: { ...dashboard, tiles: withDraft(dashboard.tiles, tile) }, label });
    if (ok) setInPlace(null);
    return ok;
  }

  /** Drops the draft: the text box (or heading) is as it was, and a new box is gone. */
  async function cancelInPlace(ask: boolean) {
    if (ask && inPlaceChanged) {
      const ok = await confirm("Your changes to this text will be lost.", { title: "Discard the changes?", confirmLabel: "Discard", cancelLabel: "Keep editing", danger: true });
      if (!ok) return;
    }
    setInPlace(null);
    setInPlaceError(null);
  }

  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!dashboard) return <p className={ui.muted}>Loading…</p>;
  const pages = dashboard.settings.pages;
  // Just one tile (on a slide): its own page, so that page's slicers and filters apply to it.
  const onlyTile = embed?.tileId ? (dashboard.tiles.find((tile) => tile.id === embed.tileId) ?? null) : null;
  const page = openingPage(pages, onlyTile ? tilePage(onlyTile, pages) : pageChoice);
  // A text box being changed in place is drawn as its draft (a new one at the end), so the change shows on the report as it's made.
  const drawnTiles = inPlace ? withDraft(dashboard.tiles, inPlace.draft) : dashboard.tiles;
  const pageTiles = onlyTile ? [onlyTile] : tilesOnPage(drawnTiles, pages, page.id);
  if (embed?.tileId && !onlyTile) return <Notice tone="warning">That tile isn&apos;t in the report any more. Choose Change to pick another.</Notice>;
  const look = pageStyle(page, embed && !embed.print ? undefined : { organisationId, dashboardId: dashboard.id });
  // The slides are the pages in the tabs, in order (a hidden page is still reached by its button or drill-through).
  const slides = reportPages(pages).filter((entry) => !entry.hidden);
  const slideAt = slides.findIndex((entry) => entry.id === page.id);
  const startPresenting = () => {
    setPresenting(true);
    // Full screen when the browser allows it; otherwise it still fills the window.
    void presentRef.current?.requestFullscreen?.().catch(() => undefined);
    // The keys go to the report: arrows step through its pages.
    requestAnimationFrame(() => presentRef.current?.focus());
  };
  const stopPresenting = () => {
    setPresenting(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };
  const choosePage = (pageId: string, remember = true) => {
    if (remember && pageId !== page.id) setPageHistory((history) => [...history.slice(-19), page.id]);
    setPageChoice(pageId);
    setChosenTiles([]);
    const params = new URLSearchParams(window.location.search);
    params.set("page", pageId);
    // On a slide or in print the address isn't the person's to keep (and Office.js can take replaceState away).
    if (!embed) window.history.replaceState(null, "", `?${params.toString()}`);
  };
  /** A change to the pages, as one draft step; `key` makes typing a page's name one step. */
  const setPages = (next: { pages: ReportPage[] | undefined; tiles: Tile[] }, label: string, key?: string) => {
    const settings = { ...dashboard.settings };
    delete settings.pages;
    change({ ...dashboard, settings: next.pages ? { ...settings, pages: next.pages } : settings, tiles: next.tiles }, label, key);
  };
  // Clicks and drills, worked out the same way the server checks them.
  const grouping = (tile: Tile) => {
    if (!tile.query) return null;
    try {
      return drillView(tile.query, tile.drill, drills[tile.id], tile.title).groupBy;
    } catch {
      return tile.query.groupBy;
    }
  };
  const groupText = (tile: Tile, value: string | null) => {
    const level = grouping(tile);
    if (!level) return value ?? "(blank)";
    const shownValue = value === null ? "(blank)" : level.grain ? periodLabel(value, level.grain, dates.financialYearEndMonth) : value === "true" || value === "false" ? booleanText(value) : (tile.query ? valueLabel(tile.query.table, level.field, value) : value);
    return `${fieldLabel(level.field)}: ${shownValue}`;
  };
  const pickedTile = picked ? pageTiles.find((tile) => tile.id === picked.tileId) : undefined;
  const selectionOnly = (selection: Selection): Selection => ({ tileId: selection.tileId, value: selection.value, ...(selection.drill ? { drill: selection.drill } : {}) });
  const pick = (tile: Tile, value: string | null) => {
    const levels = tile.drill?.levels.length ?? 1;
    const state = drills[tile.id] ?? TOP;
    if (drillMode[tile.id] && tile.drill && state.level < levels - 1) {
      setDrills({ ...drills, [tile.id]: drillDown(state, value, levels) });
      if (picked?.tileId === tile.id) setPicked(null);
      return;
    }
    if (picked?.tileId === tile.id && picked.value === value) return setPicked(null);
    setPicked({ tileId: tile.id, value, ...(drills[tile.id] ? { drill: drills[tile.id] } : {}), label: groupText(tile, value), tileTitle: tile.title });
  };
  const setDrill = (tile: Tile, next: DrillState) => {
    const copy = { ...drills };
    if (next.level === 0) delete copy[tile.id];
    else copy[tile.id] = next;
    setDrills(copy);
    if (picked?.tileId === tile.id) setPicked(null);
  };
  const interactionFor = (tile: Tile): TileInteraction => {
    const selections: Selection[] = [];
    let highlight: { value: string | null } | null = null;
    if (picked && pickedTile && picked.tileId !== tile.id) {
      const mode = interactionMode(pickedTile, tile.id);
      let level = null;
      try {
        level = selectionLevel(dashboard.tiles, picked).level;
      } catch {
        level = null;
      }
      const mine = grouping(tile);
      // Highlight works on a tile grouped the same way; on any other it filters.
      if (mode === "highlight" && level && mine && mine.field === level.field && (mine.grain ?? null) === (level.grain ?? null)) highlight = { value: picked.value };
      else if (mode !== "none") selections.push(selectionOnly(picked));
    }
    if (picked?.tileId === tile.id) highlight = { value: picked.value };
    const drill = drills[tile.id];
    const throughList = through && through.to === page.id && through.selection.tileId !== tile.id ? [through.selection] : [];
    const view: TileView | undefined = drill || selections.length || throughList.length ? { ...(drill ? { drill } : {}), ...(selections.length ? { selections } : {}), ...(throughList.length ? { through: throughList } : {}) } : undefined;
    const canPick = !editing && DRILLABLE.includes(tile.visual) && Boolean(tile.query?.groupBy) && !tile.query?.breakdown;
    let ranges: Filter[] = [];
    try {
      ranges = rangeFilters(dashboard.settings.slicers.filter((slicer) => slicerOnPage(slicer, page.id)), shown.ranges ?? {});
    } catch {
      // A range still being typed: left out until it's a number or date.
    }
    const draftWhere = [...ranges, ...(page.filters ?? []).map((entry) => entry.filter)];
    return { view, viewTiles: dashboard.tiles, highlight, draftWhere, onPick: canPick ? (value) => pick(tile, value) : undefined };
  };
  const drillPages = (pages ?? []).filter((entry) => entry.drillThrough && entry.id !== page.id);
  const drillThrough = (target: ReportPage) => {
    if (!picked) return;
    setThrough({ selection: selectionOnly(picked), label: picked.label, from: page.id, to: target.id });
    setPicked(null);
    choosePage(target.id);
  };
  const viewChanged = Boolean(filters || picked || through || Object.keys(drills).length || hidden.length);
  /** Opens a bookmark: its page, dates, slicer choices and hidden tiles; nothing clicked or drilled. */
  const openBookmark = (id: string) => {
    const bookmark = dashboard.settings.bookmarks?.find((entry) => entry.id === id);
    if (!bookmark) return;
    const state = bookmark.state;
    const range = state.preset ? presetRange(state.preset, dates.today, dates.financialYearEndMonth) : { from: state.from, to: state.to };
    setFilters({ from: range.from ?? "", to: range.to ?? "", preset: state.preset, values: state.values, ranges: state.ranges });
    setDrills({});
    setPicked(null);
    setThrough(null);
    setHidden(state.hidden ?? []);
    setBookmarkShown(bookmark.id);
    choosePage(state.page);
  };
  const goBack = () => {
    const previous = pageHistory[pageHistory.length - 1];
    if (!previous) return;
    setPageHistory(pageHistory.slice(0, -1));
    if (through) setThrough(null);
    choosePage(previous, false);
  };
  /** What a report's buttons do. */
  const runButtonAction = (action: ButtonAction, target?: string) => {
    if (action === "reset_filters") resetView();
    else if (action === "go_to_page" && target) choosePage(target);
    else if (action === "bookmark" && target) openBookmark(target);
    else if (action === "back") goBack();
  };

  /** A tile added or changed, on the page shown. */
  const placed = (tile: Tile): Tile => {
    // The editors build the tile afresh: a changed tile stays on its page, a new one goes on the page shown.
    const existing = dashboard.tiles.find((entry) => entry.id === tile.id);
    return withPage(tile, existing ? tilePage(existing, pages) : page.id, pages);
  };
  const textTile = editingTile === "new-text" ? "new" : editingTile && editingTile !== "new" && isItemVisual(editingTile.visual) ? editingTile : null;
  const chartTile = textTile || editingTile === "new-text" ? null : editingTile;
  // The report's theme is scoped to its tiles and the editor's preview.
  const theme = reportTheme(dashboard.settings.theme, dashboard.customTheme);
  const themeScope = `report-theme-${dashboard.id}`;
  const themeClass = isTohyee(theme) ? themeScope : `${themeScope} ${styles.themed}`;

  const presentKeys = (event: React.KeyboardEvent) => {
    if (!presenting) return;
    // Typing in a slicer or a box isn't stepping through slides.
    if ((event.target as HTMLElement | null)?.closest?.("input, select, textarea, [contenteditable=true]")) return;
    const forward = event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ";
    const back = event.key === "ArrowLeft" || event.key === "PageUp";
    if (event.key === "Escape") stopPresenting();
    else if (forward && slideAt >= 0 && slideAt < slides.length - 1) choosePage(slides[slideAt + 1].id, false);
    else if (back && slideAt > 0) choosePage(slides[slideAt - 1].id, false);
    else if (event.key === "Home" && slides.length) choosePage(slides[0].id, false);
    else if (event.key === "End" && slides.length) choosePage(slides[slides.length - 1].id, false);
    else return;
    event.preventDefault();
  };

  return (
    <ReportThemeStyle theme={theme} scope={themeScope}>
      <YearEndMonth.Provider value={dates.financialYearEndMonth}>
      {/* Printing the report page itself goes landscape, like Present and Print or PDF. */}
      {embed ? null : <style>{"@media print { @page { size: A4 landscape; } }"}</style>}
      <div ref={presentRef} tabIndex={-1} onKeyDown={presentKeys} className={`${presenting ? `${styles.presenting} ${themeClass}` : styles.presentRoot}${embed?.print ? ` ${embed.print === "portrait" ? styles.paperPortrait : styles.paperLandscape}` : ""}`} data-presenting={presenting ? "true" : undefined}>
      {embed ? null : <div className={styles.header}>
        <div>
          {editing ? (
            // The name is edited where it's shown; the description sits under it.
            <div className={styles.inPlace}>
              <div className={styles.reportIdentity}>
                <IllustratedIcon name="analytics" />
                {/* Still the page's heading while editing, so a screen reader finds it. */}
                <h1 className={styles.title}>
                  <input
                    className={styles.titleInput}
                    aria-label="Report name"
                    value={dashboard.name}
                    maxLength={100}
                    required
                    onChange={(event) => change({ ...dashboard, name: event.target.value }, "rename the report", "name")}
                  />
                </h1>
              </div>
              <input
                className={styles.descriptionInput}
                aria-label="Description"
                placeholder="Add a description"
                value={dashboard.description ?? ""}
                maxLength={500}
                onChange={(event) => change({ ...dashboard, description: event.target.value }, "change the description", "description")}
              />
            </div>
          ) : (
            <>
              <div className={styles.reportIdentity}><IllustratedIcon name="analytics" /><h1 className={styles.title}>{dashboard.name}</h1></div>
              {dashboard.description ? <p className={ui.muted}>{dashboard.description}</p> : null}
            </>
          )}
        </div>
        <div className={ui.rowButtons} data-present="hide">
          {!editing ? <Button variant="secondary" onClick={startPresenting} title="Show the report full screen, a page at a time">Present</Button> : null}
          {!editing ? <Button variant="secondary" onClick={() => router.push(`/analytics/dashboards/${dashboard.id}/print`)} title="Every page on A4 sheets, to print or save as a PDF">Print or PDF</Button> : null}
          {canEdit ? <Button variant="secondary" aria-expanded={sharing} onClick={() => setSharing(!sharing)}>Share</Button> : null}
          {canEdit ? <Button variant="secondary" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>History</Button> : null}
          {canEdit && editing ? (
            <>
              <Button variant="secondary" onClick={() => setEditingTile("new")} disabled={busy || occupied || !tables.data?.tables.length}>
                + Add chart
              </Button>
              <Button variant="secondary" onClick={() => openInPlace(null, "text", page.id)} disabled={busy || occupied}>
                + Add text
              </Button>
              <Button variant="secondary" onClick={() => setEditingTile("new-text")} disabled={busy || occupied} title="An image, shape, button, accounting report, sign-off or directory">
                + Add item
              </Button>
              <Button
                variant="secondary"
                className={styles.iconButton}
                onClick={() => step("undo")}
                disabled={busy || occupied || !history || !undoLabel(history)}
                aria-label={history && undoLabel(history) ? `Undo ${undoLabel(history)}` : "Undo"}
                title={history && undoLabel(history) ? `Undo ${undoLabel(history)} (Ctrl+Z)` : "Nothing to undo"}
              >
                <span aria-hidden="true">↶</span>
              </Button>
              <Button
                variant="secondary"
                className={styles.iconButton}
                onClick={() => step("redo")}
                disabled={busy || occupied || !history || !redoLabel(history)}
                aria-label={history && redoLabel(history) ? `Redo ${redoLabel(history)}` : "Redo"}
                title={history && redoLabel(history) ? `Redo ${redoLabel(history)} (Ctrl+Shift+Z)` : "Nothing to redo"}
              >
                <span aria-hidden="true">↷</span>
              </Button>
              <Button onClick={() => void save()} disabled={busy || occupied || !unsaved}>
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button
                variant="secondary"
                onClick={async () => {
                  if (await save()) {
                    setEditing(false);
                    setEditingTile(null);
                  }
                }}
                disabled={busy || occupied}
              >
                {unsaved ? "Save and view" : "View"}
              </Button>
              {unsaved ? (
                // Leaving the editor without saving is always possible.
                <Button
                  variant="secondary"
                  title="Stop editing and put the report back as it was last saved"
                  disabled={busy || occupied}
                  onClick={async () => {
                    const ok = await confirm("Your changes since the last save will be lost.", { title: "Discard the changes?", confirmLabel: "Discard and view", cancelLabel: "Keep editing", danger: true });
                    if (!ok || !base) return;
                    change(base, "discard the changes");
                    setEditing(false);
                  }}
                >
                  Discard and view
                </Button>
              ) : null}
              <MoreMenu
                label="More report actions"
                items={[
                  { label: `Theme: ${theme.name}`, onSelect: () => setTheming(!theming), disabled: busy },
                  ...(unsaved ? [{ label: "Discard changes", onSelect: () => base && change(base, "discard the changes"), disabled: busy || occupied }] : []),
                  { label: "Delete report", onSelect: () => void remove(), danger: true, disabled: busy || occupied },
                ]}
              />
            </>
          ) : canEdit ? (
            <Button variant="secondary" onClick={() => void beginEditing()}>
              Edit
            </Button>
          ) : null}
        </div>
      </div>}
      {editing ? (
        <p className={styles.saveState} role="status" aria-live="polite">
          {busy ? "Saving…" : conflict || error ? "Not saved" : unsaved ? "Unsaved changes: Save to keep them. Viewers see the report as last saved." : "All changes saved"}
        </p>
      ) : null}
      {conflict ? (
        <Notice tone="error">
          <strong>Not saved.</strong> {conflict.updatedByEmail} saved this report{conflict.updatedAt ? ` at ${formatDateTime(conflict.updatedAt)}` : ""}, after you started changing it. Your changes
          are still here. Save them as a new report, or reload to see the saved version (your changes are then lost).
          <div className={`${ui.rowButtons} ${styles.conflictActions}`}>
            <Button size="small" onClick={() => void saveCopy()} disabled={busy}>Save mine as a copy</Button>
            <Button size="small" variant="secondary" onClick={() => void reloadSaved(true)} disabled={busy}>Reload the saved report</Button>
          </div>
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {editing && tables.error ? <Notice tone="error">{tables.error}</Notice> : null}
      {editing && tables.data?.tables.length === 0 ? <Notice tone="info">Connect and load a <Link href="/analytics/sources">data source</Link> to start adding charts.</Notice> : null}

      <div data-present="hide">
      {embed && !embed.showFilters ? null : <FilterBar
        organisationId={organisationId}
        dashboardId={dashboard.id}
        settings={dashboard.settings}
        filters={shown}
        onChange={(next) => {
          setFilters(next);
          setBookmarkShown(null);
        }}
        editing={editing}
        tables={tables.data?.tables ?? []}
        dates={dates}
        onSettings={(settings) => change({ ...dashboard, settings }, "change the dates and slicers", "settings")}
        pageId={page.id}
        pages={reportPages(pages)}
      />}
      </div>

      {embed?.onePage ? null : <div data-present="hide"><ReportFreshnessLine organisationId={organisationId} dashboardId={dashboard.id} /></div>}
      {presenting && slides.length > 1 ? <p className={styles.slideName}>{page.name}</p> : null}
      {onlyTile || presenting || embed?.print || embed?.onePage ? null : <PageTabs
        pages={pages}
        current={page.id}
        // While text is being changed in place the page stays put, so the draft stays in view.
        onChoose={inPlace ? () => undefined : choosePage}
        editing={editing && !inPlace}
        pictures={{ organisationId, dashboardId: dashboard.id }}
        panelId={`report-page-${dashboard.id}`}
        onAdd={() => {
          const id = `p${Date.now().toString(36)}`;
          setPages(addPage(pages, dashboard.tiles, id), "add a page");
          choosePage(id);
        }}
        onUpdate={(changed) => setPages({ pages: (pages?.length ? pages : [page]).map((entry) => (entry.id === changed.id ? changed : entry)), tiles: dashboard.tiles }, `change the ${changed.name || "page"} page`, `page-${changed.id}`)}
        onMove={(pageId, by) => setPages(movePage(pages, dashboard.tiles, pageId, by), "move a page")}
        filterEditor={(shownPage) => (
          <PageFilters
            organisationId={organisationId}
            tables={tables.data?.tables ?? []}
            filters={shownPage.filters ?? []}
            onChange={(next) => {
              const copy = { ...shownPage };
              delete copy.filters;
              const changed = next.length ? { ...copy, filters: next } : copy;
              setPages({ pages: (pages?.length ? pages : [page]).map((entry) => (entry.id === changed.id ? changed : entry)), tiles: dashboard.tiles }, `change the ${changed.name} page's filters`, `page-filters-${changed.id}`);
            }}
          />
        )}
        onRemove={async (gone) => {
          const count = tilesOnPage(dashboard.tiles, pages, gone.id).length;
          const ok = await confirm(count ? `Remove the ${gone.name} page and its ${count} ${count === 1 ? "tile" : "tiles"}? Nothing is saved until you choose Save.` : `Remove the ${gone.name} page?`, { title: "Remove page?", confirmLabel: "Remove", danger: true });
          if (!ok) return;
          setPages(removePage(pages, dashboard.tiles, gone.id), `remove the ${gone.name} page`);
          setPageChoice(null);
        }}
      />}

      {onlyTile || inPlace ? null : <BookmarkBar
        bookmarks={dashboard.settings.bookmarks ?? []}
        shown={bookmarkShown}
        editing={editing}
        pageTiles={pageTiles}
        onOpen={openBookmark}
        current={(): BookmarkState => ({
          page: page.id,
          from: shown.preset ? null : shown.from || null,
          to: shown.preset ? null : shown.to || null,
          preset: shown.preset ?? null,
          values: Object.fromEntries(Object.entries(shown.values).filter(([, list]) => list.length)),
          ranges: shown.ranges ?? {},
          ...(hidden.length ? { hidden } : {}),
        })}
        onChange={(bookmarks) => {
          const settings = { ...dashboard.settings };
          delete settings.bookmarks;
          change({ ...dashboard, settings: bookmarks.length ? { ...settings, bookmarks } : settings }, "change the bookmarks", "bookmarks");
        }}
      />}

      {sharing && canEdit && !inPlace ? <ShareCard organisationId={organisationId} dashboardId={dashboard.id} /> : null}
      {showHistory && canEdit && !inPlace ? (
        <DashboardHistoryCard
          organisationId={organisationId}
          dashboardId={dashboard.id}
          version={base?.version ?? dashboard.version}
          unsaved={unsaved}
          onRestored={(restored) => {
            setSaved(restored);
            setHistory(null);
            setConflict(null);
          }}
        />
      ) : null}

      {theming && editing && canEdit && !inPlace ? (
        <ThemePanel
          organisationId={organisationId}
          choice={dashboard.settings.theme}
          current={theme}
          onClose={() => setTheming(false)}
          onChoose={(choice, chosen) => {
            const settings = { ...dashboard.settings };
            delete settings.theme;
            change({ ...dashboard, settings: choice ? { ...settings, theme: choice } : settings, customTheme: choice?.startsWith("custom:") ? chosen : null }, `choose the ${chosen.name} theme`);
          }}
        />
      ) : null}

      {copied && editing ? (
        <Notice tone="info">
          Format copied from {copied.title}. Choose <strong>Paste format</strong> on the tiles to give them the same look.{" "}
          <Button size="small" variant="secondary" onClick={() => setCopied(null)}>Done pasting</Button>
        </Notice>
      ) : null}

      {canEdit && textTile ? (
        <ItemEditor
          key={textTile === "new" ? "new-text" : textTile.id}
          saving={busy}
          tile={textTile === "new" ? null : textTile}
          organisationId={organisationId}
          dashboardId={dashboard.id}
          tables={tables.data?.tables ?? []}
          filters={shown}
          onCancel={() => setEditingTile(null)}
          targets={{ pages: reportPages(pages).map((entry) => ({ id: entry.id, name: entry.name })), bookmarks: (dashboard.settings.bookmarks ?? []).map((entry) => ({ id: entry.id, name: entry.name })) }}
          onSave={(given) => putTile(placed(given))}
        />
      ) : chartTile && canEdit ? (
        <TileEditor
          key={chartTile === "new" ? "new" : chartTile.id}
          saving={busy}
          organisationId={organisationId}
          tables={tables.data?.tables ?? []}
          onTablesChanged={tables.reload}
          tile={chartTile === "new" ? null : chartTile}
          filters={shown}
          defaults={dashboard.settings.visualDefaults}
          themeClass={themeClass}
          theme={theme}
          onSetDefault={setVisualDefault}
          others={pageTiles.filter((entry) => entry.id !== (chartTile === "new" ? "" : chartTile.id) && !isItemVisual(entry.visual)).map((entry) => ({ id: entry.id, title: entry.title }))}
          onCancel={() => setEditingTile(null)}
          onSave={(given) => putTile(placed(given))}
        />
      ) : null}

      {!editing && (picked || (through && through.to === page.id) || viewChanged) ? (
        <div className={styles.trail} role="region" aria-label="What this page is filtered by">
          {through && through.to === page.id ? (
            <span className={styles.crumb}>
              Drilled through to {page.name}: <strong>{through.label}</strong>
              <Button size="small" variant="secondary" onClick={() => { const back = through.from; setThrough(null); choosePage(back); }}>← Back</Button>
            </span>
          ) : null}
          {picked ? (
            <span className={styles.crumb}>
              Filtered by <strong>{picked.label}</strong> <span className={ui.muted}>(chosen on {picked.tileTitle})</span>
              <Button size="small" variant="secondary" aria-label={`Clear ${picked.label}`} onClick={() => setPicked(null)}>Clear</Button>
              {drillPages.map((target) => (
                <Button key={target.id} size="small" variant="secondary" onClick={() => drillThrough(target)}>Drill through to {target.name}</Button>
              ))}
            </span>
          ) : null}
          {viewChanged ? <Button size="small" variant="secondary" onClick={resetView}>Reset to default</Button> : null}
        </div>
      ) : null}

      {editing && !occupied ? (
        <ArrangeBar
          tiles={pageTiles}
          chosen={chosenTiles.filter((id) => pageTiles.some((tile) => tile.id === id))}
          onClear={() => setChosenTiles([])}
          onArrange={(tiles, label) => change({ ...dashboard, tiles: [...tiles, ...dashboard.tiles.filter((tile) => !pageTiles.includes(tile))] }, label)}
        />
      ) : null}

      {!editingTile && (
      <div className={inPlace && canEdit ? styles.editingLayout : styles.reportArea} data-in-place-layout={inPlace && canEdit ? "" : undefined}>
      {pageTiles.length === 0 ? (
        <Empty>{canEdit ? editing ? `Start ${pages?.length ? "this page" : "your report"} with Add chart. Choose a source, a visual and the fields to show.` : "This page is empty. Choose Edit to add a chart." : "No tiles yet."}</Empty>
      ) : (
        <div id={`report-page-${dashboard.id}`} role={pages?.length ? "tabpanel" : undefined} aria-label={pages?.length ? page.name : undefined} style={look.style} className={`${styles.grid} ${themeClass} ${look.tinted ? styles.tintedPage : ""} ${look.style.background ? styles.colouredPage : ""} ${look.pictured ? styles.picturedPage : ""}`}>
          {drawnTiles.map((tile, index) => {
            if (!pageTiles.includes(tile) || (!editing && hidden.includes(tile.id))) return null;
            const isDraft = inPlace?.draft.id === tile.id;
            // Moving goes past the tiles of other pages.
            const before = dashboard.tiles.lastIndexOf(pageTiles[pageTiles.indexOf(tile) - 1]);
            const after = dashboard.tiles.indexOf(pageTiles[pageTiles.indexOf(tile) + 1]);
            // Drawn with the report's default for its chart type under its own settings.
            const shownTile = tileWithDefaults(tile, dashboard.settings.visualDefaults);
            const look = cardStyle(shownTile.format);
            return (
            <section
              key={tile.id}
              style={look.card}
              // Writing may run over printed sheets; everything else stays in one piece.
              data-flows={shownTile.visual === "text" ? "true" : undefined}
              className={`${tileClass(shownTile)} ${dropAt === index && dragging !== null && dragging !== index ? styles.dropTarget : ""} ${dragging === index ? styles.dragging : ""} ${editing && chosenTiles.includes(tile.id) ? styles.chosenTile : ""} ${isDraft ? styles.draftTile : ""}`}
              aria-current={isDraft ? "true" : undefined}
              draggable={editing && !busy && !inPlace}
              onDragStart={(event) => {
                setDragging(index);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", tile.id);
              }}
              onDragOver={(event) => {
                if (dragging === null) return;
                event.preventDefault();
                setDropAt(index);
              }}
              onDragLeave={() => setDropAt((current) => (current === index ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== null) moveTile(dragging, index);
                setDragging(null);
                setDropAt(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropAt(null);
              }}
            >
              <div className={styles.tileHeader}>
                <div>
                  <h2 className={shownTile.format?.card?.showTitle === false ? styles.visuallyHidden : styles.tileTitle} style={shownTile.format?.card?.showTitle === false ? undefined : look.title}>
                    {editing && canEdit && !inPlace && shownTile.format?.card?.showTitle !== false ? (
                      // Click a heading to change its words and colour, with the chart in view.
                      <button
                        type="button"
                        className={styles.headingButton}
                        title={tile.visual === "text" ? "Edit text" : "Edit heading"}
                        aria-label={`${tile.visual === "text" ? "Edit text" : "Edit heading"}: ${tile.title}`}
                        onClick={() => openInPlace(tile, tile.visual === "text" ? "text" : "heading", page.id)}
                        disabled={busy}
                      >
                        {tile.title}
                        <span className={styles.headingPencil} aria-hidden="true">✎</span>
                      </button>
                    ) : (
                      tile.title
                    )}
                  </h2>
                  {shownTile.format?.card?.subtitle ? <p className={styles.tileSubtitle} style={look.subtitle}>{shownTile.format.card.subtitle}</p> : null}
                  {tile.dates ? <p className={styles.tileDates}>{tileDatesText(tile.dates, formatDate)}</p> : null}
                </div>
                {editing && isDraft ? (
                  <span className={styles.draftBadge}>{inPlace?.original ? "Editing" : "New, not saved"}</span>
                ) : editing && inPlace ? null : editing ? (
                  <div className={styles.tileTools}>
                    <label className={`${ui.checkbox} ${styles.chooseTile}`}>
                      <input
                        type="checkbox"
                        aria-label={`Choose ${tile.title} to line up or size`}
                        checked={chosenTiles.includes(tile.id)}
                        onChange={(event) => setChosenTiles((current) => (event.target.checked ? [...current, tile.id] : current.filter((id) => id !== tile.id)))}
                      />{" "}
                      Select
                    </label>
                    <span className={styles.dragHandle} aria-hidden="true" title="Drag to move">⠿</span>
                    <Button size="small" variant="secondary" aria-label={`Move ${tile.title} earlier`} onClick={() => moveTile(index, before)} disabled={busy || before < 0}>
                      ↑
                    </Button>
                    <Button
                      size="small"
                      variant="secondary"
                      aria-label={`Move ${tile.title} later`}
                      onClick={() => moveTile(index, after)}
                      disabled={busy || after < 0}
                    >
                      ↓
                    </Button>
                    {tile.visual === "text" ? (
                      <Button size="small" variant="secondary" aria-label={`Edit text: ${tile.title}`} onClick={() => openInPlace(tile, "text", page.id)} disabled={busy}>
                        Edit text
                      </Button>
                    ) : (
                      <Button size="small" variant="secondary" aria-label={`Edit ${tile.title}`} onClick={() => setEditingTile(tile)} disabled={busy}>
                        Edit
                      </Button>
                    )}
                    {isItemVisual(tile.visual) ? null : copied && copied.from !== tile.id ? (
                      <Button size="small" variant="secondary" aria-label={`Paste format on ${tile.title}`} onClick={() => paste(tile)} disabled={busy}>
                        Paste format
                      </Button>
                    ) : (
                      <Button
                        size="small"
                        variant="secondary"
                        aria-label={`Copy the format of ${tile.title}`}
                        aria-pressed={copied?.from === tile.id}
                        onClick={() => setCopied(copied?.from === tile.id ? null : { from: tile.id, title: tile.title, format: tile.format })}
                        disabled={busy}
                      >
                        {copied?.from === tile.id ? "Copied" : "Copy format"}
                      </Button>
                    )}
                    <Button
                      size="small"
                      variant="secondary"
                      aria-label={`Duplicate ${tile.title}`}
                      onClick={() => change({ ...dashboard, tiles: duplicateTile(dashboard.tiles, index, `t${Date.now().toString(36)}`) }, `duplicate ${tile.title}`)}
                      disabled={busy || dashboard.tiles.length >= 40}
                    >
                      Duplicate
                    </Button>
                    <Button
                      size="small"
                      variant="danger"
                      aria-label={`Remove ${tile.title}`}
                      onClick={() => change({ ...dashboard, tiles: dashboard.tiles.filter((entry) => entry.id !== tile.id) }, `remove ${tile.title}`)}
                      disabled={busy}
                    >
                      Remove
                    </Button>
                  </div>
                ) : isItemVisual(tile.visual) || embed || presenting ? null : (
                  // Only saved tiles can be pinned, so not while the dashboard is being changed.
                  <PinTileMenu organisationId={organisationId} dashboardId={dashboard.id} tileId={tile.id} />
                )}
              </div>
              {!editing ? (
                <>
                  {tile.drill ? (
                      <DrillTools
                        title={tile.title}
                        levels={tile.drill.levels.length}
                        state={drills[tile.id] ?? TOP}
                        on={drillMode[tile.id] === true}
                        path={(drills[tile.id]?.path ?? []).map((value, at) => {
                          const level = tile.drill!.levels[at];
                          return value === null ? "(blank)" : level.grain ? periodLabel(value, level.grain, dates.financialYearEndMonth) : tile.query ? valueLabel(tile.query.table, level.field, value) : value;
                        })}
                        current={levelName(grouping(tile))}
                        onToggle={() => setDrillMode({ ...drillMode, [tile.id]: !drillMode[tile.id] })}
                        onUp={() => setDrill(tile, drillUp(drills[tile.id] ?? TOP))}
                        onExpand={() => setDrill(tile, expandAll(drills[tile.id] ?? TOP, tile.drill!.levels.length))}
                      />
                    ) : null}
                </>
              ) : null}
              {editing ? (
                // Clicking a tile opens it for changing (the Edit button does the same from the keyboard).
                <div
                  className={styles.clickToEdit}
                  title="Click to edit"
                  onClick={(event) => {
                    if (busy || inPlace || (event.target as HTMLElement).closest("button, a, input, select, textarea, summary")) return;
                    if (tile.visual === "text") openInPlace(tile, "text", page.id);
                    else setEditingTile(tile);
                  }}
                >
                  <TileBody organisationId={organisationId} dashboardId={dashboard.id} tile={shownTile} filters={shown} asSaved={savedQueries.get(tile.id) === JSON.stringify(tile.query)} reportSaved={tile.visual === "directory" ? Boolean(base?.tiles.some((entry) => entry.visual === "directory")) : tile.visual !== "report" || base?.tiles.find((entry) => entry.id === tile.id)?.report?.id === tile.report?.id} onAction={runButtonAction} {...interactionFor(tile)} />
                </div>
              ) : (
                <TileBody organisationId={organisationId} dashboardId={dashboard.id} tile={shownTile} filters={shown} asSaved={savedQueries.get(tile.id) === JSON.stringify(tile.query)} reportSaved={tile.visual === "directory" ? Boolean(base?.tiles.some((entry) => entry.visual === "directory")) : tile.visual !== "report" || base?.tiles.find((entry) => entry.id === tile.id)?.report?.id === tile.report?.id} onAction={runButtonAction} {...interactionFor(tile)} />
              )}
              {tile.commentary ? (
                <CommentaryNote
                  organisationId={organisationId}
                  dashboard={dashboard}
                  tile={tile}
                  canDecide={canEdit && !editing}
                  onChanged={(fresh) => {
                    setSaved(fresh);
                    setHistory(null);
                  }}
                />
              ) : null}
            </section>
            );
          })}
        </div>
      )}
      {inPlace && canEdit ? (
        <div className={styles.inspectorColumn}>
        <TextInspector
          key={`${inPlace.mode}-${inPlace.draft.id}`}
          edit={inPlace}
          swatches={themeSwatches(theme.light)}
          tables={tables.data?.tables ?? []}
          saving={busy}
          error={inPlaceError}
          problems={draftProblems(inPlace)}
          changed={inPlaceChanged}
          onChange={(draft) => setInPlace((current) => (current ? { ...current, draft } : current))}
          onSave={() => void saveInPlace()}
          onCancel={(ask) => void cancelInPlace(ask)}
        />
        </div>
      ) : null}
      </div>
      )}
      {presenting ? (
        <div className={styles.slideBar} role="group" aria-label="Slides">
          <Button size="small" variant="secondary" disabled={slideAt <= 0} onClick={() => choosePage(slides[slideAt - 1].id, false)} aria-label="Previous page">←</Button>
          <span aria-live="polite">{slides.length > 1 ? `${slideAt + 1} of ${slides.length}` : "1 of 1"}</span>
          <Button size="small" variant="secondary" disabled={slideAt < 0 || slideAt >= slides.length - 1} onClick={() => choosePage(slides[slideAt + 1].id, false)} aria-label="Next page">→</Button>
          <Button size="small" variant="secondary" onClick={stopPresenting}>Exit</Button>
        </div>
      ) : null}
      </div>
      </YearEndMonth.Provider>
    </ReportThemeStyle>
  );
}
