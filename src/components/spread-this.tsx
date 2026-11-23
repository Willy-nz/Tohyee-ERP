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

export function SpreadThisCard({ organisationId, billId, invoiceId }: { organisationId: string; billId?: string; invoiceId?: string }) {
  const { can } = useWorkspace();
  const found = useApiData<{ holding: SpreadAccount | null; lines: SourceLine[] }>("/api/spreading/lines", { organisationId, billId: billId ?? null, invoiceId: invoiceId ?? null });
  const [open, setOpen] = useState<string | null>(null);
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
  if (!holding || lines.length === 0) return null;
  const isBill = Boolean(billId);
  const dated = method === "by_month" || method === "by_days";

  function start(line: SourceLine) {
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
      const body: Record<string, unknown> = { organisationId, source: "ui", idempotencyKey: itemKey, method, [isBill ? "billLineId" : "invoiceLineId"]: line.lineId };
      if (dated) Object.assign(body, { startDate, endDate });
      if (method === "one_month") body.month = month;
      await api("/api/spreading/items", { method: "POST", body });
      setItemKey(newIdempotencyKey("spread"));
      setOpen(null);
      setMessage(`${line.description} is on the Spreading worksheet.`);
      found.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={isBill ? "Paid for ahead?" : "Invoiced ahead?"}
      description={
        isBill
          ? `Spread a line over the months it covers. Its cost without GST waits in ${holding.code} ${holding.name} and each month takes its share.`
          : `Spread a line over the months you earn it. Its amount without GST waits in ${holding.code} ${holding.name} and each month takes its share.`
      }
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
                <Button size="small" variant="secondary" onClick={() => start(line)}>
                  Spread this
                </Button>
              ) : null}
            </div>
            {open === line.lineId ? (
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
