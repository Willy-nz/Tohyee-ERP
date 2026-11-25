"use client";

import Link from "next/link";
import { useState } from "react";
import { amountIn, useBaseCurrency } from "@/components/crm";
import { useApiData } from "@/components/hooks";
import { PeriodBars } from "@/components/crm-period-bars";
import { InfoTip } from "@/components/info-tip";
import { Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import type { CurrencyAmount, Dashboard, DashboardDeal } from "@/lib/crm/dashboard";
import type { ForecastPeriodKind } from "@/lib/crm/forecast-figures";
import { LEAD_SOURCE_LABELS } from "@/lib/crm/lead-types";
import { formatDate, formatMoney } from "@/lib/format";
import { add, dec, toFixedString } from "@/lib/money/decimal";
import styles from "./crm-dashboard.module.css";

type Drill = { title: string; deals: DashboardDeal[] };

/**
 * CRM › Dashboard: lead conversion, win rate, sales cycle,
 * stage ageing, activity, quota attainment and campaigns, per month or
 * quarter. Each count of deals opens the deals it's made of.
 */
export function DashboardPage({ organisationId }: { organisationId: string }) {
  const baseCurrency = useBaseCurrency();
  const [period, setPeriod] = useState<ForecastPeriodKind>("month");
  const [periods, setPeriods] = useState("6");
  const [drill, setDrill] = useState<Drill | null>(null);
  const data = useApiData<{ dashboard: Dashboard }>("/api/crm/dashboard", { organisationId, period, periods });
  const d = data.data?.dashboard;
  const label = (start: string) => d?.periods.find((entry) => entry.start === start)?.label ?? start;
  const amounts = (list: CurrencyAmount[]) => (list.length === 0 ? "—" : list.map((entry) => amountIn(entry.amount, entry.currencyCode, baseCurrency)).join(" + "));
  const open = (title: string, deals: DashboardDeal[]) => setDrill({ title, deals });
  const count = (value: number, title: string, deals: () => DashboardDeal[]) =>
    value === 0 ? (
      "0"
    ) : (
      <button type="button" className={ui.linkButton} onClick={() => open(title, deals())}>
        {value}
      </button>
    );
  // The few figures up top, from what the tables below already hold.
  const openDeals = d ? d.ageing.reduce((sum, row) => sum + row.count, 0) : 0;
  const mostInStage = Math.max(1, ...(d?.ageing.map((row) => row.count) ?? []));
  const openAmounts: CurrencyAmount[] = [];
  for (const entry of d?.ageing.flatMap((row) => row.amounts) ?? []) {
    const same = openAmounts.find((total) => total.currencyCode === entry.currencyCode);
    if (same) same.amount = toFixedString(add(dec(same.amount), dec(entry.amount)), 2);
    else openAmounts.push({ ...entry });
  }
  const latest = d?.periods.at(-1);
  const latestWinLoss = d?.winLoss.at(-1);
  const noLeads = d ? d.leads.every((row) => row.added === 0 && row.converted === 0) : false;
  const noneClosed = d ? d.winLoss.every((row) => row.won === 0 && row.lost === 0) : false;
  const inPeriod = (start: string, end: string, deal: DashboardDeal) => deal.closedOn !== null && deal.closedOn >= start && deal.closedOn <= end;
  return (
    <>
      <Card
        description={
          <>
            Amounts exclude GST.{" "}
            <InfoTip label="How these are worked out">
              Worked out from the CRM&apos;s records each time. Amounts are never added across currencies. A deal&apos;s closed date is the day it moved to Closed won or lost.
            </InfoTip>
          </>
        }
      >
        <div className={ui.grid3}>
          <Field label="By">
            <select value={period} onChange={(event) => setPeriod(event.target.value as ForecastPeriodKind)}>
              <option value="month">Month</option>
              <option value="quarter">Quarter (of the financial year)</option>
            </select>
          </Field>
          <Field label="Periods (ending with this one)">
            <input inputMode="numeric" className={ui.num} value={periods} onChange={(event) => setPeriods(event.target.value)} />
          </Field>
        </div>
        {data.error ? <Notice tone="error">{data.error}</Notice> : null}
        {d?.scoped ? <Notice>These figures are your own leads, deals and activity.</Notice> : null}
      </Card>
      {!d ? (
        data.error ? null : <p className={ui.muted}>Loading…</p>
      ) : (
        <>
          <div className={ui.statRow}>
            <Stat label="Open deals" value={openDeals} />
            <Stat label="Open amount" value={amounts(openAmounts)} />
            <Stat label={`Won in ${latest?.label ?? "this period"}`} value={latestWinLoss ? latestWinLoss.won : "—"} />
            <Stat label="Win rate" value={latestWinLoss?.winRate == null ? "—" : `${latestWinLoss.winRate}%`} />
          </div>
          <Card title="Open deals by stage">
            {d.ageing.length === 0 ? (
              <Empty>No open deals.</Empty>
            ) : (
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th>Stage</th>
                      <th className={ui.num}>Deals</th>
                      <th className={ui.num}>Amount</th>
                      <th className={ui.num}>Average days in stage</th>
                      <th className={ui.num}>Longest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.ageing.map((row) => (
                      <tr key={row.stage}>
                        <td className={styles.stageCell}>
                          <span className={styles.stageBar} style={{ width: `${Math.round((row.count / mostInStage) * 120)}px` }} aria-hidden="true" />
                          {row.stageName}
                        </td>
                        <td className={ui.num}>{count(row.count, `Open in ${row.stageName}`, () => d.deals.filter((deal) => deal.stageType === "open" && deal.stageName === row.stageName))}</td>
                        <td className={ui.num}>{amounts(row.amounts)}</td>
                        <td className={ui.num}>{row.averageDays ?? "—"}</td>
                        <td className={ui.num}>{row.oldestDays ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card title="Leads">
            {noLeads ? <Empty>No leads in these periods.</Empty> : (
            <>
            <PeriodBars label="Leads added in each period" bars={d.leads.map((row) => ({ period: label(row.periodStart), value: row.added, text: String(row.added) }))} />
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th className={ui.num}>Added</th>
                    <th className={ui.num}>Converted</th>
                    <th className={ui.num}>Conversion</th>
                  </tr>
                </thead>
                <tbody>
                  {d.leads.map((row) => (
                    <tr key={row.periodStart}>
                      <td>{label(row.periodStart)}</td>
                      <td className={ui.num}>{row.added}</td>
                      <td className={ui.num}>{row.converted}</td>
                      <td className={ui.num}>{row.rate === null ? "—" : `${row.rate}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
            )}
            {d.leadSources.length > 0 ? (
              <p className={ui.muted}>
                By how they came in:{" "}
                {d.leadSources.map((row) => `${LEAD_SOURCE_LABELS[row.source]} ${row.added} (${row.rate ?? "—"}% converted)`).join(" · ")}
              </p>
            ) : null}
          </Card>
          <Card
            title="Win rate and sales cycle"
            description={
              <InfoTip label="How these are worked out">Deals closed in each period: won ÷ (won + lost). The sales cycle is the days from a deal being added to it being won.</InfoTip>
            }
          >
            {noneClosed ? <Empty>No deals closed in these periods.</Empty> : (
            <>
            <PeriodBars
              label="Win rate in each period"
              max={100}
              bars={d.winLoss.map((row, index) => ({ period: d.periods[index].label, value: row.winRate === null ? null : Number(row.winRate), text: row.winRate === null ? "—" : `${row.winRate}%` }))}
            />
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th className={ui.num}>Won</th>
                    <th className={ui.num}>Lost</th>
                    <th className={ui.num}>Win rate</th>
                    <th className={ui.num}>Won amount</th>
                    <th className={ui.num}>Average days</th>
                    <th className={ui.num}>Median days</th>
                  </tr>
                </thead>
                <tbody>
                  {d.winLoss.map((row, index) => {
                    const p = d.periods[index];
                    const cycle = d.cycle[index];
                    return (
                      <tr key={row.periodStart}>
                        <td>{p.label}</td>
                        <td className={ui.num}>{count(row.won, `Won in ${p.label}`, () => d.deals.filter((deal) => deal.stageType === "won" && inPeriod(p.start, p.end, deal)))}</td>
                        <td className={ui.num}>{count(row.lost, `Lost in ${p.label}`, () => d.deals.filter((deal) => deal.stageType === "lost" && inPeriod(p.start, p.end, deal)))}</td>
                        <td className={ui.num}>{row.winRate === null ? "—" : `${row.winRate}%`}</td>
                        <td className={ui.num}>{amounts(row.wonAmounts)}</td>
                        <td className={ui.num}>{cycle.averageDays ?? "—"}</td>
                        <td className={ui.num}>{cycle.medianDays ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
            )}
          </Card>
          <Card title="Activity">
            {d.activity.length === 0 ? (
              <Empty>Nothing logged.</Empty>
            ) : (
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Who</th>
                      <th className={ui.num}>Calls</th>
                      <th className={ui.num}>Meetings</th>
                      <th className={ui.num}>Notes</th>
                      <th className={ui.num}>Tasks done</th>
                      <th className={ui.num}>Emails sent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.activity.map((row) => (
                      <tr key={`${row.periodStart}:${row.userId}`}>
                        <td>{label(row.periodStart)}</td>
                        <td>{row.name}</td>
                        <td className={ui.num}>{row.calls}</td>
                        <td className={ui.num}>{row.meetings}</td>
                        <td className={ui.num}>{row.notes}</td>
                        <td className={ui.num}>{row.tasksDone}</td>
                        <td className={ui.num}>{row.emailsSent}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card title="Quota attainment" description={<InfoTip label="How this is worked out">As the forecast works it out: Closed in {baseCurrency} by expected close date ÷ quota.</InfoTip>}>
            {d.quotas.length === 0 ? (
              <Empty>
                No quotas set. Admins set them on <Link href="/crm/forecasts">Forecasts</Link>.
              </Empty>
            ) : (
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Who</th>
                      <th className={ui.num}>Closed</th>
                      <th className={ui.num}>Quota</th>
                      <th className={ui.num}>Attainment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.quotas.map((row) => (
                      <tr key={`${row.periodStart}:${row.ownerUserId}`}>
                        <td>{label(row.periodStart)}</td>
                        <td>{row.name}</td>
                        <td className={ui.num}>{formatMoney(row.closed)}</td>
                        <td className={ui.num}>{formatMoney(row.quota)}</td>
                        <td className={ui.num}>{row.attainment === null ? "—" : `${row.attainment}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card title="Campaigns">
            {d.campaigns.length === 0 ? (
              <Empty>Nothing from campaigns in these periods.</Empty>
            ) : (
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th className={ui.num}>Leads</th>
                      <th className={ui.num}>Deals won</th>
                      <th className={ui.num}>Won amount</th>
                      <th className={ui.num}>Actual cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.campaigns.map((row) => (
                      <tr key={row.campaignId}>
                        <td>
                          <Link href={`/crm/campaigns/${row.campaignId}`}>{row.name}</Link>
                        </td>
                        <td className={ui.num}>{row.leads}</td>
                        <td className={ui.num}>{row.won}</td>
                        <td className={ui.num}>{amounts(row.wonAmounts)}</td>
                        <td className={ui.num}>{row.actualCost === null ? "—" : formatMoney(row.actualCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          {drill ? (
            <Card
              title={drill.title}
              actions={
                <Button size="small" variant="secondary" onClick={() => setDrill(null)}>
                  Close
                </Button>
              }
            >
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th>Deal</th>
                      <th>Stage</th>
                      <th className={ui.num}>Amount</th>
                      <th>Added</th>
                      <th>Closed</th>
                      <th className={ui.num}>Days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drill.deals.map((deal) => (
                      <tr key={deal.id}>
                        <td>
                          <Link href={`/crm/opportunities/${deal.id}`}>{deal.name}</Link>
                        </td>
                        <td>{deal.stageName}</td>
                        <td className={ui.num}>{amountIn(deal.amount, deal.currencyCode, baseCurrency)}</td>
                        <td>{formatDate(deal.addedOn)}</td>
                        <td>{deal.closedOn ? formatDate(deal.closedOn) : ""}</td>
                        <td className={ui.num}>{deal.days ?? deal.daysInStage ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}
