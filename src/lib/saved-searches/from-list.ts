import type { SearchDefinition } from "@/lib/saved-searches/query";

/**
 * "Save this view" on the Invoices and Bills lists: the tab, the search text
 * and the sort the person is looking at, as the start of a saved search.
 * Browser safe.
 */

const SORT_FIELDS: Record<string, string> = { number: "number", contact: "contact", date: "date", due: "due", total: "total" };

export function savedSearchFromList(
  recordType: "invoice" | "bill",
  view: { status: string | null; awaitingPayment: boolean; sort: { column: string; direction: "asc" | "desc" } | null; search?: string },
): string {
  const filters: SearchDefinition["filters"] = [];
  // What's typed in the list's search box: the same fields it looks in.
  if (view.search?.trim()) filters.push({ field: "anyText", op: "contains", value: view.search.trim().slice(0, 200) });
  if (view.awaitingPayment) filters.push({ field: "status", op: "is", value: "approved" }, { field: "owing", op: "gt", value: "0" });
  else if (view.status) filters.push({ field: "status", op: "is", value: view.status });
  const sortField = view.sort ? SORT_FIELDS[view.sort.column] : undefined;
  const start = { filters, sort: sortField && view.sort ? { field: sortField, direction: view.sort.direction } : null };
  return `/operations/saved-searches?type=${recordType}&start=${encodeURIComponent(JSON.stringify(start))}`;
}

/** Reads `start` back, keeping only what's shaped like filters and a sort; the server still checks every field. */
export function startFromAddress(text: string | null): { filters: SearchDefinition["filters"]; sort: SearchDefinition["sort"] } | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as { filters?: unknown; sort?: unknown };
    const filters = Array.isArray(raw.filters)
      ? raw.filters
          .filter((each): each is Record<string, unknown> => typeof each === "object" && each !== null)
          .slice(0, 12)
          .map((each) => ({
            field: String(each.field ?? ""),
            op: String(each.op ?? ""),
            ...(typeof each.value === "string" ? { value: each.value } : {}),
            ...(typeof each.value2 === "string" ? { value2: each.value2 } : {}),
          }))
      : [];
    const sort = typeof raw.sort === "object" && raw.sort !== null ? (raw.sort as { field?: unknown; direction?: unknown }) : null;
    return { filters, sort: sort && typeof sort.field === "string" ? { field: sort.field, direction: sort.direction === "asc" ? "asc" : "desc" } : null };
  } catch {
    return null;
  }
}
