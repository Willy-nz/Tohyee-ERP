"use client";

import { type FormEvent,useState } from "react";
import { DateInput } from "@/components/date-input";
import { Money,useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge,Button,Card,Empty,Field,Notice,ui } from "@/components/ui";
import { api,errorMessage,newIdempotencyKey } from "@/lib/client/api";
import { formatDate,formatMoney } from "@/lib/format";
import { ALLOCATION_STATUS_LABELS,ALLOCATION_STATUSES,type AllocationStatus } from "@/lib/tax/income/rules";
import type { BookPayments as BookPaymentsData } from "@/lib/tax/income/book-payments";
import { APPLIES_TO,APPLIES_TO_LABELS,type AppliesToKey,type TaxAllocation } from "@/lib/tax/income/allocation-kinds";
import type { IrdDocument } from "@/lib/tax/income/ird-documents";
import type { TaxPayment } from "@/lib/tax/income/service";
import { STATUS_TONES,Status } from "@/components/income-tax/shared";

function appliesToOptions(instalmentCount: number): AppliesToKey[] {
  return [...APPLIES_TO.filter((key) => key === "end_of_year" || Number(key.slice("instalment_".length)) <= instalmentCount)];
}

/** Where a payment goes and how sure that is (ITX6A-ITX6H). `replacing` reallocates an existing allocation. */
function AllocationForm({
  organisationId,
  payment,
  instalmentCount,
  documents,
  replacing,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  payment: TaxPayment;
  instalmentCount: number;
  documents: IrdDocument[];
  replacing: TaxAllocation | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    appliesTo: (replacing?.appliesTo ?? "instalment_1") as AppliesToKey,
    amount: replacing?.amount ?? payment.awaiting,
    status: (replacing?.status ?? "evidenced") as AllocationStatus,
    basis: "",
    irdDocumentId: "",
    reason: "",
  });
  const [key] = useState(() => newIdempotencyKey("tax-alloc"));
  const [status, setStatus] = useState<Status>(null);
  const set = <K extends keyof typeof form>(name: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [name]: value }));
  async function save(event: FormEvent) {
    event.preventDefault();
    const body = { organisationId, idempotencyKey: key, appliesTo: form.appliesTo, amount: form.amount, status: form.status, basis: form.basis, irdDocumentId: form.status === "confirmed" ? form.irdDocumentId : null };
    try {
      if (replacing) await api(`/api/income-tax/allocations/${replacing.id}/replace`, { method: "POST", body: { ...body, reason: form.reason } });
      else await api(`/api/income-tax/payments/${payment.id}/allocations`, { method: "POST", body });
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  const live = documents.filter((document) => !document.removed);
  return (
    <form className={ui.inlineForm} onSubmit={save} aria-label={replacing ? "Change where this goes" : "Allocate this payment"}>
      <Field label="Towards">
        <select value={form.appliesTo} onChange={(event) => set("appliesTo", event.target.value as AppliesToKey)}>
          {appliesToOptions(instalmentCount).map((value) => (
            <option key={value} value={value}>
              {APPLIES_TO_LABELS[value]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Amount">
        <input inputMode="decimal" value={form.amount} onChange={(event) => set("amount", event.target.value)} required />
      </Field>
      <Field label="How sure" hint="Only IRD's own record is confirmed. A forecast assumption is shown but not counted as paid.">
        <select value={form.status} onChange={(event) => set("status", event.target.value as AllocationStatus)}>
          {ALLOCATION_STATUSES.map((value) => (
            <option key={value} value={value}>
              {ALLOCATION_STATUS_LABELS[value]}
            </option>
          ))}
        </select>
      </Field>
      {form.status === "confirmed" ? (
        <Field label="IRD document" hint={live.length === 0 ? "Add IRD's statement or letter under IRD documents first." : undefined}>
          <select value={form.irdDocumentId} onChange={(event) => set("irdDocumentId", event.target.value)} required>
            <option value="">Choose…</option>
            {live.map((document) => (
              <option key={document.id} value={document.id}>
                {document.fileName}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field label={form.status === "forecast" ? "Assumption" : "Evidence"} hint={form.status === "forecast" ? "Why you expect it to go there." : "What shows it goes there, for example the reference it was paid with."}>
        <input value={form.basis} maxLength={300} onChange={(event) => set("basis", event.target.value)} required />
      </Field>
      {replacing ? (
        <Field label="Reason for the change">
          <input value={form.reason} maxLength={300} onChange={(event) => set("reason", event.target.value)} required />
        </Field>
      ) : null}
      <Button type="submit" variant="secondary">
        {replacing ? "Change" : "Allocate"}
      </Button>
      <Button type="button" variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </form>
  );
}

function PaymentRow({ organisationId, payment, instalmentCount, documents, onSaved, onRemove }: { organisationId: string; payment: TaxPayment; instalmentCount: number; documents: IrdDocument[]; onSaved: () => void; onRemove: () => void }) {
  const [editing, setEditing] = useState<"allocate" | "effective" | { replace: TaxAllocation } | { remove: TaxAllocation } | null>(null);
  const [effective, setEffective] = useState(payment.irdEffectiveOn ?? "");
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const done = () => {
    setEditing(null);
    setStatus(null);
    onSaved();
  };
  async function run(work: () => Promise<unknown>) {
    try {
      await work();
      done();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  const label = `the ${formatMoney(payment.amount)} payment on ${formatDate(payment.paidOn)}`;
  return (
    <>
      <tr>
        <td data-label="Payment">
          <strong>
            <Money value={payment.amount} />
          </strong>
          <div className={ui.muted}>Left the bank {formatDate(payment.paidOn)}</div>
          <div className={ui.muted}>{payment.irdEffectiveOn ? `IRD effective ${formatDate(payment.irdEffectiveOn)}` : "No IRD effective date yet"}</div>
          {payment.note ? <div className={ui.muted}>{payment.note}</div> : null}
        </td>
        <td data-label="Where it goes">
          {payment.reversed ? <Badge tone="red">Reversed in the books: not counted</Badge> : null}
          {payment.allocations.map((allocation) => (
            <div key={allocation.id}>
              {APPLIES_TO_LABELS[allocation.appliesTo]} · <Money value={allocation.amount} /> <Badge tone={STATUS_TONES[allocation.status]}>{ALLOCATION_STATUS_LABELS[allocation.status]}</Badge>
              <div className={ui.muted}>
                {allocation.basis}
                {allocation.irdDocumentName ? ` · ${allocation.irdDocumentName}` : ""}
              </div>
              {!payment.reversed ? (
                <div>
                  <button type="button" className={ui.linkButton} onClick={() => setEditing({ replace: allocation })} aria-label={`Change where ${formatMoney(allocation.amount)} of ${label} goes`}>
                    Change
                  </button>{" "}
                  <button type="button" className={ui.linkButton} onClick={() => setEditing({ remove: allocation })} aria-label={`Take off the ${formatMoney(allocation.amount)} allocation of ${label}`}>
                    Take off
                  </button>
                </div>
              ) : null}
            </div>
          ))}
          {!payment.reversed && payment.awaiting !== "0.00" ? <Badge tone="amber">{`Awaiting reconciliation: ${formatMoney(payment.awaiting)}`}</Badge> : null}
          {payment.replacedAllocations.length > 0 ? (
            <details>
              <summary>Earlier allocations ({payment.replacedAllocations.length})</summary>
              <ul>
                {payment.replacedAllocations.map((allocation) => (
                  <li key={allocation.id} className={ui.muted}>
                    {APPLIES_TO_LABELS[allocation.appliesTo]} · {formatMoney(allocation.amount)} · {ALLOCATION_STATUS_LABELS[allocation.status]}
                    {allocation.replaced ? ` · changed ${formatDate(allocation.replaced.at.slice(0, 10))}: ${allocation.replaced.reason}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </td>
        <td data-label="Actions">
          {!payment.reversed && payment.awaiting !== "0.00" ? (
            <div>
              <button type="button" className={ui.linkButton} onClick={() => setEditing("allocate")} aria-label={`Allocate ${label}`}>
                Allocate
              </button>
            </div>
          ) : null}
          {!payment.reversed ? (
            <div>
              <button type="button" className={ui.linkButton} onClick={() => setEditing("effective")} aria-label={`IRD effective date for ${label}`}>
                {payment.irdEffectiveOn ? "Change IRD date" : "Add IRD date"}
              </button>
            </div>
          ) : null}
          <div>
            <button type="button" className={ui.linkButton} onClick={onRemove} aria-label={`Remove ${label}`}>
              Remove
            </button>
          </div>
        </td>
      </tr>
      {editing !== null || status ? (
        <tr>
          <td colSpan={3}>
            {editing === "allocate" ? <AllocationForm organisationId={organisationId} payment={payment} instalmentCount={instalmentCount} documents={documents} replacing={null} onSaved={done} onCancel={() => setEditing(null)} /> : null}
            {editing !== null && typeof editing === "object" && "replace" in editing ? (
              <AllocationForm organisationId={organisationId} payment={payment} instalmentCount={instalmentCount} documents={documents} replacing={editing.replace} onSaved={done} onCancel={() => setEditing(null)} />
            ) : null}
            {editing !== null && typeof editing === "object" && "remove" in editing ? (
              <form
                className={ui.inlineForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(() => api(`/api/income-tax/allocations/${editing.remove.id}/remove`, { method: "POST", body: { organisationId, reason } }));
                }}
              >
                <Field label="Reason for taking it off">
                  <input value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} required />
                </Field>
                <Button type="submit" variant="secondary">
                  Take off
                </Button>
                <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </form>
            ) : null}
            {editing === "effective" ? (
              <form
                className={ui.inlineForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(() => api(`/api/income-tax/payments/${payment.id}`, { method: "PATCH", body: { organisationId, irdEffectiveOn: effective } }));
                }}
              >
                <Field label="IRD effective date" hint="From IRD's statement. Leave blank to use the bank date.">
                  <DateInput value={effective} onChange={(event) => setEffective(event.target.value)} />
                </Field>
                <Button type="submit" variant="secondary">
                  Save date
                </Button>
                <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </form>
            ) : null}
            {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function Payments({ organisationId, incomeYear, payments, total, instalmentCount, onSaved }: { organisationId: string; incomeYear: number; payments: TaxPayment[]; total: string; instalmentCount: number; onSaved: () => void }) {
  const empty = { paidOn: "", irdEffectiveOn: "", amount: "", note: "", appliesTo: "" as AppliesToKey | "", status: "evidenced" as AllocationStatus, basis: "", irdDocumentId: "" };
  const [form, setForm] = useState(empty);
  const [key, setKey] = useState(() => newIdempotencyKey("tax-pay"));
  const [status, setStatus] = useState<Status>(null);
  const documents = useApiData<{ documents: IrdDocument[] }>("/api/income-tax/documents", { organisationId });
  const docs = documents.data?.documents ?? [];
  const set = <K extends keyof typeof form>(name: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [name]: value }));
  async function add(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/income-tax/payments", {
        method: "POST",
        body: {
          organisationId,
          idempotencyKey: key,
          incomeYear,
          paidOn: form.paidOn,
          irdEffectiveOn: form.irdEffectiveOn,
          amount: form.amount,
          note: form.note,
          allocation: form.appliesTo ? { appliesTo: form.appliesTo, status: form.status, basis: form.basis, irdDocumentId: form.status === "confirmed" ? form.irdDocumentId : null } : null,
        },
      });
      setForm(empty);
      setKey(newIdempotencyKey("tax-pay"));
      setStatus(null);
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  async function remove(id: string) {
    try {
      await api(`/api/income-tax/payments/${id}`, { method: "DELETE", query: { organisationId } });
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  const live = docs.filter((document) => !document.removed);
  return (
    <>
      <h3>Payments to IRD towards the {incomeYear} income year</h3>
      <p className={ui.muted}>
        A payment counts against an instalment only once it&apos;s allocated: confirmed by IRD, or by you with the evidence. Until then it&apos;s awaiting reconciliation, whatever its date.
      </p>
      {payments.length === 0 ? (
        <Empty>None typed yet.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Payment</th>
                <th>Where it goes</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <PaymentRow key={payment.id} organisationId={organisationId} payment={payment} instalmentCount={instalmentCount} documents={docs} onSaved={onSaved} onRemove={() => void remove(payment.id)} />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>
                  <strong>
                    Total <Money value={total} />
                  </strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <form className={ui.inlineForm} onSubmit={add}>
        <Field label="Left the bank on">
          <DateInput value={form.paidOn} onChange={(event) => set("paidOn", event.target.value)} required />
        </Field>
        <Field label="IRD effective date" hint="If you know it.">
          <DateInput value={form.irdEffectiveOn} onChange={(event) => set("irdEffectiveOn", event.target.value)} />
        </Field>
        <Field label="Amount">
          <input inputMode="decimal" value={form.amount} onChange={(event) => set("amount", event.target.value)} required />
        </Field>
        <Field label="Note">
          <input value={form.note} maxLength={200} onChange={(event) => set("note", event.target.value)} />
        </Field>
        <Field label="Towards">
          <select value={form.appliesTo} onChange={(event) => set("appliesTo", event.target.value as AppliesToKey | "")}>
            <option value="">Not allocated yet</option>
            {appliesToOptions(instalmentCount).map((value) => (
              <option key={value} value={value}>
                {APPLIES_TO_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        {form.appliesTo ? (
          <>
            <Field label="How sure">
              <select value={form.status} onChange={(event) => set("status", event.target.value as AllocationStatus)}>
                {ALLOCATION_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {ALLOCATION_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            </Field>
            {form.status === "confirmed" ? (
              <Field label="IRD document">
                <select value={form.irdDocumentId} onChange={(event) => set("irdDocumentId", event.target.value)} required>
                  <option value="">Choose…</option>
                  {live.map((document) => (
                    <option key={document.id} value={document.id}>
                      {document.fileName}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label={form.status === "forecast" ? "Assumption" : "Evidence"}>
              <input value={form.basis} maxLength={300} onChange={(event) => set("basis", event.target.value)} required />
            </Field>
          </>
        ) : null}
        <Button type="submit" variant="secondary">
          Add payment
        </Button>
      </form>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </>
  );
}

export function BookPayments({ organisationId, years, onChanged }: { organisationId: string; years: number[]; onChanged: () => void }) {
  const loaded = useApiData<BookPaymentsData>("/api/income-tax/book-payments", { organisationId });
  const accounts = useAccounts(organisationId);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [yearFor, setYearFor] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>(null);
  const data = loaded.data;
  const selected = chosen ?? data?.accounts.map((account) => account.accountId) ?? [];
  const balanceSheet = (accounts.data?.accounts ?? []).filter((account) => ["asset", "liability", "equity"].includes(account.accountClass) && account.isActive);
  async function saveAccounts() {
    try {
      await api("/api/income-tax/book-payments/accounts", { method: "PUT", body: { organisationId, accountIds: selected } });
      setChosen(null);
      setStatus(null);
      loaded.reload();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  async function count(journalLineId: string, incomeYear: string) {
    try {
      await api("/api/income-tax/book-payments/count", { method: "POST", body: { organisationId, journalLineId, incomeYear: Number(incomeYear) } });
      setStatus(null);
      loaded.reload();
      onChanged();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  return (
    <Card title="Payments to IRD in the books" description="Choose the accounts you code income tax payments to. Payments to them from a bank or credit card show here to count towards an income year, so you don't type them twice.">
      <Field label="Income tax payments are coded to" hint="Hold Ctrl (or Cmd) to choose more than one.">
        <select multiple size={Math.min(6, Math.max(3, balanceSheet.length))} value={selected} onChange={(event) => setChosen(Array.from(event.target.selectedOptions, (option) => option.value))}>
          {balanceSheet.map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} {account.name}
            </option>
          ))}
        </select>
      </Field>
      {chosen !== null ? (
        <Button size="small" variant="secondary" onClick={() => void saveAccounts()}>
          Save accounts
        </Button>
      ) : null}
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {!data ? (
        <p className={ui.muted}>Loading…</p>
      ) : data.accounts.length === 0 ? (
        <Empty>Choose an account to see payments to IRD from the books.</Empty>
      ) : data.payments.length === 0 ? (
        <Empty>Every payment to IRD in the books is counted.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Reference</th>
                <th className={ui.num}>Amount</th>
                <th>Towards</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.payments.map((line) => {
                const year = yearFor[line.journalLineId] ?? String(line.typedMatch?.incomeYear ?? line.suggestedIncomeYear ?? "");
                return (
                  <tr key={line.journalLineId}>
                    <td data-label="Date">{formatDate(line.date)}</td>
                    <td data-label="Reference">
                      {line.reference}
                      {line.description ? <span className={ui.muted}> · {line.description}</span> : null}
                      <span className={ui.muted}> · {line.account}</span>
                      {line.typedMatch ? <div className={ui.muted}>Matches a payment typed for {line.typedMatch.incomeYear}: counting links them.</div> : null}
                    </td>
                    <td data-label="Amount" className={ui.num}>
                      <Money value={line.amount} />
                    </td>
                    <td data-label="Towards">
                      <select aria-label={`Income year for the payment on ${line.date}`} value={year} onChange={(event) => setYearFor((current) => ({ ...current, [line.journalLineId]: event.target.value }))}>
                        <option value="">Choose…</option>
                        {years.map((value) => (
                          <option key={value} value={value}>
                            {value} income year{line.suggestedIncomeYear === value ? " (suggested)" : ""}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <Button size="small" variant="secondary" disabled={!year} onClick={() => void count(line.journalLineId, year)}>
                        Count it
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.refunds.length > 0 ? (
        <>
          <h3>Money in on those accounts</h3>
          <p className={ui.muted}>Possible refunds from IRD. They aren&apos;t counted as payments; a company types a refund into its imputation credit account.</p>
          <ul>
            {data.refunds.map((line) => (
              <li key={line.journalLineId}>
                {formatDate(line.date)} · {line.reference} · <Money value={line.amount} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
