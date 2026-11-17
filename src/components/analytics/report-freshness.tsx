"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Button, Notice } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { ReportFreshness, SourceFreshness } from "@/lib/analytics/freshness";
import { formatDate, formatDateTime } from "@/lib/format";
import styles from "./report-freshness.module.css";

/** One source's line: when its data was last loaded and how far it goes. */
export function freshnessText(source: SourceFreshness): string {
  const who = source.name.startsWith("Meta") ? "Meta" : "Google";
  const changing = source.mayChangeFrom ? ` ${who} may still change the days from ${formatDate(source.mayChangeFrom)}.` : "";
  return `${sourceText(source)}${changing}`;
}

function sourceText(source: SourceFreshness): string {
  const through = source.dataThrough ? `, data up to ${formatDate(source.dataThrough)}` : "";
  if (source.running) {
    return source.refreshedAt
      ? `${source.name} is refreshing now; showing the data loaded ${formatDateTime(source.refreshedAt)}${through}.`
      : `${source.name} is loading for the first time.`;
  }
  if (source.failedAt) {
    // Why, when the reader may be told: the reason Load history has.
    const why = source.failedReason ? ` Why: ${/[.!?…]$/.test(source.failedReason) ? source.failedReason : `${source.failedReason}.`}` : "";
    return source.refreshedAt
      ? `${source.name}: the last refresh failed (${formatDateTime(source.failedAt)}), so this is still the data loaded ${formatDateTime(source.refreshedAt)}${through}. It may be out of date.${why}`
      : `${source.name}: loading failed (${formatDateTime(source.failedAt)}) and no data has loaded yet.${why}`;
  }
  return source.refreshedAt ? `${source.name} refreshed ${formatDateTime(source.refreshedAt)}${through}.` : `${source.name}: when it was last loaded isn't recorded${through}.`;
}

/** Under a report's dates: each source's freshness, failed refreshes as stale, and a note when sources are from different times. */
export function ReportFreshnessLine({ organisationId, dashboardId, version }: { organisationId: string; dashboardId: string; version?: string }) {
  const loaded = useApiData<ReportFreshness>(`/api/analytics/dashboards/${dashboardId}/freshness`, { organisationId, ...(version ? { version } : {}) });
  const { can } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const freshness = loaded.data;
  // "Try again": owners and admins load this report's sources again from here, without going to Data sources.
  async function tryAgain() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/analytics/dashboards/${dashboardId}/refresh`, { method: "POST", body: { organisationId } });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
      loaded.reload();
    }
  }
  // Anything unexpected (an older server, a failed request) shows nothing rather than breaking the report.
  if (!freshness || !Array.isArray(freshness.sources) || freshness.sources.length === 0) return null;
  const stale = freshness.sources.filter((source) => source.failedAt);
  const fine = freshness.sources.filter((source) => !source.failedAt);
  return (
    <div className={styles.freshness}>
      {stale.map((source, index) => (
        <Notice key={source.name} tone="warning">
          {freshnessText(source)}
          {index === 0 && !version && can("admin") ? (
            <>
              {" "}
              <Button size="small" variant="secondary" disabled={busy} onClick={() => void tryAgain()}>
                {busy ? "Refreshing…" : "Try again"}
              </Button>
            </>
          ) : null}
        </Notice>
      ))}
      {error ? <Notice tone="error">Refreshing didn&apos;t work: {error}</Notice> : null}
      {fine.length ? (
        <p className={styles.line}>
          {fine.map((source) => freshnessText(source)).join(" ")}
          {freshness.mixed ? " These sources were refreshed at different times, so the tiles may not agree with each other." : ""}
        </p>
      ) : null}
    </div>
  );
}
