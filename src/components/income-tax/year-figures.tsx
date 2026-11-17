"use client";

import { type FormEvent,useState } from "react";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Button,Card,Field,Notice,ui } from "@/components/ui";
import { api,errorMessage } from "@/lib/client/api";
import { formatMoney,personName } from "@/lib/format";
import { incomeYearLabel,type TaxpayerType } from "@/lib/tax/income/rules";
import type { IncomeTaxReport,IncomeTaxYear } from "@/lib/tax/income/service";
import { Status } from "@/components/income-tax/shared";
import { Payments } from "@/components/income-tax/payments";

export function YearFigures({ organisationId, incomeYear, type, years, endMonth, onSaved }: { organisationId: string; incomeYear: number; type: TaxpayerType; years: number[]; endMonth: number; onSaved: () => void }) {
  const [year, setYear] = useState(incomeYear);
  const loaded = useApiData<{ report: IncomeTaxReport }>("/api/income-tax", { organisationId, incomeYear: year });
  const report = loaded.data?.report;
  return (
    <Card title="IRD's figures" description="Type what IRD has for a year: they're kept as typed, with who typed them. Last year's assessed RIT and filing date set this year's provisional tax.">
      <Field label="Income year">
        <select value={year} onChange={(event) => setYear(Number(event.target.value))}>
          {years.map((value) => (
            <option key={value} value={value}>
              {incomeYearLabel(value, endMonth)}
            </option>
          ))}
        </select>
      </Field>
      {report && report.supported ? (
        <>
          <YearForm key={`${year}-${report.typed.version}`} organisationId={organisationId} typed={report.typed} type={type} lastYearExcess={report.lastYearExcessImputation} onSaved={() => { loaded.reload(); onSaved(); }} />
          <Payments key={`p-${year}`} organisationId={organisationId} incomeYear={year} payments={report.payments} total={report.paidTotal} instalmentCount={report.provisional.kind === "schedule" ? report.provisional.instalments.length : 3} onSaved={() => { loaded.reload(); onSaved(); }} />
        </>
      ) : loaded.error ? (
        <Notice tone="error">{loaded.error}</Notice>
      ) : (
        <p className={ui.muted}>Loading…</p>
      )}
    </Card>
  );
}

function YearForm({ organisationId, typed, type, lastYearExcess, onSaved }: { organisationId: string; typed: IncomeTaxYear; type: TaxpayerType; lastYearExcess: string | null; onSaved: () => void }) {
  const [form, setForm] = useState({
    assessedRit: typed.assessedRit ?? "",
    returnFiledOn: typed.returnFiledOn ?? "",
    lossesBroughtForward: typed.lossesBroughtForward,
    taxCredits: typed.taxCredits,
    imputationCredits: typed.imputationCredits,
    overseasTaxPaid: typed.overseasTaxPaid,
    imputationBroughtForward: typed.imputationBroughtForward,
    otherIncome: typed.otherIncome,
    multipleActivity: typed.multipleActivity,
  });
  const [status, setStatus] = useState<Status>(null);
  const set = (name: Exclude<keyof typeof form, "multipleActivity">) => (value: string) => setForm((current) => ({ ...current, [name]: value }));
  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/income-tax/years", { method: "PUT", body: { organisationId, incomeYear: typed.incomeYear, ...form, version: typed.version } });
      setStatus({ tone: "success", text: "Saved." });
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  return (
    <form onSubmit={save}>
      <div className={ui.grid}>
        <Field label="Assessed RIT (from IRD)" hint="Leave blank until the return's filed and assessed.">
          <input inputMode="decimal" value={form.assessedRit} onChange={(event) => set("assessedRit")(event.target.value)} />
        </Field>
        <Field label="Return filed on">
          <DateInput value={form.returnFiledOn} onChange={(event) => set("returnFiledOn")(event.target.value)} />
        </Field>
        <Field label="Losses brought forward">
          <input inputMode="decimal" value={form.lossesBroughtForward} onChange={(event) => set("lossesBroughtForward")(event.target.value)} />
        </Field>
        <Field label="Tax credits" hint="PAYE, RWT and other credits that are refunded if more than the tax. Not imputation credits or overseas tax.">
          <input inputMode="decimal" value={form.taxCredits} onChange={(event) => set("taxCredits")(event.target.value)} />
        </Field>
        <Field label="Imputation credits received" hint="On dividends received. They can bring the tax to nil but aren't refunded.">
          <input inputMode="decimal" value={form.imputationCredits} onChange={(event) => set("imputationCredits")(event.target.value)} />
        </Field>
        <Field label="Overseas tax paid" hint="Tax paid overseas on overseas income. It can bring the tax to nil but isn't refunded.">
          <input inputMode="decimal" value={form.overseasTaxPaid} onChange={(event) => set("overseasTaxPaid")(event.target.value)} />
        </Field>
        {type === "individual" ? (
          <Field
            label="Excess imputation credits brought forward"
            hint={`From IRD's excess imputation credits letter for last year (IR3 box 34).${lastYearExcess ? ` Tohyee works out ${formatMoney(lastYearExcess)} from last year's books.` : ""}`}
          >
            <input inputMode="decimal" value={form.imputationBroughtForward} onChange={(event) => set("imputationBroughtForward")(event.target.value)} />
          </Field>
        ) : null}
        {type === "individual" ? (
          <Field label="Other income" hint="Wages, interest, dividends and other income outside the business.">
            <input inputMode="decimal" value={form.otherIncome} onChange={(event) => set("otherIncome")(event.target.value)} />
          </Field>
        ) : null}
      </div>
      <label className={ui.checkbox}>
        <input type="checkbox" checked={form.multipleActivity} onChange={(event) => setForm((current) => ({ ...current, multipleActivity: event.target.checked }))} /> More than one line of business (IR10 box 1)
      </label>
      <div>
        <Button type="submit">Save figures</Button>
      </div>
      {typed.updatedByEmail ? (
        <span className={ui.muted}>
          {" "}
          Typed by {personName(typed, "updatedBy")}
        </span>
      ) : null}
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </form>
  );
}
