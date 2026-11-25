import { writeAuditEvent } from "@/lib/audit";
import { parseOptionalIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { addDays, financialYearStart } from "@/lib/financial-year";
import { formatDate } from "@/lib/format";
import { optionalString } from "@/lib/validation";

/**
 * The lock date: nothing can be posted on or before it. Closing a period on
 * Period close moves it to the period's last day; reopening moves it back
 * (L1-L4, PC1-PC12). The database refuses journals dated on or before it too.
 */
export type PeriodControls = {
  lockDate: string | null;
  updatedAt: string;
};

type ControlsRow = {
  lock_date: string | null;
  updated_at: string;
};

function toControls(row: ControlsRow): PeriodControls {
  return { lockDate: row.lock_date, updatedAt: row.updated_at };
}

export async function getPeriodControls(tx: OrgTx, options: { forUpdate?: boolean; forShare?: boolean } = {}): Promise<PeriodControls> {
  const lock = options.forUpdate ? " for update" : options.forShare ? " for share" : "";
  const result = await tx.query<ControlsRow>(
    `select lock_date::text as lock_date, updated_at from accounting_period_controls where id = true${lock}`,
  );
  return toControls(result.rows[0]);
}

/**
 * Postings dated on or before the lock date are refused. Dates are compared
 * as YYYY-MM-DD strings, which sort the same way as the dates themselves.
 */
export async function assertPostingDateAllowed(tx: OrgTx, postingDate: string): Promise<void> {
  // BKF5: read "for share", as the database does for journals, so a period
  // close waits for this transaction (and this waits for a close in
  // progress). That covers what posts no journal: credit and overpayment
  // applications, matching. A read-only transaction can't change anything,
  // so it needn't (and can't) take the lock.
  const readOnly = (await tx.query<{ value: string }>("select current_setting('transaction_read_only') as value")).rows[0]?.value === "on";
  const controls = await getPeriodControls(tx, { forShare: !readOnly });
  if (!controls.lockDate || postingDate > controls.lockDate) {
    return;
  }
  throw new ValidationError(
    `${postingDate} is in a locked period (locked up to ${controls.lockDate}). Use a later date, or ask an owner or admin to reopen the period on Period close.`,
  );
}

/**
 * Moves the lock date (admins). Moving it later locks more and needs nothing
 * else; moving it earlier, or clearing it, reopens periods and needs a
 * reason, like reopening on Period close. Used by the import's final step
 * (lock up to the conversion date). Both are in the audit log.
 */
export async function updatePeriodControls(
  tx: OrgTx,
  input: { lockDate?: unknown; reason?: unknown },
): Promise<PeriodControls> {
  const current = await getPeriodControls(tx, { forUpdate: true });
  if (!Object.prototype.hasOwnProperty.call(input, "lockDate")) {
    return current;
  }
  const lockDate = parseOptionalIsoDate(input.lockDate, "lockDate");
  if (lockDate === current.lockDate) {
    return current;
  }
  const reopening = current.lockDate !== null && (lockDate === null || lockDate < current.lockDate);
  const reason = optionalString(input.reason, "reason", { maxLength: 500 });
  if (reopening && !reason) {
    throw new ValidationError("Say why the period is being reopened (reason).");
  }
  return setLockDate(tx, current, lockDate, reopening ? { eventType: "ledger.period_reopened", details: { reason } } : { eventType: "ledger.period_locked", details: {} });
}

/** Writes a new lock date and its audit event. */
export async function setLockDate(
  tx: OrgTx,
  current: PeriodControls,
  lockDate: string | null,
  event: { eventType: string; details: Record<string, unknown> },
): Promise<PeriodControls> {
  const result = await tx.query<ControlsRow>(
    `update accounting_period_controls
        set lock_date = $1, updated_at = now()
      where id = true
      returning lock_date::text as lock_date, updated_at`,
    [lockDate],
  );
  await writeAuditEvent(tx, {
    eventType: event.eventType,
    entityType: "accounting_period_controls",
    entityId: "1",
    details: { ...event.details, from: { lockDate: current.lockDate }, to: { lockDate } },
  });
  return toControls(result.rows[0]);
}

/**
 * The financial year end can't change while a financial year with postings
 * is closed (YE4): its retained earnings and current year earnings would
 * move. Reopen it first.
 */
export async function assertFinancialYearEndChangeable(tx: OrgTx, currentYearEndMonth: number): Promise<void> {
  const { lockDate } = await getPeriodControls(tx);
  if (lockDate === null) return;
  const lastClosedYearEnd = addDays(financialYearStart(addDays(lockDate, 1), currentYearEndMonth), -1);
  const posted = await tx.query<{ found: boolean }>("select exists (select 1 from ledger_journals where posting_date <= $1) as found", [lastClosedYearEnd]);
  if (posted.rows[0].found) {
    throw new ValidationError(
      `The financial year ending ${formatDate(lastClosedYearEnd)} is closed, so the financial year end can't change. Reopen it on Period close first.`,
    );
  }
}
