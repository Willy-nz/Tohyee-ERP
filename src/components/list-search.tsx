"use client";

import { useEffect, useState } from "react";
import styles from "./list-search.module.css";

/**
 * The search box above a list. Tells the list what was typed a moment after
 * typing stops, so the server isn't asked on every key.
 */
export function ListSearch({ label, placeholder, onSearch }: { label: string; placeholder: string; onSearch: (text: string) => void }) {
  const [text, setText] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => onSearch(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text, onSearch]);
  return (
    <div className={styles.search}>
      <input type="search" aria-label={label} placeholder={placeholder} value={text} maxLength={100} onChange={(event) => setText(event.target.value)} />
    </div>
  );
}
