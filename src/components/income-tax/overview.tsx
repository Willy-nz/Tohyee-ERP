"use client";

import { InfoTip } from "@/components/info-tip";
import Link from "next/link";
import styles from "@/components/tax-workspace.module.css";
import { Money } from "@/components/books";
import { Badge,Card,Notice,Stat,ui } from "@/components/ui";
import { formatDate,formatMoney } from "@/lib/format";
import { dependsOnForecast,nextDue,taxTasks } from "@/lib/tax/income/workspace";
import { Supported,TAX_VIEWS,viewHref } from "@/components/income-tax/shared";

export function Provisional({ report }: { report: Supported }) {
  const schedule = report.provisional;
  return (
    <Card
      title="Provisional tax (standard option)"
      description={`Based on the ${report.lastYear.incomeYear} income year's RIT${report.lastYear.rit ? ` of ${formatMoney(report.lastYear.rit)}` : ""} (${report.lastYear.typed ? "typed from IRD" : "Tohyee estimate"}). Showing this isn't choosing an option with IRD.`}
    >
      {schedule.kind === "schedule" ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Instalment</th>
                <th>Due</th>
                <th className={ui.num}>Amount</th>
                <th className={ui.num}>Paid towards it</th>
                <th className={ui.num}>Still needed by this date</th>
                <th>How it&apos;s worked out</th>
              </tr>
            </thead>
            <tbody>
              {schedule.instalments.map((instalment) => (
                <tr key={instalment.number}>
                  <td data-label="Instalment">{instalment.number}</td>
                  <td data-label="Due">
                    {formatDate(instalment.dueDate)}
                    {instalment.onTimeBy.date !== instalment.dueDate ? <span className={ui.muted}> (on time by {formatDate(instalment.onTimeBy.date)})</span> : null}
                  </td>
                  <td data-label="Amount" className={ui.num}>
                    <Money value={instalment.amount} /> {instalment.estimate ? <Badge tone="amber">Estimate</Badge> : null}
                    {instalment.catchUp !== "0.00" ? <div className={ui.muted}>Includes {formatMoney(instalment.catchUp)} not paid towards earlier instalments</div> : null}
                  </td>
                  <td data-label="Paid towards it" className={ui.num}>
                    <Money value={instalment.paid} />
                    {instalment.paidLate !== "0.00" ? <div><Badge tone="red">{`${formatMoney(instalment.paidLate)} late`}</Badge></div> : null}
                    {instalment.forecastPaid !== "0.00" ? <div className={ui.muted}>Plus {formatMoney(instalment.forecastPaid)} assumed (forecast)</div> : null}
                  </td>
                  <td data-label="Still needed" className={ui.num}>
                    <Money value={instalment.remaining} />
                    {instalment.remainingWithForecast !== instalment.remaining ? <div className={ui.muted}>{formatMoney(instalment.remainingWithForecast)} if the forecast holds</div> : null}
                    {instalment.creditAfter !== "0.00" ? <div className={ui.muted}>{formatMoney(instalment.creditAfter)} credit carried forward</div> : null}
                  </td>
                  <td data-label="How">
                    {instalment.basis}
                    {instalment.assumption ? <div className={ui.muted}>{instalment.assumption}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {schedule.notes.map((text) => (
        <Notice key={text} tone={schedule.kind === "unknown" ? "warning" : "info"}>
          {text}
        </Notice>
      ))}
    </Card>
  );
}

export function InterestCard({ report }: { report: Supported }) {
  const interest = report.interest;
  return (
    <Card
      title="Use-of-money interest (estimate)"
      description={`On ${interest.ritTyped ? "IRD's assessed" : "Tohyee's forecast"} RIT of ${formatMoney(interest.rit)}, at IRD's rates (latest from ${formatDate(interest.ratesKnownTo)}, used for future days too). IRD works out what it actually charges.`}
    >
      <div className={ui.statRow}>
        <Stat label={`So far, to ${formatDate(interest.soFar.asAt)}`} value={<Money value={interest.soFar.amount} />} />
        <Stat label="If everything's paid on its due date" value={interest.ifPaidOnTime === null ? <span className={ui.muted}>Not worked out</span> : <Money value={interest.ifPaidOnTime} />} />
      </div>
      {interest.soFar.periods.length > 0 ? (
        <ul>
          {interest.soFar.periods.map((period) => (
            <li key={period.from}>
              {formatDate(period.from)} to {formatDate(period.to)} ({period.days} days): <Money value={period.outstanding} /> unpaid at {period.rate}% = <Money value={period.interest} />
            </li>
          ))}
        </ul>
      ) : null}
      <p className={ui.muted}>Simple daily interest, from the day after each amount was due to the day it&apos;s paid.{" "}<InfoTip label="Use-of-money interest">Rate × days ÷ 365. Nothing while $100 or less is unpaid. Interest IRD pays on overpayments isn&apos;t worked out.</InfoTip></p>
    </Card>
  );
}

/** A forecast figure, or "Forecast incomplete" when the year has nothing to work from. */
function ForecastFigure({ value, incomplete }: { value: string; incomplete: boolean }) {
  return incomplete ? <span className={ui.muted}>Forecast incomplete</span> : <Money value={value} />;
}

export function Figures({ report, incomplete }: { report: Supported; incomplete: boolean }) {
  return (
    <div className={ui.statRow}>
      <Stat label="Taxable income" value={<ForecastFigure value={report.workpaper.taxableIncome} incomplete={incomplete} />} />
      <Stat label="Residual income tax" value={<ForecastFigure value={report.workpaper.rit} incomplete={incomplete} />} />
      <Stat
        label={!incomplete && Number(report.endOfYear.amount) < 0 ? "Expected refund" : "Expected end-of-year tax"}
        value={<ForecastFigure value={report.endOfYear.amount.replace(/^-/, "")} incomplete={incomplete} />}
      />
    </div>
  );
}

export function DueDates({ report, incomplete }: { report: Supported; incomplete: boolean }) {
  return (
    <Card title="Due dates" description="Payments to IRD for this year and last year's end-of-year tax. A date on a weekend or public holiday is on time the next business day.">
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Due</th>
              <th>What</th>
              <th className={ui.num}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {report.dueDates.map((entry) => (
              <tr key={entry.key}>
                <td data-label="Due">
                  {formatDate(entry.dueDate)}
                  {entry.onTimeBy.date !== entry.dueDate ? <span className={ui.muted}> (on time by {formatDate(entry.onTimeBy.date)})</span> : null}
                </td>
                <td data-label="What">{entry.label}</td>
                <td data-label="Amount" className={ui.num}>
                  {entry.amount === null ? (
                    <span className={ui.muted}>Not known yet</span>
                  ) : incomplete && dependsOnForecast(entry, report.incomeYear) ? (
                    <span className={ui.muted}>Forecast incomplete</span>
                  ) : (
                    <Money value={entry.amount} />
                  )}{" "}
                  {entry.estimate ? <Badge tone="amber">Estimate</Badge> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function Overview({ report, incomplete }: { report: Supported; incomplete: boolean }) {
  const next = nextDue(report.dueDates, report.interest.soFar.asAt);
  const tasks = taxTasks(report);
  return (
    <>
      <Figures report={report} incomplete={incomplete} />
      <Card title="Next payment to IRD">
        {next ? (
          <p>
            <strong>{formatDate(next.dueDate)}</strong>: {next.label},{" "}
            {next.amount === null ? "amount not known yet" : incomplete && dependsOnForecast(next, report.incomeYear) ? "forecast incomplete" : <Money value={next.amount} />}
            {next.estimate ? <> <Badge tone="amber">Estimate</Badge></> : null}
          </p>
        ) : (
          <p className={ui.muted}>No payment is due from today for this income year.</p>
        )}
      </Card>
      <Card title="Needs attention">
        {tasks.length === 0 ? (
          <p className={ui.muted}>Nothing for this income year.</p>
        ) : (
          <ul className={styles.tasks}>
            {tasks.map((task) => (
              <li key={task.key}>
                {task.text} <Link href={viewHref(task.view, report.incomeYear)}>{TAX_VIEWS.find(([key]) => key === task.view)![1]}</Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <DueDates report={report} incomplete={incomplete} />
    </>
  );
}
