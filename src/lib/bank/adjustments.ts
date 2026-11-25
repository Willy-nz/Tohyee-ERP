import type { OrgTx } from "@/lib/db/org-transaction";

/**
 * The adjustment a reconciliation posted itself (BK24, BK25): the spend or
 * receive money for the difference when a line was matched, or paid
 * invoices or bills, for a little more or less. It's keyed under the
 * reconciliation's own key, so a spend or receive money posted some other
 * way and only matched to the line is never taken for it. Null when the
 * reconciliation made none.
 */
export async function reconciliationAdjustment(
  tx: OrgTx,
  reconciliationId: string,
): Promise<{ id: string; status: string; reference: string | null } | null> {
  const found = await tx.query<{ id: string; status: string; reference: string | null }>(
    `select t.id::text, t.status, t.reference
       from bank_reconciliations r
       join bank_transactions t on t.command_source = r.command_source and t.idempotency_key = r.idempotency_key || ':adjustment'
      where r.id = $1
        and exists (select 1 from bank_reconciliation_items i join ledger_journal_lines l on l.id = i.journal_line_id
                     where i.reconciliation_id = r.id and l.journal_id = t.journal_id)`,
    [reconciliationId],
  );
  return found.rows[0] ?? null;
}
