import type { OrgTx } from "@/lib/db/org-transaction";
import { addDays } from "@/lib/financial-year";
import { formatDate } from "@/lib/format";
import { postMovement } from "@/lib/inventory/movements";
import { loadStockContext } from "@/lib/inventory/stock";
import { getPeriodControls } from "@/lib/ledger/period-controls";
import { cmp, dec, type Decimal, isPositive, isZero, mulDiv, sub, sum, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import type { PlatformOrder, PlatformSent } from "@/lib/sales-platforms/connector";
import { type HeldRow, left, type Move, postMoves, SCALE, SOURCE } from "@/lib/sales-platforms/held-rows";

/*
 * A Shopify fulfilment (a shipment) cancelled after Sales when sent counted
 * it (SPF13-SPF19, the owner's decision of 26 Nov 2026). What counting it did
 * is undone: each line's share goes from sales back to Income in advance, and
 * stock it took out comes back at the cost it went out at. GST isn't touched:
 * it was counted on the invoice, which still stands. Dated the day it was
 * counted, or the earliest day the lock date allows. Each fulfilment is
 * reversed once; sent again later, it's a new fulfilment and counts as usual.
 */

const QUANTITY_SCALE = 4;

/** The key a fulfilment's counting posts under (its journal and stock movements). */
export function sentKey(storeDomain: string, fulfilmentId: string): string {
  return `sp:${storeDomain}:sent:${fulfilmentId}`.slice(0, 120);
}

type SentRecord = { id: string; journal_id: string | null; lines_recorded: boolean; counted_on: string };

const minimum = (a: Decimal, b: Decimal): Decimal => (cmp(a, b) <= 0 ? a : b);
const notBelowZero = (value: Decimal): Decimal => (isPositive(value) ? value : ZERO_DECIMAL);
const plural = (quantity: Decimal, description: string) => `${toPlainString(quantity)} ${description}`;

/**
 * Reverses a counted fulfilment Shopify has cancelled. Updates `rows` in place
 * (the caller saves them). Returns the sync log's words, or null when it was
 * already reversed.
 */
export async function reverseCancelled(
  tx: OrgTx,
  input: { connectionId: string; storeDomain: string; order: PlatformOrder; fulfilment: PlatformSent; rows: HeldRow[] },
): Promise<string | null> {
  const { order, fulfilment, rows } = input;
  const found = await tx.query<SentRecord>(
    `select s.id::text, s.journal_id::text, s.lines_recorded, coalesce(j.posting_date, s.sent_on)::text as counted_on
       from sales_platform_sent s left join ledger_journals j on j.id = s.journal_id
      where s.connection_id = $1 and s.fulfilment_external_id = $2 and s.reversed_at is null
      for update of s`,
    [input.connectionId, fulfilment.externalId],
  );
  const sent = found.rows[0];
  if (!sent) return null;
  const what = `${order.name}: shipment ${fulfilment.externalId} was cancelled in Shopify`;

  // What counting it did, line by line. Before SPF13 that wasn't recorded: each line's average counted per item.
  const counted: Array<{ row: HeldRow; quantity: Decimal; amount: Decimal }> = [];
  if (sent.lines_recorded) {
    const lines = await tx.query<{ held_line_id: string; quantity: string; amount: string }>(
      "select held_line_id::text, quantity::text, amount::text from sales_platform_sent_lines where sent_id = $1 order by id",
      [sent.id],
    );
    for (const line of lines.rows) {
      const row = rows.find((entry) => entry.id === line.held_line_id);
      if (row && row.line_kind === "line") counted.push({ row, quantity: dec(line.quantity), amount: dec(line.amount) });
    }
  } else if (sent.journal_id !== null) {
    for (const line of fulfilment.lines) {
      const row = rows.find((entry) => entry.line_kind === "line" && entry.line_external_id === line.lineItemId);
      if (!row || !isPositive(dec(row.sent_quantity))) continue;
      const quantity = minimum(dec(line.quantity), dec(row.sent_quantity));
      counted.push({ row, quantity, amount: mulDiv(dec(row.recognised_amount), quantity, dec(row.sent_quantity), SCALE) });
    }
  }

  // SPF18: what's been refunded from sales (refunds posted while it counted as sent) isn't reversed again.
  const posted = await tx.query<{ external_id: string }>(
    "select external_id from sales_platform_documents where connection_id = $1 and record_kind = 'refund' and order_external_id = $2 and credit_note_id is not null",
    [input.connectionId, order.externalId],
  );
  const postedIds = new Set(posted.rows.map((row) => row.external_id));
  const postedRefunds = order.refunds.filter((refund) => postedIds.has(refund.externalId));
  const refundedOf = (lineId: string): Decimal =>
    sum(postedRefunds.flatMap((refund) => refund.lines.filter((line) => line.lineItemId === lineId).map((line) => dec(line.quantity))));

  const moves: Move[] = [];
  const back: string[] = [];
  const refunded: string[] = [];
  const stock: Array<{ row: HeldRow; quantity: Decimal }> = [];
  for (const entry of counted) {
    const { row } = entry;
    if (!isPositive(entry.quantity)) continue;
    const fromSales = notBelowZero(sub(refundedOf(row.line_external_id), dec(row.refunded_quantity)));
    const quantity = notBelowZero(minimum(entry.quantity, sub(dec(row.sent_quantity), fromSales)));
    if (cmp(quantity, entry.quantity) < 0) refunded.push(row.description);
    if (!isPositive(quantity)) continue;
    const amount = cmp(quantity, entry.quantity) === 0 ? entry.amount : mulDiv(entry.amount, quantity, entry.quantity, SCALE);
    moves.push({ from: row.income_code, to: row.held_code, amount, description: `${row.description}: shipment cancelled, not sent` });
    row.sent_quantity = toPlainString(sub(dec(row.sent_quantity), quantity));
    row.recognised_amount = toFixedString(sub(dec(row.recognised_amount), amount), SCALE);
    if (isPositive(left(row))) row.closed = false;
    if (row.item_code && (row.item_type === "stock" || row.item_type === "kit")) {
      stock.push({ row, quantity });
      back.push(plural(quantity, row.description));
    }
  }

  // The shipping counted with the first thing sent: it goes back once no counted shipment is left standing.
  const standing = await tx.query(
    `select 1 from sales_platform_sent s
      where s.connection_id = $1 and s.order_external_id = $2 and s.id <> $3 and s.reversed_at is null
        and (case when s.lines_recorded then exists (select 1 from sales_platform_sent_lines l join sales_platform_held_lines h on h.id = l.held_line_id
                                                     where l.sent_id = s.id and h.line_kind = 'line' and l.quantity > 0)
                  else s.journal_id is not null end)
      limit 1`,
    [input.connectionId, order.externalId, sent.id],
  );
  const shippingRefunded = postedRefunds.some((refund) => refund.shipping.some((line) => !isZero(dec(line.subtotal))));
  if (standing.rowCount === 0) {
    for (const row of rows) {
      if (row.line_kind !== "shipping" || !isPositive(dec(row.sent_quantity)) || isPositive(dec(row.refunded_quantity))) continue;
      if (shippingRefunded && isZero(dec(row.refunded_amount))) continue;
      const amount = dec(row.recognised_amount);
      if (!isZero(amount)) moves.push({ from: row.income_code, to: row.held_code, amount, description: `${row.description}: shipment cancelled, not sent` });
      row.sent_quantity = "0";
      row.recognised_amount = toFixedString(ZERO_DECIMAL, SCALE);
      row.closed = false;
    }
  }

  // Dated the day it was counted; never in a locked period (SPF17).
  const lock = (await getPeriodControls(tx)).lockDate;
  const date = lock !== null && sent.counted_on <= lock ? addDays(lock, 1) : sent.counted_on;
  const locked = date !== sent.counted_on ? ` It's dated ${formatDate(date)}, not ${formatDate(sent.counted_on)}, because the books are locked up to ${formatDate(lock)}.` : "";
  const key = `sp:${input.storeDomain}:sent-cancelled:${fulfilment.externalId}`.slice(0, 120);
  const total = sum(moves.map((move) => move.amount));
  const journalId = await postMoves(
    tx,
    `${key}:journal`,
    date,
    `${order.name} not sent`,
    `${order.name}: shipment ${fulfilment.externalId} cancelled in Shopify, so back to Income in advance.${locked}`,
    moves,
  );

  for (const entry of stock) {
    await returnSentStock(tx, {
      storeDomain: input.storeDomain,
      rowId: entry.row.id,
      quantity: entry.quantity,
      prefer: `${sentKey(input.storeDomain, fulfilment.externalId)}:stock:`,
      date,
      key: `${key}:stock`,
      reference: order.name,
      description: `${order.name}: ${entry.row.description} not sent (shipment cancelled in Shopify)`,
    });
  }

  await tx.query("update sales_platform_sent set reversed_at = now(), reversed_on = $2, reversal_journal_id = $3 where id = $1", [sent.id, date, journalId]);

  const refundedNote = refunded.length > 0 ? ` ${refunded.join(", ")} had been refunded already, so ${refunded.length === 1 ? "it isn't" : "they aren't"} reversed again.` : "";
  if (isZero(total) && stock.length === 0) {
    if (refunded.length > 0) return `${what}, but what it sent had been refunded already, so nothing is reversed.`;
    return `${what}, but it hadn't moved anything out of Income in advance (it was sent before Sales when sent applied to the order, or there was nothing left to send), so nothing is reversed. If its items are still to be sent, check the order.`;
  }
  const stockText = back.length > 0 ? `, and ${back.join(", ")} back into stock` : "";
  return `${what}, so what it sent is back to paid, still to send: ${toFixedString(total, SCALE)} moved from sales back to Income in advance${stockText}.${refundedNote}${locked}`;
}

/**
 * Puts back stock that went out when a held line was sent (SPF13, SPF18):
 * `quantity` of the line, against its sendings' stock movements (the one in
 * `prefer` first, then the newest), each no more than is still out, at the
 * cost it went out at. On `date`, or the earliest day allowed (SPF2).
 */
async function returnSentStock(
  tx: OrgTx,
  input: { storeDomain: string; rowId: string; quantity: Decimal; prefer: string; date: string; key: string; reference: string; description: string },
): Promise<void> {
  const issued = await tx.query<{ id: string; item_code: string; per: string; remaining: string; movement_date: string }>(
    `select m.id::text, m.item_code, m.movement_date::text,
            (abs(m.quantity_delta) - coalesce((select sum(r.quantity_delta) from inventory_movements r where r.original_movement_id = m.id), 0))::text as remaining,
            coalesce((select k.quantity from kit_components k join items c on c.id = k.component_item_id
                        join sales_platform_held_lines h on h.item_id = k.kit_item_id
                       where h.id = $3 and lower(c.code) = lower(m.item_code) limit 1), 1)::text as per
       from inventory_movements m
      where m.command_source = $1 and m.movement_type = 'issue' and left(m.idempotency_key, length($2)) = $2 and position($4 in m.idempotency_key) > 0
      order by left(m.idempotency_key, length($5)) = $5 desc, m.movement_date desc, m.id desc`,
    [SOURCE, `sp:${input.storeDomain}:`, input.rowId, `:stock:${input.rowId}:`, input.prefer],
  );
  if (issued.rows.length === 0) return;
  const ctx = await loadStockContext(tx, "Stock can't be put back for what wasn't sent");
  const needed = new Map<string, Decimal>();
  for (const movement of issued.rows) {
    if (!needed.has(movement.item_code)) needed.set(movement.item_code, mulDiv(input.quantity, dec(movement.per), dec("1"), QUANTITY_SCALE));
    const want = needed.get(movement.item_code)!;
    const quantity = minimum(want, dec(movement.remaining));
    if (!isPositive(quantity)) continue;
    needed.set(movement.item_code, sub(want, quantity));
    await postMovement(
      tx,
      {
        source: SOURCE,
        idempotencyKey: `${input.key}:${movement.id}`.slice(0, 200),
        movementType: "customer_return",
        movementDate: movement.movement_date > input.date ? movement.movement_date : input.date,
        itemCode: movement.item_code,
        reference: input.reference,
        description: input.description,
        inventoryAccountCode: ctx.inventoryCode,
        offsetAccountCode: ctx.costOfSalesCode,
        quantity: toPlainString(quantity),
        originalMovementId: movement.id,
      },
      // SPF2: stock that can't be backdated comes back on the earliest day allowed.
      { onEarliestDate: true },
    );
  }
}

/**
 * SPF18: a restocked refund of what was sent of a line held from the start.
 * Its stock left when it was sent, not with the invoice, so the credit note
 * carries no item and the stock comes back against what was sent, newest
 * first, at the cost it went out at, on the refund's day (or the earliest day
 * allowed).
 */
export async function restockSent(
  tx: OrgTx,
  input: { connectionId: string; storeDomain: string; order: PlatformOrder; refundId: string; date: string; lines: ReadonlyArray<{ lineId: string; quantity: string }> },
): Promise<void> {
  if (input.lines.length === 0) return;
  const lock = (await getPeriodControls(tx)).lockDate;
  const date = lock !== null && input.date <= lock ? addDays(lock, 1) : input.date;
  for (const line of input.lines) {
    const row = (
      await tx.query<{ id: string; description: string }>(
        "select id::text, description from sales_platform_held_lines where connection_id = $1 and order_external_id = $2 and line_kind = 'line' and line_external_id = $3",
        [input.connectionId, input.order.externalId, line.lineId],
      )
    ).rows[0];
    if (!row) continue;
    await returnSentStock(tx, {
      storeDomain: input.storeDomain,
      rowId: row.id,
      quantity: dec(line.quantity),
      prefer: "",
      date,
      key: `sp:${input.storeDomain}:refund-restock:${input.refundId}:${row.id}`,
      reference: input.order.name,
      description: `${input.order.name}: ${row.description} refunded and put back in stock`,
    });
  }
}
