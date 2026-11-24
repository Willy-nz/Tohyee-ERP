"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { BillStatusBadge } from "@/components/bills/bill-editor";
import { Money, RequireOrganisation, OrganisationActions } from "@/components/books";
import { CustomValueCell, listColumns, useCustomFields } from "@/components/custom-fields";
import { useApiData } from "@/components/hooks";
import { ListSearch } from "@/components/list-search";
import { type ListSortState, SortableHeading, sortQuery } from "@/components/list-sort";
import { PaidStatusBadge } from "@/components/invoices/invoice-editor";
import { Button, Empty, Notice, Page, PageHeader, ui } from "@/components/ui";
import type { BillStatus, BillSummary } from "@/lib/bills/service";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import { savedSearchFromList } from "@/lib/saved-searches/from-list";

type BillPage = { bills: BillSummary[]; nextBeforeId: string | null; nextOffset: number | null };

type Filter = { slug: string; label: string; status: BillStatus | null; awaitingPayment: boolean; empty: string };

const FILTERS: Filter[] = [
  { slug: "all", label: "All", status: null, awaitingPayment: false, empty: "No bills yet." },
  { slug: "drafts", label: "Drafts", status: "draft", awaitingPayment: false, empty: "No draft bills." },
  { slug: "approved", label: "Approved", status: "approved", awaitingPayment: false, empty: "No approved bills." },
  { slug: "awaiting", label: "Awaiting payment", status: null, awaitingPayment: true, empty: "No approved bills are awaiting payment." },
  { slug: "voided", label: "Voided", status: "voided", awaitingPayment: false, empty: "No voided bills." },
];

/** Which count belongs on which tab. */
const COUNT_KEYS: Record<string, string> = { all: "all", drafts: "draft", approved: "approved", awaiting: "awaitingPayment", voided: "voided" };

function BillList({ organisationId, filter, search, sort, onSort }: { organisationId: string; filter: Filter; search: string; sort: ListSortState; onSort: (next: ListSortState) => void }) {
  const { status } = filter;
  const awaitingPayment = filter.awaitingPayment ? "true" : null;
  const list = useApiData<BillPage>("/api/bills", { organisationId, status, awaitingPayment, search: search || null, ...sortQuery(sort) });
  const columns = listColumns(useCustomFields(organisationId).data, "document", ["bill"]);
  const [more, setMore] = useState<BillPage | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  const bills = [...(list.data?.bills ?? []), ...(more?.bills ?? [])];
  const nextBeforeId = more ? more.nextBeforeId : (list.data?.nextBeforeId ?? null);
  // A sorted list pages by position instead of from the last id.
  const nextOffset = more ? more.nextOffset : (list.data?.nextOffset ?? null);

  async function loadMore() {
    if (!nextBeforeId && nextOffset === null) return;
    try {
      const page = await api<BillPage>("/api/bills", {
        query: { organisationId, status, awaitingPayment, search: search || null, beforeId: nextBeforeId, ...sortQuery(sort), offset: nextOffset },
      });
      setMore((current) => ({ bills: [...(current?.bills ?? []), ...page.bills], nextBeforeId: page.nextBeforeId, nextOffset: page.nextOffset }));
    } catch (caught) {
      setMoreError(errorMessage(caught));
    }
  }

  if (list.error) {
    return <Notice tone="error">{list.error}</Notice>;
  }
  if (!list.data) {
    return <p className={ui.muted}>Loading…</p>;
  }
  if (bills.length === 0) {
    return <Empty>{search ? `No bills match “${search}”.` : filter.empty}</Empty>;
  }
  return (
    <>
      {moreError ? <Notice tone="error">{moreError}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <SortableHeading column="number" label="Supplier's invoice number" sort={sort} onSort={onSort} />
              <SortableHeading column="contact" label="Supplier" sort={sort} onSort={onSort} />
              <SortableHeading column="date" label="Date" sort={sort} onSort={onSort} />
              <SortableHeading column="due" label="Due" sort={sort} onSort={onSort} />
              {columns.map((field) => (
                <th key={field.id}>{field.label}</th>
              ))}
              <th>Status</th>
              <th>Payment</th>
              <SortableHeading column="total" label="Total" sort={sort} onSort={onSort} numeric />
              <th className={ui.num}>Amount due</th>
            </tr>
          </thead>
          <tbody>
            {bills.map((bill) => (
              <tr key={bill.id}>
                <td>
                  <Link href={`/operations/bills/${bill.id}`}>{bill.supplierInvoiceNumber ?? "(no number yet)"}</Link>
                </td>
                <td>{bill.contactName}</td>
                <td>{formatDate(bill.billDate)}</td>
                <td>{formatDate(bill.dueDate)}</td>
                {columns.map((field) => (
                  <CustomValueCell key={field.id} field={field} values={bill.customFields} />
                ))}
                <td>
                  <BillStatusBadge status={bill.status} />
                </td>
                <td>{bill.paidStatus ? <PaidStatusBadge status={bill.paidStatus} /> : null}</td>
                <td className={ui.num}>
                  <Money value={bill.total} />
                </td>
                <td className={ui.num}>{bill.amountDue !== null ? <Money value={bill.amountDue} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextBeforeId || nextOffset !== null ? (
        <div>
          <Button variant="secondary" onClick={() => void loadMore()}>
            Load older bills
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Bills({ organisationId }: { organisationId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  // The list shown is in the address (?show=), so the menus can open "Awaiting payment".
  const filter = FILTERS.find((entry) => entry.slug === params.get("show")) ?? FILTERS[0];
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ListSortState>(null);
  const counts = useApiData<Record<string, number>>("/api/bills/counts", { organisationId }).data;
  return (
    <div className={ui.listSection}>
      <div className={ui.tabs} role="tablist" aria-label="Bill status">
        {FILTERS.map((entry) => (
          <button
            key={entry.label}
            type="button"
            role="tab"
            aria-selected={filter === entry}
            className={`${ui.tab} ${filter === entry ? ui.tabActive : ""}`}
            onClick={() => router.replace(entry.slug === "all" ? "/operations/bills" : `/operations/bills?show=${entry.slug}`, { scroll: false })}
          >
            {entry.label}
            {counts ? <span className={ui.tabCount}> {counts[COUNT_KEYS[entry.slug]] ?? 0}</span> : null}
          </button>
        ))}
      </div>
      <ListSearch label="Search bills" placeholder="Supplier or their invoice number" onSearch={setSearch} />
      <p className={ui.muted}>
        Need more filters, or want to keep this one? <Link href={savedSearchFromList("bill", { status: filter.status, awaitingPayment: filter.awaitingPayment, sort, search })}>Save this view</Link>
      </p>
      <BillList key={`${filter.label}:${search}:${sort?.column}:${sort?.direction}`} organisationId={organisationId} filter={filter} search={search} sort={sort} onSort={setSort} />
    </div>
  );
}

export default function BillsPage() {
  const router = useRouter();
  return (
    <Page>
      <PageHeader title="Bills" actions={<OrganisationActions>{({ can }) => <>
          <Button variant="secondary" onClick={() => router.push("/operations/bills/inbox")}>
            Bills inbox
          </Button>
          {can("bookkeeper") ? <Button onClick={() => router.push("/operations/bills/new")}>New bill</Button> : null}
        </>}</OrganisationActions>} />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <Bills organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
