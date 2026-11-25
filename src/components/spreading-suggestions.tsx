"use client";

import Link from "next/link";
import { useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Button, Card, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import { SPREAD_KIND_LABELS } from "@/lib/spreading/rules";
import type { AccrualSuggestion, LineSuggestion, SpreadSuggestions } from "@/lib/spreading/suggestions";
import type { Send } from "./spreading-shared";
import styles from "./spreading.module.css";

const LINE_KEY = { bill: "billLineId", invoice: "invoiceLineId", bank: "bankLineId" } as const;

function monthSaid(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-NZ", { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * What Tohyee has noticed (SW26-SW28): lines that say they cover a period,
 * and regular bills that haven't come. Each is added only when someone
 * presses Add, and then it's an ordinary item.
 */
export function SpreadingSuggestions({ organisationId, canEdit, busy, send }: { organisationId: string; canEdit: boolean; busy: boolean; send: Send }) {
  const loaded = useApiData<{ suggestions: SpreadSuggestions }>("/api/spreading/suggestions", { organisationId });
  // One key a suggestion, so pressing Add twice adds it once.
  const [keys] = useState(() => new Map<string, string>());
  const [error, setError] = useState<string | null>(null);
  const [hiding, setHiding] = useState(false);
  const found = loaded.data?.suggestions;
  if (!found || found.lines.length + found.accruals.length === 0) return null;

  const keyFor = (suggestion: string) => {
    if (!keys.has(suggestion)) keys.set(suggestion, newIdempotencyKey());
    return keys.get(suggestion)!;
  };

  async function addLine(line: LineSuggestion) {
    const added = await send(
      "POST",
      "/api/spreading/items",
      { idempotencyKey: keyFor(line.key), method: "by_month", [LINE_KEY[line.sourceKind]]: line.lineId, startDate: line.startDate, endDate: line.endDate },
      `Added: ${line.description || line.label} is spread over ${line.months} months.`,
    );
    if (added) loaded.reload();
  }

  async function addAccrual(accrual: AccrualSuggestion) {
    const added = await send(
      "POST",
      "/api/spreading/items",
      { idempotencyKey: keyFor(accrual.key), kind: "accrued_expense", description: accrual.description, amount: accrual.amount, targetAccountCode: accrual.accountCode, method: "one_month", month: accrual.month, contactId: accrual.contactId },
      `Added to Not billed yet for ${monthSaid(accrual.month)}. Post the month when you're ready.`,
    );
    if (added) loaded.reload();
  }

  async function dismiss(key: string) {
    setHiding(true);
    setError(null);
    try {
      await api("/api/spreading/suggestions/dismiss", { method: "POST", body: { organisationId, key } });
      loaded.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setHiding(false);
    }
  }

  const actions = (add: () => void, key: string) =>
    canEdit ? (
      <span className={styles.suggestionActions}>
        <Button size="small" disabled={busy || hiding} onClick={add}>
          Add
        </Button>
        <Button size="small" variant="secondary" disabled={busy || hiding} onClick={() => dismiss(key)}>
          Not this one
        </Button>
      </span>
    ) : null;

  return (
    <Card title={`Suggested (${found.lines.length + found.accruals.length})`}>
      <p className={ui.muted}>Things Tohyee noticed. Nothing is added until you press Add, and you can change or remove it afterwards.</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ul className={styles.suggestions}>
        {found.lines.map((line) => (
          <li key={line.key}>
            <div>
              <strong>{line.description || line.label}</strong> <Money value={line.amount} />
              <div className={ui.muted}>
                {line.sourceKind === "bill" ? (
                  <Link href={`/operations/bills/${line.documentId}`}>{line.label}</Link>
                ) : line.sourceKind === "invoice" ? (
                  <Link href={`/operations/invoices/${line.documentId}`}>{line.label}</Link>
                ) : (
                  line.label
                )}
                , {formatDate(line.date)}. It says &ldquo;{line.because}&rdquo;, so: {SPREAD_KIND_LABELS[line.kind].toLowerCase()}, {formatDate(line.startDate)} to {formatDate(line.endDate)} ({line.months} months).
              </div>
            </div>
            {actions(() => addLine(line), line.key)}
          </li>
        ))}
        {found.accruals.map((accrual) => (
          <li key={accrual.key}>
            <div>
              <strong>
                No {accrual.accountName} bill from {accrual.contactName} for {monthSaid(accrual.month)}
              </strong>{" "}
              <Money value={accrual.amount} />
              <div className={ui.muted}>
                They billed {accrual.history.map((row) => Number(row.amount).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })).join(", then ")} in the three months before. Add the average as not billed yet, and mark it arrived when the bill comes.
              </div>
            </div>
            {actions(() => addAccrual(accrual), accrual.key)}
          </li>
        ))}
      </ul>
    </Card>
  );
}
