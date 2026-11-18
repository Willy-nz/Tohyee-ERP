"use client";

import { useState } from "react";
import type { Dashboard } from "@/lib/analytics/dashboards";
import { api, errorMessage } from "@/lib/client/api";
import styles from "./report-cover-picker.module.css";

type Source = { id: string; label: string };

function availableImages(report: Dashboard): Source[] {
  const images: Source[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined, label: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    images.push({ id, label });
  };
  for (const page of report.settings.pages ?? []) add(page.picture?.id, `Page background: ${page.name}`);
  for (const tile of report.tiles) if (tile.visual === "image") add(tile.image?.id, `Picture: ${tile.title}`);
  if (report.settings.coverImageId) add(report.settings.coverImageId, "Current cover");
  return images;
}

/** Report-library cover editing. Never changes the report's own pages or tiles. */
export function ReportCoverPicker({
  report, organisationId, onSaved,
}: { report: Dashboard; organisationId: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState(report.settings.coverImageId ?? "");
  const sources = availableImages(report);

  async function saveCover(imageId: string | undefined) {
    // Fetch the current revision to prevent overwriting someone else's report edits.
    const { dashboard: fresh } = await api<{ dashboard: Dashboard }>(
      `/api/analytics/dashboards/${encodeURIComponent(report.id)}`,
      { query: { organisationId } },
    );
    if (fresh.version !== report.version) throw new Error("This report changed since the list loaded. Refresh the reports list and try again.");
    await api<{ dashboard: Dashboard }>(`/api/analytics/dashboards/${encodeURIComponent(report.id)}`, {
      method: "PATCH",
      body: {
        organisationId,
        expectedVersion: fresh.version,
        settings: { ...fresh.settings, coverImageId: imageId ?? null },
      },
    });
    onSaved();
    setEditing(false);
  }

  async function chooseCover(imageId: string | undefined) {
    setError(null);
    setSaving(true);
    try {
      await saveCover(imageId);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function uploadCover(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!["image/jpeg", "image/png"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError("Choose a JPG or PNG up to 5 MB.");
      return;
    }
    setSaving(true);
    try {
      const form = new FormData();
      form.set("organisationId", organisationId);
      form.set("file", file, file.name);
      const response = await fetch(
        `/api/analytics/dashboards/${encodeURIComponent(report.id)}/images`,
        { method: "POST", body: form, credentials: "same-origin" },
      );
      const payload = (await response.json().catch(() => null)) as { image?: { id: string }; error?: string } | null;
      if (!response.ok || !payload?.image) throw new Error(payload?.error ?? "Couldn't upload the cover.");
      await saveCover(payload.image.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.controls}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={editing}
        onClick={() => { setEditing((value) => !value); setSelection(report.settings.coverImageId ?? ""); setError(null); }}
      >
        {report.settings.coverImageId ? "Change cover" : "Add cover photo"}
      </button>
      {editing ? (
        <div className={styles.editor}>
          <label className={styles.uploadLabel}>
            Upload a cover (JPG or PNG, up to 5 MB)
            <input
              type="file"
              accept="image/jpeg,image/png"
              disabled={saving}
              onChange={(event) => { void uploadCover(event.target.files?.[0]); event.currentTarget.value = ""; }}
            />
          </label>
          {sources.length ? (
            <label className={styles.uploadLabel}>
              Or use a picture already in the report
              <select value={selection} onChange={(event) => setSelection(event.target.value)} disabled={saving}>
                <option value="">Choose an existing picture…</option>
                {sources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
              </select>
            </label>
          ) : null}
          <div className={styles.actions}>
            {selection ? <button type="button" disabled={saving} onClick={() => void chooseCover(selection)}>Use selected picture</button> : null}
            {report.settings.coverImageId ? <button type="button" disabled={saving} onClick={() => void chooseCover(undefined)}>Use automatic preview</button> : null}
            <button type="button" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
          </div>
          {saving ? <p role="status">Saving cover…</p> : null}
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
