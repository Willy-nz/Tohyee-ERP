import type { OrgTx } from "@/lib/db/org-transaction";
import { formatDate } from "@/lib/format";

/*
 * A payout's deposit already in the books by hand (SPF3-SPF4). Before a
 * payout is posted, Tohyee looks for its deposit on the bank account: the
 * same amount, within the payout's window (3 days before its date to 10
 * days after). Nothing here posts, voids or changes anything.
 */

/** How many days before and after a payout's date its deposit can be. */
export const DEPOSIT_DAYS_BEFORE = 3;
export const DEPOSIT_DAYS_AFTER = 10;

export type DepositInBooks =
  | { kind: "none" }
  /** A transfer from the clearing account to the bank for the payout's amount, made by hand: the payout links to it. */
  | { kind: "hand_transfer"; transferId: string; date: string }
  /** Something else that may be the deposit: a person decides. */
  | { kind: "unsure"; reason: string };

/**
 * Whether a payout's deposit (`amount` into `bankAccountCode` around `date`)
 * is already in the books: a posted transfer from the clearing account not
 * linked to any payout, or a reconciled statement line of that amount
 * reconciled to something else. Exactly one hand-made transfer and nothing
 * else is sure; anything more is unsure.
 */
export async function depositAlreadyInBooks(
  tx: OrgTx,
  input: { bankAccountCode: string; clearingAccountId: string; amount: string; date: string },
): Promise<DepositInBooks> {
  const transfers = await tx.query<{ id: string; transfer_date: string; journal_id: string }>(
    `select t.id::text, t.transfer_date::text, t.journal_id::text
       from bank_transfers t join accounts bank on bank.id = t.to_account_id
      where t.status = 'posted' and lower(bank.code) = lower($1) and t.from_account_id = $2 and t.amount = $3::numeric
        and t.transfer_date between $4::date - $5::int and $4::date + $6::int
        and not exists (select 1 from sales_platform_documents d where d.transfer_id = t.id)
      order by t.transfer_date, t.id`,
    [input.bankAccountCode, input.clearingAccountId, input.amount, input.date, DEPOSIT_DAYS_BEFORE, DEPOSIT_DAYS_AFTER],
  );
  // Statement lines of that amount already reconciled, other than to a payout's own transfer or to the transfers above.
  const lines = await tx.query<{ id: string; line_date: string; description: string; journal_ids: string[] }>(
    `select s.id::text, s.line_date::text, s.description,
            array_agg(distinct l.journal_id::text) as journal_ids
       from bank_statement_lines s
       join accounts bank on bank.id = s.account_id
       join bank_reconciliations r on r.statement_line_id = s.id and r.status = 'active'
       join bank_reconciliation_items i on i.reconciliation_id = r.id and i.active
       join ledger_journal_lines l on l.id = i.journal_line_id
      where lower(bank.code) = lower($1) and s.status = 'reconciled' and s.amount = $2::numeric
        and s.line_date between $3::date - $4::int and $3::date + $5::int
        and not exists (
          select 1 from bank_transfers pt join sales_platform_documents d on d.transfer_id = pt.id
           where pt.journal_id = l.journal_id)
      group by s.id, s.line_date, s.description
      order by s.line_date, s.id`,
    [input.bankAccountCode, input.amount, input.date, DEPOSIT_DAYS_BEFORE, DEPOSIT_DAYS_AFTER],
  );
  const transferJournals = new Set(transfers.rows.map((row) => row.journal_id));
  const otherLines = lines.rows.filter((line) => !line.journal_ids.every((id) => transferJournals.has(id)));
  if (transfers.rows.length === 0 && otherLines.length === 0) return { kind: "none" };
  if (transfers.rows.length === 1 && otherLines.length === 0) {
    return { kind: "hand_transfer", transferId: transfers.rows[0].id, date: transfers.rows[0].transfer_date };
  }
  const found = [
    ...transfers.rows.map((row) => `a transfer from the clearing account on ${formatDate(row.transfer_date)}`),
    ...otherLines.map((line) => `the statement line "${line.description}" on ${formatDate(line.line_date)}, already reconciled`),
  ];
  return {
    kind: "unsure",
    reason: `${input.amount} into ${input.bankAccountCode} may already be in the books: ${found.join("; ")}.`,
  };
}

export type PossibleDouble = {
  payoutId: string;
  amount: string;
  postedOn: string;
  transferId: string;
  /** The earlier hand-made transfer from the clearing account with the same amount. */
  handTransferId: string;
  handTransferDate: string;
  statementLine: { id: string; date: string; description: string } | null;
};

/**
 * Payouts posted before SPF3 that may have doubled a deposit (read-only):
 * a payout's transfer whose bank line isn't reconciled, beside a hand-made
 * transfer from the clearing account to the same bank, for the same amount,
 * within the payout's window, whose bank line is reconciled. Each is for a
 * person to check; nothing is voided or changed.
 */
export async function possibleDoublePayouts(tx: OrgTx, connectionId: string): Promise<PossibleDouble[]> {
  const result = await tx.query<{
    payout_id: string;
    amount: string;
    posted_on: string;
    transfer_id: string;
    hand_transfer_id: string;
    hand_date: string;
    statement_line_id: string | null;
    statement_date: string | null;
    statement_text: string | null;
  }>(
    `with payout_side as (
       select d.external_id as payout_id, t.id as transfer_id, t.transfer_date, t.amount,
              t.to_account_id as bank_account_id, t.from_account_id as clearing_account_id
         from sales_platform_documents d
         join bank_transfers t on t.id = d.transfer_id and t.status = 'posted'
         join ledger_journal_lines l on l.journal_id = t.journal_id and l.account_id = t.to_account_id
        where d.connection_id = $1 and d.record_kind = 'payout'
          and not exists (select 1 from bank_reconciliation_items i where i.journal_line_id = l.id and i.active)
     )
     select distinct on (p.payout_id, h.id)
            p.payout_id, to_char(p.amount, 'FM999999999990.00') as amount, p.transfer_date::text as posted_on, p.transfer_id::text,
            h.id::text as hand_transfer_id, h.transfer_date::text as hand_date,
            s.id::text as statement_line_id, s.line_date::text as statement_date, s.description as statement_text
       from payout_side p
       join bank_transfers h on h.status = 'posted' and h.to_account_id = p.bank_account_id and h.from_account_id = p.clearing_account_id
                            and h.amount = p.amount and h.id <> p.transfer_id
                            and h.transfer_date between p.transfer_date - $2::int and p.transfer_date + $3::int
                            and not exists (select 1 from sales_platform_documents d2 where d2.transfer_id = h.id)
       join ledger_journal_lines hl on hl.journal_id = h.journal_id and hl.account_id = h.to_account_id
       join bank_reconciliation_items i on i.journal_line_id = hl.id and i.active
       join bank_reconciliations r on r.id = i.reconciliation_id and r.status = 'active'
       left join bank_statement_lines s on s.id = r.statement_line_id
      order by p.payout_id, h.id`,
    [connectionId, DEPOSIT_DAYS_BEFORE, DEPOSIT_DAYS_AFTER],
  );
  return result.rows
    .map((row) => ({
      payoutId: row.payout_id,
      amount: row.amount,
      postedOn: row.posted_on,
      transferId: row.transfer_id,
      handTransferId: row.hand_transfer_id,
      handTransferDate: row.hand_date,
      statementLine: row.statement_line_id ? { id: row.statement_line_id, date: row.statement_date!, description: row.statement_text! } : null,
    }))
    .sort((a, b) => a.postedOn.localeCompare(b.postedOn) || a.payoutId.localeCompare(b.payoutId));
}

/** One plain line for the sync log and status about possible doubles, or null when there are none. */
export function possibleDoublesMessage(doubles: readonly PossibleDouble[], bankAccountCode: string | null): string | null {
  if (doubles.length === 0) return null;
  const listed = doubles
    .slice(0, 10)
    .map((entry) => `payout ${entry.payoutId} (${entry.amount}, ${formatDate(entry.postedOn)}) beside a transfer made by hand on ${formatDate(entry.handTransferDate)}`)
    .join("; ");
  const more = doubles.length > 10 ? `; and ${doubles.length - 10} more` : "";
  return `Check ${doubles.length === 1 ? "this payout" : `these ${doubles.length} payouts`}: each may have put its deposit into ${bankAccountCode ?? "the bank account"} a second time, because the same deposit was already entered by hand as a transfer from the clearing account: ${listed}${more}. If so, the bank account's balance is higher than the statement. Nothing has been changed; a person decides which entry to void.`;
}
