"use client";

import { type FormEvent, useState } from "react";
import { Money } from "@/components/books";
import { Button, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import { dec, isPositive, parseDecimalInput, toFixedString } from "@/lib/money/decimal";
import { addBackAmount, LEAVE_ADD_BACK_LABEL, LEAVE_REVERSAL_LABEL, reversalAmount } from "@/lib/tax/income/leave-add-back";
import type { Status, Supported } from "@/components/income-tax/shared";

/**
 * Leave owed at balance date and the 63-day rule (TXF4). Tohyee shows the
 * figures; a person types what was paid by the 63rd day and adds the
 * adjustments. Nothing is added by itself.
 */
export function LeaveAddBackPanel({ organisationId, report, onSaved }: { organisationId: string; report: Supported; onSaved: () => void }) {
  const suggestion = report.leaveAddBack;
  const [paid, setPaid] = useState("0.00");
  const [key, setKey] = useState(() => newIdempotencyKey("tax-leave"));
  const [reversalKey, setReversalKey] = useState(() => newIdempotencyKey("tax-leave-back"));
  const [status, setStatus] = useState<Status>(null);
  if (!suggestion) return null;
  const owed = dec(suggestion.owedAtYearEnd);
  const showAddBack = isPositive(owed) && !suggestion.addBackAdded;
  const showReversal = isPositive(dec(suggestion.lastYearAddBack)) && !suggestion.reversalAdded;
  if (!showAddBack && !showReversal) return null;
  async function addBack(event: FormEvent) {
    event.preventDefault();
    try {
      const paidAmount = dec(parseDecimalInput(paid, "Paid by the 63rd day", { maxScale: 2, allowZero: true }));
      const amount = addBackAmount(owed, paidAmount);
      if (!isPositive(amount)) {
        setStatus({ tone: "success", text: "All of it was paid within 63 days, so there's nothing to add back." });
        return;
      }
      await api("/api/income-tax/adjustments", { method: "POST", body: { organisationId, idempotencyKey: key, incomeYear: report.incomeYear, description: LEAVE_ADD_BACK_LABEL, amount: toFixedString(amount, 2) } });
      setKey(newIdempotencyKey("tax-leave"));
      setStatus(null);
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  async function addReversal() {
    if (!suggestion) return;
    try {
      await api("/api/income-tax/adjustments", {
        method: "POST",
        body: { organisationId, idempotencyKey: reversalKey, incomeYear: report.incomeYear, description: LEAVE_REVERSAL_LABEL, amount: toFixedString(reversalAmount(suggestion), 2) },
      });
      setReversalKey(newIdempotencyKey("tax-leave-back"));
      setStatus(null);
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  return (
    <section>
      <h3>Leave owed at balance date</h3>
      {showAddBack ? (
        <>
          <p>
            {suggestion.accountCode} {suggestion.accountName} has <Money value={suggestion.owedAtYearEnd} /> of leave owed at {formatDate(suggestion.yearEnd)}. Leave not paid by{" "}
            {formatDate(suggestion.payBy)} (63 days later) is deducted next year instead. Check your pay runs for what was paid by then.
          </p>
          <form className={ui.inlineForm} onSubmit={addBack}>
            <Field label={`Paid by ${formatDate(suggestion.payBy)}`} hint="Leave owed at balance date that was paid out by this date.">
              <input inputMode="decimal" value={paid} onChange={(event) => setPaid(event.target.value)} required />
            </Field>
            <Button type="submit" variant="secondary">
              Add the rest back
            </Button>
          </form>
        </>
      ) : null}
      {showReversal ? (
        <p>
          Last year <Money value={suggestion.lastYearAddBack} /> of leave was added back. It&apos;s deductible this year.{" "}
          <Button size="small" variant="secondary" onClick={() => void addReversal()}>
            Deduct it this year
          </Button>
        </p>
      ) : null}
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </section>
  );
}
