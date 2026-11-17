"use client";

import Link from "next/link";
import { usePathname,useRouter,useSearchParams } from "next/navigation";
import styles from "@/components/tax-workspace.module.css";
import { useApiData } from "@/components/hooks";
import { Card,Field,Notice,PageHeader,ui } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { incomeYearLabel } from "@/lib/tax/income/rules";
import { IR3_BOX_LABELS,IR3_BOXES } from "@/lib/tax/income/ir3";
import { IR4_BOX_LABELS,IR4_BOXES } from "@/lib/tax/income/ir4";
import type { IncomeTaxReport } from "@/lib/tax/income/service";
import { forecastIncomplete } from "@/lib/tax/income/workspace";
import { useModules } from "@/components/modules";
import { IrdImports } from "@/components/ird-imports";
import { Supported,TAX_VIEWS,TaxView,viewHref } from "@/components/income-tax/shared";
import { Settings,Workpaper } from "@/components/income-tax/workpaper";
import { YearFigures } from "@/components/income-tax/year-figures";
import { BookPayments } from "@/components/income-tax/payments";
import { DueDates,Figures,InterestCard,Overview,Provisional } from "@/components/income-tax/overview";
import { TaxAssets } from "@/components/income-tax/assets";
import { IcaCard,Ir10Card,TaxReturnCard } from "@/components/income-tax/returns";
import { IrdDocuments } from "@/components/income-tax/ird";

function Report({ organisationId, report, reload, view, gst }: { organisationId: string; report: Supported; reload: () => void; view: Exclude<TaxView, "settings">; gst: boolean }) {
  const incomplete = forecastIncomplete(report);
  return (
    <>
      {/* On Overview, Needs attention says the same, so the notice isn't repeated there. */}
      {incomplete && (view === "forecast" || view === "calculation") ? (
        <Notice tone="warning">
          <strong>Forecast incomplete.</strong> No income or expenses were found for this year, in the books or the overall budget, and nothing&apos;s been typed or adjusted, so the tax isn&apos;t shown as $0.00.{" "}
          <Link href="/operations/budgets">Add a budget</Link> or <Link href={viewHref("calculation", report.incomeYear)}>check the calculation</Link>.
        </Notice>
      ) : null}
      {view === "overview" ? <Overview report={report} incomplete={incomplete} /> : null}
      {view === "forecast" ? (
        <>
          <Figures report={report} incomplete={incomplete} />
          <Card title="What the forecast is based on">
            <p>
              {report.actualsTo ? `Actuals to ${formatDate(report.actualsTo)}.` : "No actuals yet for this income year."}{" "}
              {report.budgetFrom ? `From ${formatDate(report.budgetFrom)}, the ${report.budgetName ?? "overall budget"}${report.budgetName ? "" : " (none set up yet)"}.` : "The year has ended, so no budget is used."}
            </p>
            <div className={ui.actions}>
              <Link href="/operations/budgets">Budgets</Link>
              <Link href={viewHref("calculation", report.incomeYear)}>Tax calculation and adjustments</Link>
            </div>
          </Card>
          <Card title="Notes">
            <ul>
              {report.notes.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </Card>
        </>
      ) : null}
      {view === "calculation" ? (
        <>
          <Workpaper organisationId={organisationId} report={report} onSaved={reload} />
          <TaxAssets organisationId={organisationId} assets={report.taxAssets} incomeYear={report.incomeYear} onSaved={reload} />
        </>
      ) : null}
      {view === "payments" ? (
        <>
          <DueDates report={report} incomplete={incomplete} />
          <Provisional report={report} />
          <YearFigures key={`${report.typed.version}-${report.paidTotal}-${report.lastYear.rit}`} organisationId={organisationId} incomeYear={report.incomeYear} type={report.settings.taxpayerType} years={report.years} endMonth={report.endMonth} onSaved={reload} />
          <BookPayments organisationId={organisationId} years={report.years} onChanged={reload} />
          <IrdDocuments organisationId={organisationId} incomeYear={report.incomeYear} years={report.years} endMonth={report.endMonth} onChanged={reload} />
          <IrdImports organisationId={organisationId} incomeYear={report.incomeYear} years={report.years} onChanged={reload} />
          <InterestCard report={report} />
        </>
      ) : null}
      {view === "returns" ? (
        <>
          {report.ica ? <IcaCard organisationId={organisationId} ica={report.ica} onSaved={reload} /> : null}
          {report.ir4 ? (
            <TaxReturnCard title={`IR4 company return: income and tax (${report.incomeYear})`} source="IRD's 2026 IR4 form and guide" order={IR4_BOXES} labels={IR4_BOX_LABELS} result={report.ir4} residualBox="30J" outcomeBox="30L" provisionalBox="33" />
          ) : null}
          {report.ir3 ? (
            <TaxReturnCard title={`IR3 individual return: income and tax (${report.incomeYear})`} source="IRD's 2026 IR3 form and guide (the Question 36 worksheet)" order={IR3_BOXES} labels={IR3_BOX_LABELS} result={report.ir3} residualBox="W14" outcomeBox="W16" provisionalBox="39" />
          ) : null}
          {report.ir10 ? <Ir10Card organisationId={organisationId} report={report} ir10={report.ir10} onSaved={reload} /> : (
            <Card title="IR10 financial statements summary">
              <p className={ui.muted}>The IR10 is shown once the {report.incomeYear} income year has ended (31 March {report.incomeYear}).</p>
            </Card>
          )}
          {gst ? (
            <Card title="GST returns">
              <p>
                GST returns have their own page: <Link href="/operations/gst-return">GST return</Link>.
              </p>
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** Which page of the workspace a path is. */
export function taxViewOf(pathname: string): TaxView {
  const segment = pathname.split("/")[3];
  return TAX_VIEWS.find(([key]) => key === segment)?.[0] ?? "overview";
}

export function IncomeTaxView({ organisationId }: { organisationId: string }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const modules = useModules(organisationId);
  const requestedYear = search.get("incomeYear");
  const incomeYear = requestedYear && /^\d{4}$/.test(requestedYear) ? Number(requestedYear) : null;
  const view = taxViewOf(pathname);
  const loaded = useApiData<{ report: IncomeTaxReport }>("/api/income-tax", { organisationId, incomeYear });
  const report = loaded.data?.report;
  const year = report?.incomeYear ?? incomeYear;
  return (
    <>
      <PageHeader
        title="Income tax"
        actions={
          report ? (
            <Field label="Income year">
              <select value={report.incomeYear} onChange={(event) => router.push(`${pathname}?incomeYear=${event.target.value}`)}>
                {report.years.map((value) => (
                  <option key={value} value={value}>
                    {incomeYearLabel(value, report.endMonth)}
                  </option>
                ))}
              </select>
            </Field>
          ) : undefined
        }
      />
      <div className={styles.workspace}>
        <nav className={styles.navigation} aria-label="Income tax">
          {TAX_VIEWS.map(([key, label]) => (
            <Link key={key} href={viewHref(key, year)} aria-current={view === key ? "page" : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        <div className={styles.content}>
          {loaded.error ? (
            <Notice tone="error">{loaded.error}</Notice>
          ) : !report ? (
            <p className={ui.muted}>Loading…</p>
          ) : (
            <>
              <details className={styles.review}>
                <summary>Estimates, not yet reviewed by an accountant</summary>
                <p>These figures follow IRD&apos;s published rules as Tohyee reads them. They haven&apos;t been reviewed by an accountant yet, so check them before relying on them. Nothing here files a return or pays IRD.</p>
              </details>
              {view === "settings" ? (
                <Settings key={`${report.settings.version}`} organisationId={organisationId} settings={report.settings} onSaved={loaded.reload} />
              ) : report.supported ? (
                <Report organisationId={organisationId} report={report} reload={loaded.reload} view={view} gst={Boolean(modules?.gst)} />
              ) : (
                <Notice tone="info">
                  {report.reason} <Link href={viewHref("settings", year)}>Tax settings</Link>
                </Notice>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
