import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { cmp, dec, sub, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { respread } from "@/lib/spreading/rules";
import { getSpreadItem, latestPostedMonth, lockWorksheet, parseDate, postedThrough, type SpreadItem, writeMonths } from "@/lib/spreading/service";
import { asRecord, requireString } from "@/lib/validation";

/**
 * Changes an item part way through (SW29, SW30): a new last day, a new
 * amount still to come, or both. Months already posted never change; what's
 * left is spread again over the months still to come, the way the item was
 * spread before.
 *
 * What's left can only be changed on an accrual, which is an estimate. A
 * cost paid in advance or income in advance is what was paid or invoiced:
 * its amount is on the balance sheet already, so it ends early instead.
 */
export async function changeSpreadItem(tx: OrgTx, idInput: unknown, bodyInput: unknown): Promise<SpreadItem> {
  const body = asRecord(bodyInput, "body");
  const given = (value: unknown) => value !== undefined && value !== null && value !== "";
  if (!given(body.endDate) && !given(body.left)) throw new ValidationError("Give a new last day, a new amount still to come, or both.");
  await lockWorksheet(tx);
  const item = await getSpreadItem(tx, idInput);
  const accrual = item.kind === "accrued_expense" || item.kind === "accrued_income";
  if (item.method !== "by_month" && item.method !== "by_days") {
    throw new ValidationError("Only something spread by month or by days can be respread. Remove this one before it posts and add it again, or end it early.");
  }
  if (item.settledMonth) throw new ConflictError(`It was marked as arrived in ${item.settledMonth}, so there's nothing left to change.`);
  if (!item.months.some((row) => row.runId === null)) throw new ConflictError("Every month has posted, so there's nothing left to change.");
  if (!item.startDate || !item.endDate) throw new ConflictError("This item has no dates to move.");

  const endDate = given(body.endDate) ? parseDate(body.endDate, "the new last day") : item.endDate;
  const posted = sum(item.months.filter((row) => row.runId !== null && row.lineKind === "share").map((row) => dec(row.amount)));
  const before = sub(dec(item.amount), posted);
  let left = before;
  if (given(body.left)) {
    if (!accrual) throw new ValidationError("What's left of something paid or invoiced in advance is what was paid or invoiced, so it can't be changed. Move its last day, or end it early.");
    const text = requireString(body.left, "What's still to come", { maxLength: 20 }).replaceAll(",", "");
    if (!/^\d{1,13}(\.\d{1,2})?$/.test(text)) throw new ValidationError("What's still to come is an amount, like 450.00.");
    left = dec(text);
  }
  if (cmp(left, ZERO_DECIMAL) <= 0) throw new ValidationError(accrual ? "If nothing more is to come, mark it as arrived instead." : "Nothing is left to spread.");

  // Months that can't change: this item's own posted months, and any month the kind has posted since.
  const own = postedThrough(item);
  const kindLatest = await latestPostedMonth(tx, item.kind);
  const through = [own, kindLatest].filter((month): month is string => month !== null).sort().at(-1) ?? null;
  const next = respread({ method: item.method, startDate: item.startDate, endDate, left: toFixedString(left, 2), through });
  if (!next) {
    throw new ValidationError(
      through ? `${through} has posted, so the last day has to be after it. To finish it now, ${accrual ? "mark it as arrived" : "end it early"}.` : "The last day is before the first day.",
    );
  }
  await tx.query("delete from spread_item_months where item_id = $1 and run_id is null", [item.id]);
  await writeMonths(tx, item.id, next);
  await tx.query("update spread_items set end_date = $2::date, amount = $3::numeric, updated_at = now() where id = $1", [item.id, endDate, toFixedString(sum([posted, left]), 2)]);
  await writeAuditEvent(tx, {
    eventType: "spread_item.changed",
    entityType: "spread_item",
    entityId: item.id,
    details: { endDate: { from: item.endDate, to: endDate }, left: { from: toFixedString(before, 2), to: toFixedString(left, 2) }, months: next.length },
  });
  return getSpreadItem(tx, item.id);
}
