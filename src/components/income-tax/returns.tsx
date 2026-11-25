"use client";

import { type FormEvent,useState } from "react";
import { DateInput } from "@/components/date-input";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge,Button,Card,Field,Notice,ui } from "@/components/ui";
import { api,errorMessage,newIdempotencyKey } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import type { Ir10,Ir10Account } from "@/lib/tax/income/ir10";
import type { Ica } from "@/lib/tax/income/ica";
import { ICA_KIND_LABELS,ICA_KINDS,type IcaKind } from "@/lib/tax/income/ica-kinds";
import { IR10_BOX_LABELS,IR10_ROLE_LABELS } from "@/lib/tax/income/ir10-boxes";
import { Status,Supported } from "@/components/income-tax/shared";

function downloadIr10(incomeYear: number, ir10: Ir10) {
  const rows = [["Box", "Label", "Amount"], ...Object.keys(ir10.labels).map((key) => [key, ir10.labels[Number(key)], ir10.boxes[Number(key)] ?? ""])];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `IR10-${incomeYear}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

const IR10_SECTIONS: Array<{ title: string; from: number; to: number }> = [
  { title: "Profit and loss", from: 1, to: 29 },
  { title: "Balance sheet", from: 30, to: 51 },
  { title: "Other information", from: 52, to: 60 },
];
const IR10_TOTALS = new Set([6, 11, 25, 27, 29, 43, 48, 50, 51]);

function Ir10Accounts({ organisationId, onSaved }: { organisationId: string; onSaved: () => void }) {
  const loaded = useApiData<{ accounts: Ir10Account[] }>("/api/income-tax/ir10", { organisationId });
  const [error, setError] = useState<string | null>(null);
  async function save(account: Ir10Account, box: number, role: string) {
    try {
      setError(null);
      await api("/api/income-tax/ir10", { method: "PUT", body: { organisationId, accountId: account.accountId, box, role: role || null } });
      loaded.reload();
      onSaved();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Account</th>
              <th>IR10 box</th>
              <th>Also</th>
            </tr>
          </thead>
          <tbody>
            {loaded.data.accounts
              .filter((account) => account.isActive || account.isSet)
              .map((account) => (
                <tr key={account.accountId}>
                  <td data-label="Account">
                    {account.code} {account.name} {account.isSet ? null : <span className={ui.muted}>(default)</span>}
                  </td>
                  <td data-label="IR10 box">
                    {account.allowedBoxes.length === 1 ? (
                      `${account.box} ${IR10_BOX_LABELS[account.box]}`
                    ) : (
                      <select aria-label={`IR10 box for ${account.code}`} value={account.box} onChange={(event) => void save(account, Number(event.target.value), account.role ?? "")}>
                        {account.allowedBoxes.map((number) => (
                          <option key={number} value={number}>
                            {number} {IR10_BOX_LABELS[number]}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td data-label="Also">
                    {account.allowedRoles.length > 0 ? (
                      <select aria-label={`IR10 role for ${account.code}`} value={account.role ?? ""} onChange={(event) => void save(account, account.box, event.target.value)}>
                        <option value="">Nothing else</option>
                        {account.allowedRoles.map((role) => (
                          <option key={role} value={role}>
                            {IR10_ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function Ir10Card({ organisationId, report, ir10, onSaved }: { organisationId: string; report: Supported; ir10: Ir10; onSaved: () => void }) {
  const [showAccounts, setShowAccounts] = useState(false);
  return (
    <Card
      title="IR10 financial statements summary"
      description={`The ${report.incomeYear} income year's IR10 from the books, to copy into myIR or attach to the return. Tohyee doesn't file it.`}
      actions={
        <Button variant="secondary" size="small" onClick={() => downloadIr10(report.incomeYear, ir10)}>
          Download CSV
        </Button>
      }
    >
      {ir10.checks.map((check) => (
        <Notice key={check.label} tone={check.ok ? "success" : "error"}>
          {check.ok ? "✓" : "✗"} {check.label}. {check.detail}.
        </Notice>
      ))}
      {IR10_SECTIONS.map((section) => (
        <div key={section.title}>
          <h3>{section.title}</h3>
          <div className={ui.tableWrap}>
          <table className={ui.reportTable}>
            <tbody>
              {Array.from({ length: section.to - section.from + 1 }, (_, index) => section.from + index).map((number) => (
                <tr key={number} className={IR10_TOTALS.has(number) ? ui.reportTotal : undefined}>
                  <td>
                    <span className={ui.muted}>{number}</span> {ir10.labels[number]}
                  </td>
                  <td className={ui.num}>{number === 1 ? ir10.boxes[1] : ir10.boxes[number] === null ? <span className={ui.muted}>blank</span> : <Money value={ir10.boxes[number]} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      ))}
      <ul className={ui.muted}>
        {ir10.notes.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      <button type="button" className={ui.linkButton} onClick={() => setShowAccounts((value) => !value)}>
        {showAccounts ? "Hide which box each account goes in" : "Change which box each account goes in"}
      </button>
      {showAccounts ? <Ir10Accounts organisationId={organisationId} onSaved={onSaved} /> : null}
    </Card>
  );
}

type TaxReturnBoxes = { boxes: Record<string, string>; residual: "credit" | "debit"; outcome: "refund" | "tax_to_pay"; nextYear: { incomeYear: number; option: "S"; amount: string } | null; notes: string[] };

export function TaxReturnCard({ title, source, order, labels, result, residualBox, outcomeBox, provisionalBox }: { title: string; source: string; order: readonly string[]; labels: Record<string, string>; result: TaxReturnBoxes; residualBox: string; outcomeBox: string; provisionalBox: string }) {
  return (
    <Card title={title}>
      <Notice tone="warning">From {source}, read by Claude and not yet reviewed by an accountant. Check every box before filing.</Notice>
      <div className={ui.tableWrap}>
      <table className={ui.reportTable}>
        <tbody>
          {order.map((box) => (
            <tr key={box}>
              <td>
                {box === "other" || /^W\d/.test(box) ? null : <span className={ui.muted}>{box}</span>} {labels[box]}
                {box === residualBox ? <> ({result.residual})</> : null}
                {box === outcomeBox ? <> ({result.outcome === "refund" ? "refund" : "tax to pay"})</> : null}
              </td>
              <td className={ui.num}>
                <Money value={result.boxes[box]} />
              </td>
            </tr>
          ))}
          <tr>
            <td>
              <span className={ui.muted}>{provisionalBox}A, {provisionalBox}B</span>{" "}
              {result.nextYear ? `${result.nextYear.incomeYear} provisional tax, standard option (S): RIT plus 5%` : "Next year's provisional tax: none required (RIT 5,000.00 or less)"}
            </td>
            <td className={ui.num}>{result.nextYear ? <Money value={result.nextYear.amount} /> : null}</td>
          </tr>
        </tbody>
      </table>
      </div>
      <ul>
        {result.notes.map((note) => (
          <li key={note} className={ui.muted}>
            {note}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function IcaCard({ organisationId, ica, onSaved }: { organisationId: string; ica: Ica; onSaved: () => void }) {
  const [form, setForm] = useState({ entryDate: "", kind: "dividend_paid" as IcaKind, amount: "", dividendAmount: "", description: "" });
  const [key, setKey] = useState(() => newIdempotencyKey("ica"));
  const [status, setStatus] = useState<Status>(null);
  async function add(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/income-tax/ica", { method: "POST", body: { organisationId, idempotencyKey: key, ...form, dividendAmount: form.kind === "dividend_paid" ? form.dividendAmount : undefined } });
      setForm((current) => ({ ...current, amount: "", dividendAmount: "", description: "" }));
      setKey(newIdempotencyKey("ica"));
      setStatus(null);
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  async function remove(id: string) {
    try {
      await api(`/api/income-tax/ica/${id}`, { method: "DELETE", query: { organisationId } });
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  return (
    <Card
      title="Imputation credit account"
      description={`The ${ica.icaYear} ICA year, ${formatDate(ica.start)} to ${formatDate(ica.end)}. Income tax paid comes from the payments typed below; type dividends, refunds and other entries here. Credits are positive, debits negative.`}
    >
      {ica.debitBalance ? (
        <Notice tone="error">
          Debit balance at 31 March: further income tax <Money value={ica.debitBalance.furtherIncomeTax} /> and imputation penalty tax <Money value={ica.debitBalance.penalty} /> are due{" "}
          {formatDate(ica.debitBalance.dueDate)}
          {ica.debitBalance.onTimeBy.date !== ica.debitBalance.dueDate ? ` (on time by ${formatDate(ica.debitBalance.onTimeBy.date)})` : ""}.
        </Notice>
      ) : null}
      <div className={ui.tableWrap}>
      <table className={ui.reportTable}>
        <tbody>
          <tr>
            <td>Balance at {formatDate(ica.start)}</td>
            <td />
            <td className={ui.num}>
              <Money value={ica.opening} />
            </td>
          </tr>
          {ica.rows.map((row, index) => (
            <tr key={`${row.kind}-${row.id ?? index}`}>
              <td>
                {formatDate(row.date)} · {row.label}
                {row.dividendAmount ? (
                  <>
                    {" "}
                    on <Money value={row.dividendAmount} />
                  </>
                ) : null}
                {row.description ? <span className={ui.muted}> · {row.description}</span> : null} {row.ratioDiffers ? <Badge tone="amber">Different ratio</Badge> : null}{" "}
                {row.id !== null && row.kind !== "tax_paid" ? (
                  <button type="button" className={ui.linkButton} onClick={() => void remove(row.id!)}>
                    Remove
                  </button>
                ) : null}
              </td>
              <td className={ui.num}>
                <Money value={row.amount} />
              </td>
              <td className={ui.num}>
                <Money value={row.balance} />
              </td>
            </tr>
          ))}
          <tr className={ui.reportTotal}>
            <td>Balance at {formatDate(ica.end)}</td>
            <td />
            <td className={ui.num}>
              <Money value={ica.closing} />
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      <details>
        <summary>IR4 annual imputation return (page 7) boxes</summary>
        <div className={ui.tableWrap}>
        <table className={ui.reportTable}>
          <tbody>
            {(
              [
                ["41", `Opening balance (tick ${ica.ir4Sides["41"]})`],
                ["42A", "Income tax and provisional tax paid"],
                ["42B", "RWT on interest received"],
                ["42C", "Imputation credits on dividends received"],
                ["42D", "Other credits"],
                ["42E", "Total credits"],
                ["43A", "Income tax refunded"],
                ["43B", "Imputation credits on dividends paid"],
                ["43C", "Other debits"],
                ["43D", "Total debits"],
                ["44", `Closing balance at 31 March (tick ${ica.ir4Sides["44"]})`],
                ["44B", "Further income tax payable (only for a debit balance; 44A not worked out)"],
                ["45", "Imputation penalty tax"],
              ] as Array<[keyof typeof ica.ir4, string]>
            ).map(([box, label]) => (
              <tr key={box}>
                <td>
                  <span className={ui.muted}>{box}</span> {label}
                </td>
                <td className={ui.num}>
                  <Money value={ica.ir4[box]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </details>
      <form className={ui.inlineForm} onSubmit={add}>
        <Field label="Date">
          <DateInput value={form.entryDate} onChange={(event) => setForm((current) => ({ ...current, entryDate: event.target.value }))} required />
        </Field>
        <Field label="Entry">
          <select value={form.kind} onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value as IcaKind }))}>
            {ICA_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {ICA_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </Field>
        {form.kind === "dividend_paid" ? (
          <Field label="Cash dividend">
            <input inputMode="decimal" value={form.dividendAmount} onChange={(event) => setForm((current) => ({ ...current, dividendAmount: event.target.value }))} required />
          </Field>
        ) : null}
        <Field label={form.kind === "dividend_paid" ? "Credits attached" : form.kind === "opening" ? "Balance (debit negative)" : "Amount"} hint={form.kind === "dividend_paid" ? "Blank for the most allowed: 28/72 of the dividend." : undefined}>
          <input inputMode="decimal" value={form.amount} onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))} required={form.kind !== "dividend_paid"} />
        </Field>
        <Field label="Note">
          <input value={form.description} maxLength={200} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} />
        </Field>
        <Button type="submit" variant="secondary">
          Add entry
        </Button>
      </form>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      <ul className={ui.muted}>
        {ica.notes.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </Card>
  );
}
