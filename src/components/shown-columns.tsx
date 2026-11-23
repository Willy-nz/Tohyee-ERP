"use client";

import { useEffect, useState } from "react";
import styles from "./shown-columns.module.css";

/**
 * Which optional columns of a list this person shows, remembered in this
 * browser. Starts from the list's own short default; a browser that won't
 * keep it (private windows) just uses the default each time.
 */
export function useShownColumns<Column extends string>(storageKey: string, optional: readonly Column[], defaults: readonly Column[]) {
  const [shown, setShown] = useState<readonly Column[]>(defaults);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
      // Read once after the page is on screen, so the server's and the browser's first draw match.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (Array.isArray(saved)) setShown(optional.filter((column) => saved.includes(column)));
    } catch {
      // Nothing kept, or it can't be read: the defaults stand.
    }
  }, [storageKey, optional]);
  function toggle(column: Column, on: boolean) {
    const next = optional.filter((entry) => (entry === column ? on : shown.includes(entry)));
    setShown(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Not kept for next time; it still applies now.
    }
  }
  return { shows: (column: Column) => shown.includes(column), toggle };
}

/** The "Columns" control above a list: a tick box for each optional column. */
export function ColumnChooser<Column extends string>({ columns, shows, toggle }: { columns: ReadonlyArray<{ id: Column; label: string }>; shows: (column: Column) => boolean; toggle: (column: Column, on: boolean) => void }) {
  return (
    <details className={styles.chooser}>
      <summary>Columns</summary>
      <div className={styles.options}>
        {columns.map((column) => (
          <label key={column.id}>
            <input type="checkbox" checked={shows(column.id)} onChange={(event) => toggle(column.id, event.target.checked)} /> {column.label}
          </label>
        ))}
      </div>
    </details>
  );
}
