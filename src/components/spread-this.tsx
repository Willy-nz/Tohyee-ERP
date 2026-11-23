"use client";

import Link from "next/link";
import { useState } from "react";
import { Money } from "@/components/books";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { SpreadMethod } from "@/lib/spreading/rules";
import type { SpreadAccount } from "@/lib/spreading/service";
import type { SourceLine } from "@/lib/spreading/sources";
import styles from "./spreading.module.css";

/**
 * "Spread this" on an approved bill or invoice (examples SW15-SW17): a line
 * paid or invoiced ahead goes onto the Spreading worksheet, and its amount
 * without GST moves to the balance sheet until each month takes its share.
 * Shown only once Spreading is turned on.
 */

const METHODS: Array<{ value: SpreadMethod; label: string }> = [
  { value: "by_month", label: "Evenly by month" },
  { value: "by_days", label: "By days" },
  { value: "one_month", label: "All in one month" },
  { value: "when_done", label: "When it's done" },
];

type Accrual = { id: string; description: string; accrued: string; targetCode: string; targetName: string };

/** What the server says when months that had already posted were caught up (SW18). */
export function caughtUpText(caughtUp: { months: number; amount: string; into: string } | null | undefined): string {
  if (!caughtUp) return "";
  const [year, month] = caughtUp.into.split("-");
  const name = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(month) - 1];
  return ` ${caughtUp.months === 1 ? "One month has" : `${caughtUp.months} months have`} already been posted, so ${caughtUp.amount} is caught up in ${name} ${year}.`;
}

export function SpreadThisCard({
  organisationId,
  billId,
  invoiceId,
  bankTransactionId,
  always,
}: {
  organisationId: string;
  billId?: string;
  invoiceId?: string;
  bankTransactionId?: string;
  /** Say why there's nothing to spread instead of showing nothing (when a button opened it). */
  always?: boolean;
}) {
  const { can } = useWorkspace();
  const found = useApiData<{ holding: SpreadAccount | null; lines: SourceLine[]; accruals: Accrual[] }>("/api/spreading/lines", {
    organisationId,
    billId: billId ?? null,
    invoiceId: invoiceId ?? null,
    bankTransactionId: bankTransactionId ?? null,
  });
  const [open, setOpen] = useState<string | null>(null);
  // "spread" puts the line on the worksheet; "accrual" says it's the bill or invoice an accrual was waiting for (SW20).
  const [mode, setMode] = useState<"spread" | "accrual">("spread");
  const [accrualId, setAccrualId] = useState("");
  const [method, setMethod] = useState<SpreadMethod>("by_month");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [month, setMonth] = useState("");
  const [itemKey, setItemKey] = useState(() => newIdempotencyKey("spread"));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const holding = found.data?.holding ?? null;
  const lines = (found.data?.lines ?? []).filter((line) => line.itemId || !line.reason);
  const accruals = found.data?.accruals ?? [];
  if (!holding || lines.length === 0) {
    if (!always || !found.data) return null;
    return <Notice>{holding ? "Nothing on this can be spread: it needs a line on an expense or income account." : "Turn Spreading on first, under Accounting."}</Notice>;
  }
  const isCost = lines[0].isCost;
  const lineKey = billId ? "billLineId" : invoiceId ? "invoiceLineId" : "bankLineId";
  const dated = method === "by_month" || method === "by_days";

  function start(line: SourceLine, as: "spread" | "accrual") {
    setMode(as);
    setAccrualId(accruals[0]?.id ?? "");
    setOpen(line.lineId);
    setError(null);
    setMessage(null);
    setStartDate(line.date);
    setMonth(line.date.slice(0, 7));
  }

  async function save(line: SourceLine) {
    setBusy(true);
    setError(null);
    try {
      if (mode === "accrual") {
        const accrual = accruals.find((each) => each.id === accrualId);
        await api(`/api/spreading/items/${accrualId}/settle`, { method: "POST", body: { organisationId, source: "ui", [lineKey]: line.lineId } });
        setMessage(`${accrual?.description ?? "The accrual"} is marked at ${line.amount}.`);
      } else {
        const body: Record<string, unknown> = { organisationId, source: "ui", idempotencyKey: itemKey, method, [lineKey]: line.lineId };
        if (dated) Object.assign(body, { startDate, endDate });
        if (method === "one_month") body.month = month;
        const made = await api<{ caughtUp: { months: number; amount: string; into: string } | null }>("/api/spreading/items", { method: "POST", body });
        setItemKey(newIdempotencyKey("spread"));
        setMessage(`${line.description} is on the Spreading worksheet.${caughtUpText(made.caughtUp)}`);
      }
      setOpen(null);
      found.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={isCost ? "Paid for ahead?" : invoiceId ? "Invoiced ahead?" : "Paid ahead?"}
      description={`${
        isCost
          ? `Spread a line over the months it covers. Its cost without GST waits in ${holding.code} ${holding.name} and each month takes its share.`
          : `Spread a line over the months you earn it. Its amount without GST waits in ${holding.code} ${holding.name} and each month takes its share.`
      }${accruals.length > 0 ? (isCost ? " Or say it's the bill for something on Not billed yet." : " Or say it's for something on Not invoiced yet.") : ""}`}
    >
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ul className={styles.sourceLines}>
        {lines.map((line) => (
          <li key={line.lineId}>
            <div className={styles.sourceLine}>
              <span>
                {line.description} · <Money value={line.amount} />
                <span className={ui.muted}>
                  {" "}
                  · {line.accountCode} {line.accountName}
                </span>
              </span>
              {line.itemId ? (
                <Link href="/operations/spreading">On the Spreading worksheet</Link>
              ) : can("bookkeeper") && open !== line.lineId ? (
                <span className={styles.rowActions}>
                  <Button size="small" variant="secondary" onClick={() => start(line, "spread")}>
                    Spread this
                  </Button>
                  {accruals.length > 0 ? (
                    <Button size="small" variant="secondary" onClick={() => start(line, "accrual")}>
                      {isCost ? "It's for something not billed yet" : "It's for something not invoiced yet"}
                    </Button>
                  ) : null}
                </span>
              ) : null}
            </div>
            {open === line.lineId && mode === "accrual" ? (
              <div className={styles.sourceForm}>
                <div className={styles.form}>
                  <Field label="Which one" hint="It's marked at this line's amount, and any difference goes in the month's journal.">
                    <select value={accrualId} onChange={(event) => setAccrualId(event.target.value)}>
                      {accruals.map((accrual) => (
                        <option key={accrual.id} value={accrual.id}>
                          {accrual.description} ({accrual.accrued} so far)
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div className={styles.rowActions}>
                  <Button disabled={busy || !accrualId} onClick={() => void save(line)}>
                    Save
                  </Button>
                  <Button variant="secondary" onClick={() => setOpen(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
            {open === line.lineId && mode === "spread" ? (
              <div className={styles.sourceForm}>
                <div className={styles.form}>
                  <Field label="How">
                    <select value={method} onChange={(event) => setMethod(event.target.value as SpreadMethod)}>
                      {METHODS.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {dated ? (
                    <>
                      <Field label="Covers from">
                        <DateInput value={startDate} onChange={(event) => setStartDate(event.target.value)} />
                      </Field>
                      <Field label="To">
                        <DateInput value={endDate} onChange={(event) => setEndDate(event.target.value)} />
                      </Field>
                    </>
                  ) : null}
                  {method === "one_month" ? (
                    <Field label="Month">
                      <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
                    </Field>
                  ) : null}
                </div>
                {method === "when_done" ? <p className={ui.muted}>It waits until you mark it done on the worksheet. Then all of it lands in that month.</p> : null}
                <div className={styles.rowActions}>
                  <Button disabled={busy || (dated && (!startDate || !endDate)) || (method === "one_month" && !month)} onClick={() => void save(line)}>
                    Spread it
                  </Button>
                  <Button variant="secondary" onClick={() => setOpen(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
