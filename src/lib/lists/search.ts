import { ValidationError } from "@/lib/errors";

/**
 * What someone typed in a list's search box, as a pattern for `ilike`: the
 * text anywhere in the value, with % and _ taken literally. Null when the box
 * is empty, so the list isn't filtered.
 */
export function listSearchPattern(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input !== "string") throw new ValidationError("search must be text.");
  const text = input.trim();
  if (text === "") return null;
  if (text.length > 100) throw new ValidationError("Search for something shorter (100 characters at most).");
  return `%${text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}
