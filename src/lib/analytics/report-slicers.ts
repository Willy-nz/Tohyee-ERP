/**
 * An accounting report on an Analytics page follows the page's dropdowns
 *: a slicer on a tracking column of the books'
 * tables (e.g. tracking_location) filters a draft profit and loss to the
 * chosen values and everything under them, as Reports' own tracking filter
 * does (TC8, RX5); a slicer on salesperson keeps just the sales invoices
 * and credit notes of those salespeople (APS7-APS10). Only the report's own
 * slicers count, on the tile's page.
 */

import type { OrgTx } from "@/lib/db/org-transaction";
import { trackingColumnNames } from "@/lib/analytics/books";
import type { Dashboard, Tile } from "@/lib/analytics/dashboards";
import { tilePage } from "@/lib/analytics/pages";
import { isRangeStyle, slicerOnPage } from "@/lib/analytics/slicers";
import { valueWithDescendants } from "@/lib/tracking/service";

export type SlicerTrackingFilter = ({ categoryId: string; valueIds: string[] } | { salespersonIds: string[] }) & { label: string };

/** What the page's dropdowns ask of the report: one filter, and anything else also chosen (a report follows one at a time). */
export type ReportSlicerChoice = { filter: SlicerTrackingFilter | null; others: string[] };

/** The books' salesperson column (on the ledger lines). */
export const SALESPERSON_FIELD = "salesperson";

export async function slicerTrackingFilter(tx: OrgTx, dashboard: Dashboard, tile: Tile, values: Record<string, string[]>): Promise<ReportSlicerChoice> {
  const pageId = tilePage(tile, dashboard.settings.pages);
  const fields = dashboard.settings.slicers
    .filter((slicer) => !isRangeStyle(slicer.style) && slicerOnPage(slicer, pageId))
    .flatMap((slicer) => [slicer.field, ...(slicer.child ? [slicer.child] : [])]);
  const chosenFields = [...new Set(fields)].filter((field) => (values[field] ?? []).length > 0);
  if (!chosenFields.length) return { filter: null, others: [] };
  const categories = await trackingColumnNames(tx);
  type Match = { name: string; category: { id: string; name: string; column: string } | null; chosen: string[] };
  const matches = chosenFields.flatMap((field): Match[] => {
    const chosen = [...new Set(values[field].map(String))].slice(0, 200);
    if (field === SALESPERSON_FIELD) return [{ name: "Salesperson", category: null, chosen }];
    const category = categories.find((entry) => entry.column === field);
    return category ? [{ name: category.name, category, chosen }] : [];
  });
  if (!matches.length) return { filter: null, others: [] };
  const [first, ...rest] = matches;
  const label = `${first.name}: ${first.chosen.join(", ")}`;
  const others = [...new Set(rest.map((entry) => entry.name).filter((name) => name !== first.name))];
  if (!first.category) {
    // Salespeople by name, archived ones too (their past sales still count).
    const found = await tx.query<{ id: string }>("select id::text from salespeople where name = any($1::text[])", [first.chosen]);
    return { filter: { salespersonIds: found.rows.map((row) => row.id), label }, others };
  }
  const found = await tx.query<{ id: string }>("select id::text from tracking_values where category_id = $1 and name = any($2::text[])", [first.category.id, first.chosen]);
  const valueIds = new Set<string>();
  for (const row of found.rows) for (const id of await valueWithDescendants(tx, row.id)) valueIds.add(id);
  return { filter: { categoryId: first.category.id, valueIds: [...valueIds], label }, others };
}
