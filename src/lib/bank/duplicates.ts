import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError } from "@/lib/errors";
import { formatDate, formatMoney } from "@/lib/format";
import { dec, toFixedString } from "@/lib/money/decimal";
import { requireId } from "@/lib/validation";

/**
 * BKF1: a line flagged as a possible duplicate of a line that's still there
 * (not excluded) waits for a person to look at it. Batches and bank rules
 * applied by an AI leave it alone. A retry of a line already done passes.
 */
export async function assertNotPossibleDuplicate(tx: OrgTx, lineIdInput: unknown): Promise<void> {
  const lineId = requireId(lineIdInput, "lineId");
  const found = await tx.query<{ other: string; other_date: string; other_amount: string }>(
    `select d.id::text as other, d.line_date::text as other_date, d.amount::text as other_amount
       from bank_statement_lines b join bank_statement_lines d on d.id = b.possible_duplicate_of
      where b.id = $1 and b.status = 'unreconciled' and d.status in ('unreconciled', 'reconciled')`,
    [lineId],
  );
  const other = found.rows[0];
  if (other) {
    throw new ConflictError(
      `This line may be a duplicate of line ${other.other} (${formatDate(other.other_date)}, ${formatMoney(toFixedString(dec(other.other_amount), 2))}). A person needs to check it: exclude it if it's a duplicate, or reconcile it by hand if it isn't.`,
    );
  }
}
