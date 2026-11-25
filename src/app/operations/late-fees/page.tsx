"use client";

import Link from "next/link";
import { useState } from "react";
import { AccountSelect, Money, RequireOrganisation } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { formatDate, todayInBrowser } from "@/lib/format";
import type { LateFeeCannot, LateFeeDue, LateFeeExclusion, LateFeeResult, LateFeeSettings } from "@/lib/invoices/late-fees";

type LateFeesView = {
  asOf: string;
  settings: LateFeeSettings;
  due: LateFeeDue[];
  cannotCharge: LateFeeCannot[];
  baseCurrency: string;
  totals: Array<{ currencyCode: string; total: string }>;
  exclusions: LateFeeExclusion[];
};

/**
 * Late payment fees and interest (LATE1-LATE12): an option an admin turns
 * on. What's due is shown first; nothing is charged until someone presses
 * the button, or the monthly run is turned on.
 */
export default function LateFeesPage() {
  return (
    <Page>
      <PageHeader title="Late fees" />
      <RequireOrganisation>{(organisationId) => <LateFees organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

function LateFees({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const view = useApiData<LateFeesView>("/api/late-fees", { organisationId });
  if (view.error) return <Notice tone="error">{view.error}</Notice>;
  if (!view.data) return <p className={ui.muted}>Loading…</p>;
  const { settings } = view.data;
  return (
    <div className={ui.stack}>
      <Notice>
        New Zealand law doesn&apos;t add late fees or interest by itself: you can charge them only if your terms of trade say so,
        and charges to consumers must be reasonable. Check your terms before turning this on.
      </Notice>
      {settings.enabled ? <DueNow organisationId={organisationId} view={view.data} canCharge={can("bookkeeper")} onDone={view.reload} /> : null}
      <SettingsCard key={settings.updatedAt ?? "new"} organisationId={organisationId} settings={settings} canEdit={can("admin")} onSaved={view.reload} />
      {settings.enabled ? <Exclusions organisationId={organisationId} exclusions={view.data.exclusions} canEdit={can("admin")} onChanged={view.reload} /> : null}
    </div>
  );
}

function DueNow({ organisationId, view, canCharge, onDone }: { organisationId: string; view: LateFeesView; canCharge: boolean; onDone: () => void }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LateFeeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function charge() {
    const noun = view.due.length === 1 ? "1 late payment invoice" : `${view.due.length} late payment invoices`;
    if (!(await confirm(`Make ${noun}, dated ${formatDate(view.asOf)}? ${view.settings.approve ? "They're approved straight away." : "They're saved as drafts for you to check."}`))) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api<LateFeeResult>("/api/late-fees/charge", { method: "POST", body: { organisationId, asOf: view.asOf } }));
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`Due to charge today (${formatDate(view.asOf)})`}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {result ? (
        <Notice tone={result.failed.length ? "warning" : "success"}>
          {result.charged.length} made{result.charged.length ? ` (${result.charged.map((made) => made.chargeInvoiceNumber ?? "draft").join(", ")})` : ""}.
          {result.failed.map((failed) => ` ${failed.invoiceNumber ?? failed.invoiceId}: ${failed.reason}`).join("")}
        </Notice>
      ) : null}
      {view.cannotCharge.length > 0 ? (
        <Notice tone="warning">
          {view.cannotCharge.length === 1 ? "1 overdue invoice can't be charged:" : `${view.cannotCharge.length} overdue invoices can't be charged:`}
          {view.cannotCharge.map((item) => ` ${item.invoiceNumber ?? item.invoiceId} (${item.contactName}): ${item.reason}`).join("")}
        </Notice>
      ) : null}
      {view.due.length === 0 ? (
        <Empty>Nothing to charge today.</Empty>
      ) : (
        <>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Customer</th>
                  <th>Due</th>
                  <th className={ui.num}>Still owing</th>
                  <th>Charge</th>
                  <th className={ui.num}>Total</th>
                </tr>
              </thead>
              <tbody>
                {view.due.map((item) => (
                  <tr key={item.invoiceId}>
                    <td data-label="Invoice">
                      <Link href={`/operations/invoices/${item.invoiceId}`}>{item.invoiceNumber ?? item.invoiceId}</Link>
                    </td>
                    <td data-label="Customer">{item.contactName}</td>
                    <td data-label="Due">{formatDate(item.dueDate)}</td>
                    <td data-label="Still owing" className={ui.num}>
                      <Money value={item.amountDue} /> {item.currencyCode}
                    </td>
                    <td data-label="Charge">
                      {item.feeTotal ? (
                        <div>
                          Fee <Money value={item.feeTotal} />
                          {item.exchangeRate ? ` ${item.currencyCode} (${view.settings.feeAmount} ${view.baseCurrency} at ${item.exchangeRate})` : ""} + GST if any
                        </div>
                      ) : null}
                      {item.interest ? (
                        <div className={ui.muted}>
                          Interest {item.interest.days} {item.interest.days === 1 ? "day" : "days"} from {formatDate(item.interest.from)}
                        </div>
                      ) : null}
                    </td>
                    <td data-label="Total" className={ui.num}>
                      <Money value={item.total} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={ui.muted}>
            Totals before GST: {view.totals.map((total) => `${total.total} ${total.currencyCode}`).join(", ")}. Each overdue invoice gets its own late
            payment invoice; the overdue invoice isn&apos;t changed. Interest is only charged on invoices that still have something owing when
            the charges are made: if one is paid in full between charges, the interest for the days since the last charge isn&apos;t charged, and an
            invoice paid late before it was ever charged isn&apos;t charged at all.
          </p>
          {canCharge ? (
            <Button disabled={busy} onClick={charge}>
              {busy ? "Making them…" : `Make ${view.due.length === 1 ? "the invoice" : `${view.due.length} invoices`}`}
            </Button>
          ) : null}
        </>
      )}
    </Card>
  );
}

function SettingsCard({ organisationId, settings, canEdit, onSaved }: { organisationId: string; settings: LateFeeSettings; canEdit: boolean; onSaved: () => void }) {
  const accounts = useApiData<{ accounts: Account[] }>("/api/accounts", { organisationId });
  const [form, setForm] = useState(() => formOf(settings));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  async function save(enabled: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/late-fees/settings", { method: "PUT", body: { organisationId, ...form, enabled } });
      setMessage({ tone: "success", text: enabled ? "Saved. Late fees are on." : "Saved. Late fees are off." });
      onSaved();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={settings.enabled ? "Settings: on" : "Late fees are off"}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <fieldset disabled={!canEdit || busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}>
        <Field label="Fee (before any GST)" hint="Charged once on each overdue invoice, with GST like the sale. Leave blank for none.">
          <input inputMode="decimal" value={form.feeAmount} onChange={(event) => set({ feeAmount: event.target.value })} placeholder="e.g. 25.00" />
        </Field>
        <Field label="Interest, % a year" hint="Simple interest on what's owing each day after the due date. Exempt from GST. Leave blank for none.">
          <input inputMode="decimal" value={form.interestRate} onChange={(event) => set({ interestRate: event.target.value })} placeholder="e.g. 12" />
        </Field>
        <Field label="Days of grace" hint="How many days late before anything's charged.">
          <input inputMode="numeric" value={form.graceDays} onChange={(event) => set({ graceDays: event.target.value })} />
        </Field>
        <Field label="Only when at least this is owing" hint="The fee and this amount are in your own currency. For an invoice in another currency, both are converted at the exchange rate for the charge date.">
          <input inputMode="decimal" value={form.minimumOverdue} onChange={(event) => set({ minimumOverdue: event.target.value })} />
        </Field>
        {accounts.data ? (
          <>
            <Field label="Fee goes to">
              <AccountSelect accounts={accounts.data.accounts} value={form.feeAccountCode} onChange={(code) => set({ feeAccountCode: code })} filter={(account) => account.accountType === "revenue"} />
            </Field>
            <Field label="Interest goes to">
              <AccountSelect
                accounts={accounts.data.accounts}
                value={form.interestAccountCode}
                onChange={(code) => set({ interestAccountCode: code })}
                filter={(account) => account.accountType === "other_income" || account.accountType === "revenue"}
              />
            </Field>
          </>
        ) : null}
        <label className={ui.checkbox}>
          <input type="checkbox" checked={form.approve} onChange={(event) => set({ approve: event.target.checked })} /> Approve the late payment invoices
          straight away (otherwise they&apos;re drafts to check)
        </label>
        <label className={ui.checkbox}>
          <input type="checkbox" checked={form.monthly} onChange={(event) => set({ monthly: event.target.checked })} /> Charge by itself on the 1st of each
          month
        </label>
        <p className={ui.muted}>
          {settings.enabled && settings.monthly
            ? `Next monthly run: ${formatDate(nextMonthlyRun(settings.lastMonthlyRun))}.`
            : "Turned on part way through a month, the first run is on the 1st of next month, not straight away."}
        </p>
      </fieldset>
      {canEdit ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          {settings.enabled ? (
            <>
              <Button disabled={busy} onClick={() => save(true)}>Save</Button>
              <Button variant="secondary" disabled={busy} onClick={() => save(false)}>Turn late fees off</Button>
            </>
          ) : (
            <Button disabled={busy} onClick={() => save(true)}>Turn late fees on</Button>
          )}
        </div>
      ) : (
        <p className={ui.muted}>Only an admin can change these.</p>
      )}
    </Card>
  );
}

/** LATE10, LATE13: the 1st of the month after the last month done (this month's 1st, so soon, when none is recorded). */
function nextMonthlyRun(lastMonthlyRun: string | null): string {
  if (!lastMonthlyRun) return `${todayInBrowser().slice(0, 7)}-01`;
  const year = Number(lastMonthlyRun.slice(0, 4));
  const month = Number(lastMonthlyRun.slice(5, 7));
  return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

function formOf(settings: LateFeeSettings) {
  return {
    feeAmount: settings.feeAmount ?? "",
    interestRate: settings.interestRate ?? "",
    graceDays: String(settings.graceDays),
    minimumOverdue: settings.minimumOverdue,
    feeAccountCode: settings.feeAccountCode ?? "",
    interestAccountCode: settings.interestAccountCode ?? "",
    approve: settings.approve,
    monthly: settings.monthly,
  };
}

function Exclusions({ organisationId, exclusions, canEdit, onChanged }: { organisationId: string; exclusions: LateFeeExclusion[]; canEdit: boolean; onChanged: () => void }) {
  const contacts = useApiData<{ contacts: Contact[] }>(canEdit ? "/api/contacts" : null, { organisationId });
  const [contactId, setContactId] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function change(id: string, excluded: boolean) {
    setError(null);
    try {
      await api("/api/late-fees/exclusions", { method: "POST", body: { organisationId, contactId: id, excluded } });
      setContactId("");
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const listed = new Set(exclusions.map((exclusion) => exclusion.contactId));
  const customers = (contacts.data?.contacts ?? []).filter((contact) => contact.isCustomer && !listed.has(contact.id));
  return (
    <Card title="Customers never charged">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {exclusions.length === 0 ? <p className={ui.muted}>None: every customer can be charged.</p> : null}
      {exclusions.map((exclusion) => (
        <div key={exclusion.contactId} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
          <span>{exclusion.name}</span>
          {canEdit ? (
            <Button variant="secondary" size="small" onClick={() => change(exclusion.contactId, false)}>
              Charge again
            </Button>
          ) : null}
        </div>
      ))}
      {canEdit ? (
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <select aria-label="Customer to never charge" value={contactId} onChange={(event) => setContactId(event.target.value)}>
            <option value="">Choose a customer</option>
            {customers.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
          <Button variant="secondary" disabled={!contactId} onClick={() => change(contactId, true)}>
            Never charge them
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
