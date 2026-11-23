"use client";

import styles from "./list-sort.module.css";

/** Which column a list is sorted by; null is the list's own order (newest first). */
export type ListSortState = { column: string; direction: "asc" | "desc" } | null;

/** The query for a sorted list. */
export function sortQuery(sort: ListSortState): { sort: string | null; direction: string | null } {
  return { sort: sort?.column ?? null, direction: sort?.direction ?? null };
}

/**
 * A column heading you click to sort by: once for A to Z (or oldest, or
 * smallest) first, again for the other way, a third time for newest first again.
 */
export function SortableHeading({ column, label, sort, onSort, numeric }: { column: string; label: string; sort: ListSortState; onSort: (next: ListSortState) => void; numeric?: boolean }) {
  const mine = sort?.column === column ? sort.direction : null;
  const next: ListSortState = mine === null ? { column, direction: "asc" } : mine === "asc" ? { column, direction: "desc" } : null;
  return (
    <th aria-sort={mine === "asc" ? "ascending" : mine === "desc" ? "descending" : "none"} className={numeric ? styles.numeric : undefined}>
      <button type="button" className={styles.heading} onClick={() => onSort(next)} title={`Sort by ${label.toLowerCase()}`}>
        {label}
        <span className={styles.arrow} aria-hidden="true">
          {mine === "asc" ? "▲" : mine === "desc" ? "▼" : ""}
        </span>
      </button>
    </th>
  );
}
