import { ValidationError } from "@/lib/errors";

/**
 * A list sorted by a column someone clicked. `columns` maps the names the
 * screen may ask for to the SQL they stand for, so nothing typed reaches the
 * query. A sorted list pages by position (offset), because the next page of
 * "by due date" can't be found from the last row's id.
 */
export type ListSort = { orderBy: string; offset: number };

export function listSort(input: { sort?: unknown; direction?: unknown; offset?: unknown }, columns: Record<string, string>): ListSort | null {
  if (input.sort == null || input.sort === "") return null;
  if (typeof input.sort !== "string" || !Object.hasOwn(columns, input.sort)) {
    throw new ValidationError(`sort must be one of: ${Object.keys(columns).join(", ")}.`);
  }
  if (input.direction != null && input.direction !== "asc" && input.direction !== "desc") {
    throw new ValidationError("direction must be asc or desc.");
  }
  const offset = input.offset == null || input.offset === "" ? 0 : Number(input.offset);
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw new ValidationError("offset must be a whole number from 0.");
  // Blanks last either way, so a column half filled in shows what it has first.
  return { orderBy: `${columns[input.sort]} ${input.direction === "desc" ? "desc" : "asc"} nulls last`, offset };
}
