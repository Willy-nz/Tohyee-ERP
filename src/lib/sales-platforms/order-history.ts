import { isoDateAt } from "@/lib/dates";

/*
 * How far back a store's orders could be read (examples SPC47-SPC48).
 * Shopify gives an app without read_all_orders only the last 60 days of
 * orders, so a start date further back than that left the older orders
 * unread: they're in Shopify's payouts but never reached the books.
 */

/** Shopify's scope for orders older than its 60-day window. */
export const ALL_ORDERS_SCOPE = "read_all_orders";
/** How many days of orders Shopify gives an app without read_all_orders. */
export const SHOPIFY_ORDER_DAYS = 60;

type History = { platform: string; startDate: string | null; grantedScopes: string[]; ordersReadFrom: string | null };

export const readsAllOrders = (history: Pick<History, "platform" | "grantedScopes">): boolean =>
  history.platform !== "shopify" || history.grantedScopes.includes(ALL_ORDERS_SCOPE);

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The first day a read from scratch at `now` reaches: the start date, or Shopify's 60 days back when that's later. */
export function readableFrom(history: History, now: Date): string | null {
  if (!history.startDate) return null;
  if (readsAllOrders(history)) return history.startDate;
  const limit = shiftDays(isoDateAt(now), -SHOPIFY_ORDER_DAYS);
  return limit > history.startDate ? limit : history.startDate;
}

/**
 * Whether this sync should read every order from the start date again,
 * not just those changed since the last sync: never read yet, or a read
 * now reaches further back than before (read_all_orders added, or the
 * start date moved back within what can be read).
 */
export function needsFullRead(history: History, ordersSyncedUntil: string | null, now: Date): boolean {
  const reach = readableFrom(history, now);
  if (reach === null) return false;
  if (ordersSyncedUntil === null || history.ordersReadFrom === null) return true;
  return reach < history.ordersReadFrom;
}

/** Orders from the start date that were never read, when there are any: from the start date to the day before reading began. */
export type OrderGap = { from: string; to: string; message: string };

export function olderOrdersGap(history: History): OrderGap | null {
  if (!history.startDate || !history.ordersReadFrom || readsAllOrders(history)) return null;
  if (history.startDate >= history.ordersReadFrom) return null;
  const to = shiftDays(history.ordersReadFrom, -1);
  return {
    from: history.startDate,
    to,
    message:
      `Shopify only lets the app read the last ${SHOPIFY_ORDER_DAYS} days of orders, so orders from ${history.startDate} to ${to} weren't read and aren't in the books. ` +
      `Add ${ALL_ORDERS_SCOPE} to the app's access scopes in Shopify and test the connection; the next sync then brings them in.`,
  };
}
