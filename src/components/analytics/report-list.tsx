"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { useModules } from "@/components/modules";
import { Button,Card,Empty,Field,Notice,ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { buildTemplate,TEMPLATES,type TemplateId } from "@/lib/analytics/templates";
import { todayIsoDate } from "@/lib/dates";
import type { Dashboard } from "@/lib/analytics/dashboards";
import { api,errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import styles from "@/components/analytics-dashboards.module.css";
import { ITEM_NAMES,TableInfo,VISUALS } from "@/components/analytics/report-shared";

/**
 * Organisations seen with Analytics on in this tab. Coming back to a page,
 * it shows straight away while the setting is checked again, rather than
 * "Loading…" in place of the page and its buttons.
 */
const analyticsSeenOn = new Set<string>();

export function RequireAnalytics({ organisationId, children }: { organisationId: string; children: React.ReactNode }) {
  const modules = useModules(organisationId);
  const { can } = useWorkspace();
  if (modules?.analytics) analyticsSeenOn.add(organisationId);
  if (modules && !modules.analytics) analyticsSeenOn.delete(organisationId);
  if (!modules) return analyticsSeenOn.has(organisationId) ? <>{children}</> : <p className={ui.muted}>Loading…</p>;
  if (!modules.analytics) {
    return (
      <Notice tone="info">
        Analytics is off.{" "}
        {can("admin") ? (
          <>
            Turn it on in <Link href="/operations/modules">Modules</Link>.
          </>
        ) : (
          "An admin can turn it on in Settings."
        )}
      </Notice>
    );
  }
  return <>{children}</>;
}

/** Analytics › Dashboards: the list, and making a new one. */
export function DashboardsList({ organisationId }: { organisationId: string }) {
  return (
    <RequireAnalytics organisationId={organisationId}>
      <DashboardsListInner organisationId={organisationId} />
    </RequireAnalytics>
  );
}

function DashboardsListInner({ organisationId }: { organisationId: string }) {
  const router = useRouter();
  const { can } = useWorkspace();
  const list = useApiData<{ dashboards: Dashboard[] }>("/api/analytics/dashboards", { organisationId });
  // Report viewers see only shared dashboards, not the tables.
  const tables = useApiData<{ tables: TableInfo[] }>(can("viewer") ? "/api/analytics/tables" : null, { organisationId });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("recent");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<TemplateId | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      // A template is an ordinary report filled with tiles, so everything can be changed after.
      const built = template ? buildTemplate(template, tables.data?.tables ?? [], todayIsoDate("Pacific/Auckland")) : null;
      const { dashboard } = await api<{ dashboard: Dashboard }>("/api/analytics/dashboards", {
        method: "POST",
        body: built
          ? { organisationId, name: name.trim() || built.name, description: built.description, settings: built.settings, tiles: built.tiles }
          : { organisationId, name: name.trim() || "Untitled report", tiles: [] },
      });
      router.push(`/analytics/dashboards/${dashboard.id}?edit=1`);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  const noTables = tables.data && tables.data.tables.length === 0;
  const reports = (list.data?.dashboards ?? []).filter((report) => `${report.name} ${report.description ?? ""}`.toLowerCase().includes(search.toLowerCase().trim()))
    .slice().sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt));
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {creating ? <Card title="Create a report">
        <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <Field label="Report name"><input autoFocus value={name} maxLength={100} placeholder={template ? TEMPLATES.find((entry) => entry.id === template)?.name : "e.g. Sales and gross profit"} onChange={(event) => setName(event.target.value)} /></Field>
          <fieldset className={styles.templates}>
            <legend>Start from</legend>
            <label className={styles.template}>
              <input type="radio" name="template" checked={template === ""} onChange={() => setTemplate("")} />
              <span><strong>A blank report</strong><span className={ui.muted}>Add charts one at a time.</span></span>
            </label>
            {TEMPLATES.map((entry) => {
              const available = Boolean(tables.data && buildTemplate(entry.id, tables.data.tables, "2026-01-01"));
              return (
                <label key={entry.id} className={styles.template} aria-disabled={!available}>
                  <input type="radio" name="template" disabled={!available} checked={template === entry.id} onChange={() => setTemplate(entry.id)} />
                  <span>
                    <strong>{entry.name}</strong>
                    <span className={ui.muted}>{available ? entry.description : entry.id === "crm" ? "Needs the CRM, copied with the books (Data sources › Refresh now)." : entry.id === "farm" ? "Needs Farming, copied with the books (Data sources › Refresh now)." : "Needs the books copy (Data sources › Refresh now)."}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          {noTables ? <Notice tone="info">Connect and load a <Link href="/analytics/sources">data source</Link> before adding charts.</Notice> : null}
          <div className={ui.rowButtons}><Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create report"}</Button><Button variant="secondary" disabled={busy} onClick={() => setCreating(false)}>Cancel</Button></div>
        </form>
      </Card> : null}
      <div className={styles.libraryToolbar}>
        <Field label="Search reports"><input type="search" placeholder="Find a report…" value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
        <Field label="Sort by"><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="recent">Last updated</option><option value="name">Name</option></select></Field>
        <div className={ui.rowButtons}><Button variant="secondary" aria-pressed={view === "grid"} onClick={() => setView("grid")}>Grid</Button><Button variant="secondary" aria-pressed={view === "list"} onClick={() => setView("list")}>List</Button></div>
        {can("bookkeeper") && !creating ? <Button onClick={() => setCreating(true)}>+ Create report</Button> : null}
      </div>
      {list.error ? <Notice tone="error">{list.error}</Notice> : !list.data ? <p className={ui.muted}>Loading reports…</p> : !reports.length ? <Empty picture="analytics">{search ? "No reports match your search." : can("bookkeeper") ? "Your first report starts here. Choose Create report to build it." : "No reports are available to you yet."}</Empty> : view === "list" ? (
        <div className={ui.tableWrap}><table className={ui.table}><thead><tr><th>Report</th><th>Charts and tables</th><th>Last updated</th></tr></thead><tbody>{reports.map((report) => <tr key={report.id}><td><Link href={`/analytics/dashboards/${report.id}`}>{report.name}</Link><div className={ui.muted}>{report.description}</div></td><td>{report.tiles.length}</td><td>{formatDateTime(report.updatedAt)}</td></tr>)}</tbody></table></div>
      ) : <div className={styles.dashboardCards}>{reports.map((report) => <Link key={report.id} href={`/analytics/dashboards/${report.id}`} className={styles.dashboardCard}>
        <div className={styles.reportThumbnail} aria-hidden="true">{report.tiles.length ? report.tiles.slice(0, 4).map((tile) => <span key={tile.id}>{ITEM_NAMES[tile.visual] ?? VISUALS.find((visual) => visual.value === tile.visual)?.label ?? tile.visual}</span>) : <span>Blank report</span>}</div>
        <strong>{report.name}</strong>{report.description ? <span className={ui.muted}>{report.description}</span> : null}<span className={styles.reportMeta}>{report.tiles.length} charts and tables · {formatDateTime(report.updatedAt)}</span>
      </Link>)}</div>}
    </>
  );
}
