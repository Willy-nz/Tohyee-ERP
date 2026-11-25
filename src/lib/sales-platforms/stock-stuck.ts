import type { OrgTx } from "@/lib/db/org-transaction";
import { writeAuditEvent } from "@/lib/audit";
import { updateItem } from "@/lib/items/service";
import { requireId } from "@/lib/validation";

/*
 * Orders stuck on "no stock on hand" (SSD2-SSD3, the owner's issue 6): one warning on the store's settings instead of a log line per
 * order, with a fix. Making the store's stock items that have never moved
 * stock into non-stock items lets the next sync invoice the orders; turning
 * on negative stock is the other way, in Settings.
 */

export type StockStuck = { orders: Array<{ orderId: string; name: string | null }>; items: Array<{ id: string; code: string; name: string }> };

/** What a stock refusal says: no stock (or not enough) to take out, or a date before the item's latest movement. */
const STUCK = ["%no stock on hand%", "%Stock can't go negative%", "%Backdated stock movements%"];

/**
 * The store's orders whose last try failed on stock, and its stock items
 * that could become non-stock. That's orders not yet invoiced, and (SPF1)
 * orders under Sales when sent whose fulfilment couldn't take the stock out.
 */
export async function stockStuck(tx: OrgTx, connectionIdInput: unknown): Promise<StockStuck> {
  const connectionId = requireId(connectionIdInput, "connectionId");
  const orders = await tx.query<{ order_id: string; name: string | null }>(
    `select d.external_id as order_id, d.name from sales_platform_documents d
      where d.connection_id = $1 and d.record_kind = 'order' and d.state <> 'cancelled' and (d.invoice_id is null or d.sales_when_sent)
        and (select l.message from sales_platform_sync_log l
              where l.connection_id = d.connection_id and l.record_kind = 'order' and l.external_id = d.external_id
              order by l.id desc limit 1) ilike any($2::text[])
      order by d.external_id`,
    [connectionId, STUCK],
  );
  if (orders.rows.length === 0) return { orders: [], items: [] };
  const items = await tx.query<{ id: string; code: string; name: string }>(
    `select distinct i.id::text, i.code, i.name from sales_platform_mappings m join items i on i.id = m.item_id
      where m.connection_id = $1 and m.record_kind = 'product_variant' and i.item_type = 'stock'
        and not exists (select 1 from inventory_movements v where v.item_code = i.code)
      order by i.code`,
    [connectionId],
  );
  return { orders: orders.rows.map((row) => ({ orderId: row.order_id, name: row.name })), items: items.rows };
}

/**
 * SSD3: makes those items non-stock, stops new tracked products coming in as
 * stock for this store, and has the next sync try the orders again.
 */
export async function makeStoreItemsNonStock(tx: OrgTx, connectionIdInput: unknown): Promise<{ items: number; orders: number }> {
  const connectionId = requireId(connectionIdInput, "connectionId");
  const stuck = await stockStuck(tx, connectionId);
  for (const item of stuck.items) await updateItem(tx, item.id, { itemType: "non_stock" });
  await tx.query("update sales_platform_connections set stock_items = false where id = $1", [connectionId]);
  if (stuck.orders.length > 0) {
    await tx.query("update sales_platform_documents set retry = true, updated_at = now() where connection_id = $1 and record_kind = 'order' and external_id = any($2::text[])", [
      connectionId,
      stuck.orders.map((order) => order.orderId),
    ]);
  }
  await writeAuditEvent(tx, {
    eventType: "sales_platform.items_made_non_stock",
    entityType: "sales_platform_connection",
    entityId: connectionId,
    details: { items: stuck.items.map((item) => item.code), orders: stuck.orders.length },
  });
  return { items: stuck.items.length, orders: stuck.orders.length };
}
