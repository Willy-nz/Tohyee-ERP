"use client";

import Link from "next/link";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Card, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { HomeSearch } from "@/lib/saved-searches/service";
import styles from "./saved-searches.module.css";

/** Home: the saved searches ticked "Show on Home", each with how many match right now. Nothing shows when there are none. */
export function SavedSearchHome({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const found = useApiData<{ searches: HomeSearch[] }>(can("viewer") ? "/api/saved-searches/home" : null, { organisationId });
  const searches = found.data?.searches ?? [];
  if (searches.length === 0) return null;
  return (
    <Card title="Saved searches">
      <div className={styles.homeTiles}>
        {searches.map((search) => (
          <Link key={search.id} href={`/operations/saved-searches?search=${search.id}`} className={styles.homeTile}>
            <strong className={styles.homeCount}>{search.matches}</strong>
            <span>{search.name}</span>
            {search.total !== null ? (
              <span className={ui.muted}>
                {search.totalLabel} <Money value={search.total} />
              </span>
            ) : null}
          </Link>
        ))}
      </div>
    </Card>
  );
}
