import type { OrgTx } from "@/lib/db/org-transaction";
import { parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { type Decimal, dec, isPositive, isZero, neg, sub, toFixedString } from "@/lib/money/decimal";

/*
 * What a Sales when sent order holds, line by line (SWS1-SWS14, SPF13-SPF19),
 * and the journals that move it in and out of Income in advance. Shared by
 * counting what's sent (when-sent.ts) and reversing a cancelled shipment
 * (sent-cancelled.ts).
 */

export const SCALE = 2;
export const SOURCE = "sales-platform";

/** One line an order holds, as stored. */
export type HeldRow = {
  id: string;
  line_kind: "line" | "shipping";
  line_external_id: string;
  description: string;
  item_code: string | null;
  item_type: string | null;
  income_code: string;
  held_code: string;
  quantity: string;
  amount: string;
  sent_quantity: string;
  refunded_quantity: string;
  recognised_amount: string;
  refunded_amount: string;
  closed: boolean;
  stock_out_item_id: string | null;
};

export async function loadHeld(tx: OrgTx, connectionId: string, orderId: string): Promise<HeldRow[]> {
  const result = await tx.query<HeldRow>(
    `select h.id, h.line_kind, h.line_external_id, h.description, i.code as item_code, i.item_type, income.code as income_code, held.code as held_code,
            h.quantity::text, h.amount::text, h.sent_quantity::text, h.refunded_quantity::text, h.recognised_amount::text, h.refunded_amount::text, h.closed, h.stock_out_item_id::text
       from sales_platform_held_lines h
       join accounts income on income.id = h.income_account_id
       join accounts held on held.id = h.held_account_id
       left join items i on i.id = h.item_id
      where h.connection_id = $1 and h.order_external_id = $2
      order by h.id
      for update of h`,
    [connectionId, orderId],
  );
  return result.rows;
}

export const left = (row: HeldRow): Decimal => sub(sub(dec(row.quantity), dec(row.sent_quantity)), dec(row.refunded_quantity));
export const stillHeld = (row: HeldRow): Decimal => sub(sub(dec(row.amount), dec(row.recognised_amount)), dec(row.refunded_amount));

export type Move = { from: string; to: string; amount: Decimal; description: string };

/** Posts the moves out of Income in advance as one journal (origin sales_when_sent), or nothing when they come to nothing. */
export async function postMoves(tx: OrgTx, key: string, date: string, reference: string, description: string, moves: readonly Move[]): Promise<string | null> {
  const lines: Array<{ accountCode: string; debitAmount: string; creditAmount: string; description: string }> = [];
  for (const move of moves) {
    if (isZero(move.amount)) continue;
    const amount = toFixedString(isPositive(move.amount) ? move.amount : neg(move.amount), SCALE);
    const [debit, credit] = isPositive(move.amount) ? [move.from, move.to] : [move.to, move.from];
    lines.push({ accountCode: debit, debitAmount: amount, creditAmount: "0", description: move.description });
    lines.push({ accountCode: credit, debitAmount: "0", creditAmount: amount, description: move.description });
  }
  if (lines.length === 0) return null;
  const posted = await postJournalBody(
    tx,
    SOURCE,
    key,
    parseJournalBody(tx, { postingDate: date, reference: reference.slice(0, 100), description: description.slice(0, 500), lines }, { internal: true }),
    { origin: "sales_when_sent" },
  );
  return posted.journal.id;
}

export async function saveRows(tx: OrgTx, rows: readonly HeldRow[]): Promise<void> {
  for (const row of rows) {
    await tx.query(
      `update sales_platform_held_lines set sent_quantity = $2::numeric, refunded_quantity = $3::numeric, recognised_amount = $4::numeric,
              refunded_amount = $5::numeric, closed = $6, updated_at = now() where id = $1`,
      [row.id, row.sent_quantity, row.refunded_quantity, row.recognised_amount, row.refunded_amount, row.closed],
    );
  }
}
