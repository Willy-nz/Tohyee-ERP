"use client";

import { InfoTip } from "@/components/info-tip";
import { DateInput } from "@/components/date-input";
import Link from "next/link";
import { useState } from "react";
import { AccountSelect,Money,useAccounts } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge,Button,Card,Empty,Field,Notice,ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api,errorMessage,newIdempotencyKey } from "@/lib/client/api";
import { formatDate,todayInBrowser } from "@/lib/format";
import { classesOf,KIND_NAMES,LIVESTOCK_KINDS,type LivestockKind } from "@/lib/livestock/classes";
import type { AccountSale } from "@/lib/livestock/account-sales";
import { ContactOption,NotOn,Steps,useLivestockSettings } from "@/components/livestock/shared";

export function LivestockAccountSales({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const confirm = useConfirm();
  const settings = useLivestockSettings(organisationId);
  const sales = useApiData<{ accountSales: AccountSale[] }>("/api/livestock/account-sales", { organisationId });
  const contacts = useApiData<{ contacts: ContactOption[] }>("/api/contacts", { organisationId });
  const [form, setForm] = useState({ contactId: "", reference: "", saleDate: todayInBrowser(), dueDate: "" });
  const [lines, setLines] = useState([{ kind: "dairy_cattle" as LivestockKind, classCode: "ma_cows", head: "", amount: "" }]);
  const [deductions, setDeductions] = useState([
    { description: "Commission", accountCode: "", amount: "" },
    { description: "Freight", accountCode: "", amount: "" },
  ]);
  const accounts = useAccounts(organisationId);
  const [key, setKey] = useState(() => newIdempotencyKey("as"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (settings.error) return <Notice tone="error">{settings.error}</Notice>;
  if (!settings.data) return <p className={ui.muted}>Loading…</p>;
  if (!settings.data.settings.enabled) return <NotOn canSetUp={can("admin")} />;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ accountSale: AccountSale }>("/api/livestock/account-sales", {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: key,
          contactId: form.contactId,
          reference: form.reference,
          saleDate: form.saleDate,
          dueDate: form.dueDate || null,
          lines: lines.filter((line) => line.head.trim() !== ""),
          deductions: deductions.filter((line) => line.amount.trim() !== ""),
        },
      });
      setMessage(`Account sale ${result.accountSale.reference} entered: ${result.accountSale.contactName} owes ${result.accountSale.net}.`);
      setKey(newIdempotencyKey("as"));
      setForm({ ...form, reference: "" });
      setLines([{ kind: "dairy_cattle", classCode: "ma_cows", head: "", amount: "" }]);
      sales.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function voidOne(sale: AccountSale) {
    if (!(await confirm(`Void account sale ${sale.reference}? Its invoice, deductions bill, contra and movements are all reversed.`, { confirmLabel: "Void", danger: true }))) return;
    try {
      await api(`/api/livestock/account-sales/${sale.id}/void`, { method: "POST", body: { organisationId, reason: "Voided in Livestock › Account sales" } });
      sales.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <>
      <Steps current="account-sales" />
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {can("bookkeeper") ? (
        <Card
          title="Enter an account sale"
          description={<>The agent&apos;s account sale is your tax invoice.{" "}<InfoTip label="Account sales">Its stock lines become an invoice to the agent and sale movements; its deductions a bill from the agent, settled against the invoice. The agent then owes the net. Amounts exclude GST.</InfoTip></>}
        >
          <div className={ui.grid}>
            <Field label="Agent">
              <select value={form.contactId} onChange={(event) => setForm({ ...form, contactId: event.target.value })}>
                <option value="">Choose…</option>
                {(contacts.data?.contacts ?? []).map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Account sale number">
              <input value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} />
            </Field>
            <Field label="Sale date">
              <DateInput value={form.saleDate} onChange={(event) => setForm({ ...form, saleDate: event.target.value })} />
            </Field>
            <Field label="Agent pays by" hint="Blank: the sale date">
              <DateInput value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} />
            </Field>
          </div>
          <h3>Stock sold</h3>
          {lines.map((line, index) => (
            <div key={index} className={ui.inlineForm}>
              <Field label="Livestock">
                <select
                  value={line.kind}
                  onChange={(event) => {
                    const kind = event.target.value as LivestockKind;
                    setLines(lines.map((entry, at) => (at === index ? { ...entry, kind, classCode: classesOf(kind)[0].code } : entry)));
                  }}
                >
                  {LIVESTOCK_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_NAMES[kind]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Class">
                <select value={line.classCode} onChange={(event) => setLines(lines.map((entry, at) => (at === index ? { ...entry, classCode: event.target.value } : entry)))}>
                  {classesOf(line.kind).map((entry) => (
                    <option key={entry.code} value={entry.code}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Head">
                <input inputMode="numeric" size={6} value={line.head} onChange={(event) => setLines(lines.map((entry, at) => (at === index ? { ...entry, head: event.target.value } : entry)))} />
              </Field>
              <Field label="Amount excl. GST">
                <input inputMode="decimal" size={10} value={line.amount} onChange={(event) => setLines(lines.map((entry, at) => (at === index ? { ...entry, amount: event.target.value } : entry)))} />
              </Field>
            </div>
          ))}
          <Button variant="secondary" size="small" onClick={() => setLines([...lines, { kind: lines[lines.length - 1].kind, classCode: lines[lines.length - 1].classCode, head: "", amount: "" }])}>
            Add a line
          </Button>
          <h3>Deductions</h3>
          {deductions.map((line, index) => (
            <div key={index} className={ui.inlineForm}>
              <Field label="Description">
                <input value={line.description} onChange={(event) => setDeductions(deductions.map((entry, at) => (at === index ? { ...entry, description: event.target.value } : entry)))} />
              </Field>
              <Field label="Account">
                {accounts.data ? (
                  <AccountSelect
                    accounts={accounts.data.accounts}
                    value={line.accountCode}
                    filter={(account) => account.accountClass === "expense"}
                    onChange={(code) => setDeductions(deductions.map((entry, at) => (at === index ? { ...entry, accountCode: code } : entry)))}
                  />
                ) : (
                  <span />
                )}
              </Field>
              <Field label="Amount excl. GST">
                <input inputMode="decimal" size={10} value={line.amount} onChange={(event) => setDeductions(deductions.map((entry, at) => (at === index ? { ...entry, amount: event.target.value } : entry)))} />
              </Field>
            </div>
          ))}
          <Button variant="secondary" size="small" onClick={() => setDeductions([...deductions, { description: "", accountCode: "", amount: "" }])}>
            Add a deduction
          </Button>
          <div className={ui.actions}>
            <Button disabled={busy || !form.contactId || !form.reference.trim()} onClick={() => void save()}>
              Enter account sale
            </Button>
          </div>
        </Card>
      ) : null}
      <Card title="Account sales" description="Each is entered once per agent and number. The net is on the agent's invoice until it pays.">
        {sales.data && sales.data.accountSales.length === 0 ? <Empty>No account sales yet.</Empty> : null}
        {sales.data && sales.data.accountSales.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Agent</th>
                  <th>Number</th>
                  <th className={ui.num}>Sales incl. GST</th>
                  <th className={ui.num}>Deductions</th>
                  <th className={ui.num}>Net</th>
                  <th className={ui.num}>Still owed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sales.data.accountSales.map((sale) => (
                  <tr key={sale.id}>
                    <td data-label="Date">{formatDate(sale.saleDate)}</td>
                    <td data-label="Agent">{sale.contactName}</td>
                    <td data-label="Number">
                      <Link href={`/operations/invoices/${sale.invoiceId}`}>{sale.reference}</Link> {sale.status === "voided" ? <Badge tone="red">Voided</Badge> : null}
                    </td>
                    <td data-label="Sales" className={ui.num}>
                      <Money value={sale.gross} />
                    </td>
                    <td data-label="Deductions" className={ui.num}>
                      <Money value={sale.deductions} />
                    </td>
                    <td data-label="Net" className={ui.num}>
                      <Money value={sale.net} />
                    </td>
                    <td data-label="Still owed" className={ui.num}>
                      <Money value={sale.status === "voided" ? "0" : sale.amountDue} />
                    </td>
                    <td>
                      {can("bookkeeper") && sale.status === "active" ? (
                        <Button variant="secondary" size="small" onClick={() => void voidOne(sale)}>
                          Void
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </>
  );
}
