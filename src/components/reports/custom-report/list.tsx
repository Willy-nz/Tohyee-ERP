"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge,Button,Card,Empty,Notice,ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api,errorMessage,newIdempotencyKey } from "@/lib/client/api";
import { formatDate,formatDateTime,todayInBrowser,personName } from "@/lib/format";
import type { AnnualDraftSummary } from "@/lib/reports/annual-document";
import type { CustomReport,CustomReportView } from "@/lib/reports/custom";
import {
CUSTOM_REPORT_BASES,type CustomReportBase,lastDayOfMonth
} from "@/lib/reports/custom-layout";
import { useConfirm } from "@/components/confirm-dialog";
import { pageHref } from "@/components/reports/custom-report";

/** What each starting point gives (CRS1). */
const START_TEXT: Partial<Record<CustomReportBase, string>> = {
  profit_and_loss: "Revenue, cost of sales, gross profit, other income, expenses and net profit.",
  balance_sheet: "Assets, liabilities, net assets, equity, earnings and total equity.",
  cash_flows: "Operating, investing and financing, then the net change and cash at the start and end.",
  trial_balance: "Every account's debit or credit balance at the end of this month.",
  inventory_valuation: "Each stock item's quantity, average cost and value today.",
  bank_reconciliation: "Your first bank account at the end of this month. Save one from the Bank reconciliation report to choose the account.",
  budget_vs_actual: "Your latest budget against actuals this financial year. Save one from the Budget vs actual report to choose the budget.",
  changes_in_equity: "Equity at the start, profit, owner money in and out, and equity at the end.",
};

export function StartCustomReport({ organisationId }: { organisationId: string }) {
  const router = useRouter();
  const { can } = useWorkspace();
  const [keys] = useState(() => Object.fromEntries(Object.keys(CUSTOM_REPORT_BASES).map((base) => [base, newIdempotencyKey("custom-report")])) as Record<CustomReportBase, string>);
  const [busy, setBusy] = useState<CustomReportBase | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [ledgerKey] = useState(() => newIdempotencyKey("custom-report"));

  async function start(base: CustomReportBase, generalLedger = false) {
    setBusy(base);
    setError(null);
    const periodEnd = lastDayOfMonth(todayInBrowser());
    try {
      const result = await api<{ report: CustomReport }>("/api/custom-reports", {
        method: "POST",
        body: generalLedger
          ? {
              organisationId,
              source: "ui",
              idempotencyKey: ledgerKey,
              base,
              layout: {
                title: "General ledger",
                filters: {
                  from: null,
                  to: periodEnd,
                  accountId: null,
                  trackingCategoryId: null,
                  trackingValueId: null,
                },
                columns: ["date", "source", "description", "debit", "credit", "balance"],
              },
            }
          : {
              organisationId,
              source: "ui",
              idempotencyKey: keys[base],
              base,
              periodEnd,
            },
      });
      router.push(pageHref(result.report.id));
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(null);
    }
  }

  if (!can("bookkeeper")) return <Notice tone="info">Only bookkeepers and admins can make custom reports.</Notice>;
  return (
    <Card
      title="New custom report"
      description="Start from a standard report, then change its title, columns and rows, and add tables and notes. It's saved as a draft; publish it to keep a copy that never changes."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid2}>
        {(Object.keys(CUSTOM_REPORT_BASES) as CustomReportBase[]).map((base) => (
          <div key={base} className={ui.stat}>
            <div className={ui.statLabel}>Start from</div>
            <div className={ui.statValue}>{CUSTOM_REPORT_BASES[base]}</div>
            <p className={ui.muted}>{START_TEXT[base] ?? "Save the report's filters and columns as a new editable custom report."}</p>
            <Button onClick={() => void start(base)} disabled={busy !== null}>
              {busy === base ? "Starting…" : "Start from this"}
            </Button>
          </div>
        ))}
        <div className={ui.stat}>
          <div className={ui.statLabel}>Start from</div>
          <div className={ui.statValue}>General ledger</div>
          <p className={ui.muted}>Every account with a balance or lines this financial year: opening, lines and closing.</p>
          <Button onClick={() => void start("account_transactions", true)} disabled={busy !== null}>
            Start from this
          </Button>
        </div>
        <div className={ui.stat}>
          <div className={ui.statLabel}>Start from</div>
          <div className={ui.statValue}>Annual financial statements</div>
          <p className={ui.muted}>Built from your profit and loss, balance sheet, changes in equity and cash flows layouts: edit them with Edit layout beside each statement.</p>
          <Link className={`${ui.button} ${ui.secondary}`} href="/operations/reports?report=statements">
            Open the statements
          </Link>
        </div>
      </div>
    </Card>
  );
}

/** A row of Drafts, Published or Archived: a custom report or a saved set of annual financial statements (FS17). */
type ListedReport = {
  key: string;
  id: string;
  source: "custom" | "annual";
  title: string;
  startedFrom: string;
  when: string;
  who: string;
  href: string;
  /** Drafts can be deleted; published copies are archived instead, and a final set is saved as a draft first. */
  deletable: boolean;
  badge: "Published" | "Draft" | "Final" | null;
};

export function CustomReportList({ organisationId, view }: { organisationId: string; view: CustomReportView }) {
  const { can } = useWorkspace();
  const confirm = useConfirm();
  const [version, setVersion] = useState(0);
  const list = useApiData<{ reports: CustomReport[] }>("/api/custom-reports", {
    organisationId,
    view,
    v: version,
  });
  // Saved sets of annual financial statements: drafts under Drafts, final sets under Published (FS17).
  const annual = useApiData<{ drafts: AnnualDraftSummary[] }>(view === "archived" ? null : "/api/reports/annual-statements/drafts", {
    organisationId,
    status: view === "drafts" ? "draft" : "final",
    v: version,
  });
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = list.data && (view === "archived" || annual.data);
  const rows: ListedReport[] = loaded
    ? [
        ...list.data!.reports.map(
          (report): ListedReport => ({
            key: `custom-${report.id}`,
            id: report.id,
            source: "custom",
            title: report.title,
            startedFrom: CUSTOM_REPORT_BASES[report.base],
            when: report.publishedAt ?? report.updatedAt,
            who: personName(report, "publishedBy") ?? personName(report, "updatedBy") ?? "",
            href: pageHref(report.id),
            deletable: report.kind === "draft",
            badge: view === "archived" ? (report.kind === "published" ? "Published" : "Draft") : null,
          }),
        ),
        ...(annual.data?.drafts ?? []).map(
          (set): ListedReport => ({
            key: `annual-${set.id}`,
            id: set.id,
            source: "annual",
            title: set.title,
            startedFrom: `Annual financial statements, year ended ${formatDate(set.yearEnd)}`,
            when: set.updatedAt,
            who: personName(set, "updatedBy") ?? "",
            href: `/operations/reports?report=statements&yearEnd=${encodeURIComponent(set.yearEnd)}&draft=${encodeURIComponent(set.id)}`,
            deletable: set.status === "draft",
            badge: view === "published" ? "Final" : null,
          }),
        ),
      ].sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0))
    : [];
  const deletable = rows.filter((row) => row.deletable);
  const canDelete = can("bookkeeper") && deletable.length > 0;
  async function remove(keys: string[]) {
    const picked = deletable.filter((row) => keys.includes(row.key));
    if (picked.length === 0) return;
    const ok = await confirm(picked.length === 1 ? `Delete the draft "${picked[0].title}"? This can't be undone.` : `Delete these ${picked.length} drafts? This can't be undone.`, {
      title: picked.length === 1 ? "Delete draft" : "Delete drafts",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      for (const row of picked)
        await api(row.source === "annual" ? `/api/reports/annual-statements/drafts/${row.id}` : `/api/custom-reports/${row.id}`, {
          method: "DELETE",
          query: { organisationId },
        });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setChosen([]);
      setBusy(false);
      setVersion((value) => value + 1);
    }
  }
  const empty = {
    drafts: "No draft reports. Start one under Custom, or save the annual financial statements as a draft.",
    published: "No published reports. Publish a draft to keep a copy that never changes.",
    archived: "Nothing archived.",
  }[view];
  const loadError = list.error ?? (view === "archived" ? null : annual.error);
  return (
    <Card
      title={{ drafts: "Drafts", published: "Published", archived: "Archived" }[view]}
      actions={
        canDelete ? (
          <Button variant="secondary" disabled={busy || chosen.length === 0} onClick={() => void remove(chosen)}>
            {chosen.length > 0 ? `Delete ${chosen.length} selected` : "Delete selected"}
          </Button>
        ) : undefined
      }
    >
      {loadError ? <Notice tone="error">{loadError}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!loaded && !loadError ? <p className={ui.muted}>Loading…</p> : null}
      {loaded && rows.length === 0 ? <Empty>{empty}</Empty> : null}
      {loaded && rows.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                {canDelete ? (
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select every draft"
                      checked={chosen.length > 0 && chosen.length === deletable.length}
                      onChange={(event) => setChosen(event.target.checked ? deletable.map((row) => row.key) : [])}
                    />
                  </th>
                ) : null}
                <th>Title</th>
                <th>Started from</th>
                <th>{view === "published" ? "Published" : "Last changed"}</th>
                {view !== "drafts" ? <th>{view === "archived" ? "Was" : ""}</th> : null}
                {canDelete ? <th aria-label="Delete" /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  {canDelete ? (
                    <td>
                      {row.deletable ? (
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.title}`}
                          checked={chosen.includes(row.key)}
                          onChange={(event) => setChosen(event.target.checked ? [...chosen, row.key] : chosen.filter((key) => key !== row.key))}
                        />
                      ) : null}
                    </td>
                  ) : null}
                  <td>
                    <Link href={row.href}>{row.title}</Link>
                  </td>
                  <td>{row.startedFrom}</td>
                  <td>
                    {formatDateTime(row.when)} · {row.who}
                  </td>
                  {view !== "drafts" ? <td>{row.badge ? <Badge tone={row.badge === "Draft" ? undefined : row.badge === "Final" ? "green" : "blue"}>{row.badge}</Badge> : null}</td> : null}
                  {canDelete ? (
                    <td>
                      {row.deletable ? (
                        <Button size="small" variant="secondary" disabled={busy} onClick={() => void remove([row.key])}>
                          Delete
                        </Button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
