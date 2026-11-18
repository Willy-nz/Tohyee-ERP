"use client";

import { type ChangeEvent, useState } from "react";
import { readFileAsBase64 } from "@/components/bank/common";
import { useApiData } from "@/components/hooks";
import { Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { EmployeeImportField, EmployeeImportResult } from "@/lib/payroll/employee-import";

type Defaults = { taxCode: string; kiwiSaverStatus: string; kiwiSaverEmployeeRate: string; kiwiSaverEmployerRate: string; studentLoan: string; payFrequency: string };
const NO_DEFAULTS: Defaults = { taxCode: "", kiwiSaverStatus: "", kiwiSaverEmployeeRate: "", kiwiSaverEmployerRate: "", studentLoan: "", payFrequency: "" };

/**
 * Bring employees in from a CSV or Excel file (EMI1-EMI8): an HR system's
 * export, such as BambooHR's, or a typed-up spreadsheet. Check the columns,
 * give what the file hasn't got, preview, then bring them in.
 */
export function PayrollEmployeeImport({ organisationId, onImported }: { organisationId: string; onImported: () => void }) {
  const fields = useApiData<{ fields: Array<{ key: EmployeeImportField; label: string }> }>("/api/payroll/employees/import", {});
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<EmployeeImportField, number | null>> | null>(null);
  const [defaults, setDefaults] = useState<Defaults>(NO_DEFAULTS);
  const [dateOrder, setDateOrder] = useState<"dmy" | "mdy" | "ymd">("dmy");
  const [result, setResult] = useState<EmployeeImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (commit: boolean, chosen = file, chosenMapping = mapping) => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await api<EmployeeImportResult>("/api/payroll/employees/import", {
        method: "POST",
        body: {
          organisationId,
          fileName: chosen.name,
          fileBase64: chosen.base64,
          mapping: chosenMapping ?? undefined,
          defaults,
          dateOrder,
          commit,
          ...(commit ? { idempotencyKey: newIdempotencyKey("employee-import") } : {}),
        },
      });
      setResult(answer);
      setMapping(answer.mapping);
      if (answer.committed) onImported();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    if (!picked) return;
    const next = { name: picked.name, base64: await readFileAsBase64(picked) };
    setFile(next);
    setMapping(null);
    setResult(null);
    await send(false, next, null);
  };

  const setDefault = (key: keyof Defaults, value: string) => setDefaults((current) => ({ ...current, [key]: value }));

  return (
    <Card title="Bring in employees from a file" description="A CSV or Excel export from your HR system (BambooHR, for example), or a spreadsheet. Nothing is saved until you bring them in.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="File">
        <input type="file" accept=".csv,.xlsx,.txt" disabled={busy} onChange={(event) => void choose(event)} />
      </Field>
      {result && mapping ? (
        <>
          <h3>Columns</h3>
          <div className={ui.grid}>
            {(fields.data?.fields ?? []).map((field) => (
              <Field key={field.key} label={field.label}>
                <select
                  value={mapping[field.key] ?? ""}
                  onChange={(event) => setMapping({ ...mapping, [field.key]: event.target.value === "" ? null : Number(event.target.value) })}
                >
                  <option value="">Not in the file</option>
                  {result.headings.map((heading, index) => (
                    <option key={`${heading}-${index}`} value={index}>{heading || `Column ${index + 1}`}</option>
                  ))}
                </select>
              </Field>
            ))}
            <Field label="Dates are written">
              <select value={dateOrder} onChange={(event) => setDateOrder(event.target.value as "dmy" | "mdy" | "ymd")}>
                <option value="dmy">Day first (31/03/2026)</option>
                <option value="mdy">Month first (03/31/2026)</option>
                <option value="ymd">Year first (2026-03-31)</option>
              </select>
            </Field>
          </div>
          <h3>For everyone without one in the file</h3>
          <div className={ui.grid}>
            <Field label="Tax code">
              <input value={defaults.taxCode} maxLength={20} placeholder="M" onChange={(event) => setDefault("taxCode", event.target.value)} />
            </Field>
            <Field label="KiwiSaver">
              <select value={defaults.kiwiSaverStatus} onChange={(event) => setDefault("kiwiSaverStatus", event.target.value)}>
                <option value="">Not chosen</option>
                <option value="enrolled">Enrolled</option>
                <option value="not_enrolled">Not enrolled</option>
                <option value="opted_out">Opted out</option>
              </select>
            </Field>
            <Field label="KiwiSaver employee rate %">
              <input inputMode="decimal" value={defaults.kiwiSaverEmployeeRate} onChange={(event) => setDefault("kiwiSaverEmployeeRate", event.target.value)} />
            </Field>
            <Field label="KiwiSaver employer rate %">
              <input inputMode="decimal" value={defaults.kiwiSaverEmployerRate} onChange={(event) => setDefault("kiwiSaverEmployerRate", event.target.value)} />
            </Field>
            <Field label="Student loan">
              <select value={defaults.studentLoan} onChange={(event) => setDefault("studentLoan", event.target.value)}>
                <option value="">Not chosen</option>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </Field>
            <Field label="Pay frequency">
              <select value={defaults.payFrequency} onChange={(event) => setDefault("payFrequency", event.target.value)}>
                <option value="">Not chosen</option>
                <option value="weekly">Weekly</option>
                <option value="fortnightly">Fortnightly</option>
                <option value="four weekly">Four-weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </Field>
          </div>
          <div className={ui.actions}>
            <Button variant="secondary" disabled={busy} onClick={() => void send(false)}>Check again</Button>
            <Button disabled={busy || result.problems.length > 0 || result.counts.create === 0} onClick={() => void send(true)}>
              {busy ? "Working…" : `Bring in ${result.counts.create} employee${result.counts.create === 1 ? "" : "s"}`}
            </Button>
          </div>
          {result.committed ? <Notice tone="success">{`${result.counts.create} brought in. Check each one's pay details and bank account before the first pay run.`}</Notice> : null}
          {result.problems.length ? (
            <Notice tone="warning">
              {result.problems.length} row{result.problems.length === 1 ? "" : "s"} to fix first:
              <ul>
                {result.problems.map((problem) => <li key={`${problem.row}-${problem.message}`}>Row {problem.row}: {problem.message}</li>)}
              </ul>
            </Notice>
          ) : null}
          {result.outcomes.length ? (
            <div className={ui.tableWrap}>
              <table className={ui.stackOnPhone}>
                <thead><tr><th>Row</th><th>Employee</th><th>What happens</th></tr></thead>
                <tbody>
                  {result.outcomes.map((outcome) => (
                    <tr key={outcome.row}>
                      <td data-label="Row">{outcome.row}</td>
                      <td data-label="Employee">{outcome.label}</td>
                      <td data-label="What happens">{outcome.action === "create" ? (result.committed ? "Brought in" : "Will be brought in") : outcome.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : result.problems.length ? null : <Empty>No employees in the file.</Empty>}
        </>
      ) : null}
    </Card>
  );
}
