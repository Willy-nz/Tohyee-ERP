"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { MoreMenuItem } from "@/components/more-menu";
import { Button, Field, Notice } from "@/components/ui";
import styles from "@/components/ui.module.css";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { CustomReport } from "@/lib/reports/custom";

/** What to save: the body for POST /api/custom-reports, or why these dates can't be saved. */
export type SaveReportRequest = { base: string; periodEnd: string; layout?: unknown; start?: "standard"; columns?: unknown } | { problem: string };

/** "Profit and loss, year ended 31 March 2026" from the report's name and its period line. */
export function reportTitle(label: string, period: string): string {
  const words = period.replace(/^For the /, "").replace(/^As at /, "as at ").trim();
  return (words ? `${label}, ${words}` : label).slice(0, 200);
}

type Mode = "draft" | "publish";

/**
 * Save as draft and Publish on a standard report (example CR25):
 * the report as it's shown (dates, comparisons and layout) becomes a draft
 * in Reports › Drafts, or a published, frozen copy in Reports › Published,
 * without opening the editor. Both ask for a title, starting with the
 * report's name and period, and show the period before saving, so a month
 * isn't published by mistake for a year. Bookkeepers and up; `items` is
 * empty for anyone else. Render `panel` once on the page.
 */
export function useSaveReport(organisationId: string, label: string, period: string, request: () => SaveReportRequest | Promise<SaveReportRequest>) {
  const { can } = useWorkspace();
  const allowed = can("bookkeeper");
  const [mode, setMode] = useState<Mode | null>(null);
  const [title, setTitle] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("save-report"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ mode: Mode; id: string; title: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (mode && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [mode]);

  function open(next: Mode) {
    setError(null);
    setSaved(null);
    setTitle(reportTitle(label, period));
    setKey(newIdempotencyKey("save-report"));
    setMode(next);
  }

  function close() {
    dialog.current?.close();
    setMode(null);
  }

  async function save() {
    if (!mode) return;
    setBusy(true);
    setError(null);
    try {
      const body = await request();
      if ("problem" in body) throw new Error(body.problem);
      const result = await api<{ report: CustomReport }>("/api/custom-reports", {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: key, ...body, title, ...(mode === "publish" ? { publish: true } : {}) },
      });
      setSaved({ mode, id: result.report.id, title: result.report.title });
      close();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const items: MoreMenuItem[] = allowed
    ? [
        { label: "Save as draft", onSelect: () => open("draft") },
        { label: "Publish", onSelect: () => open("publish") },
      ]
    : [];

  const buttons: ReactNode = allowed ? (
    <>
      <Button variant="secondary" size="small" onClick={() => open("draft")}>
        Save as draft
      </Button>
      <Button variant="secondary" size="small" onClick={() => open("publish")}>
        Publish
      </Button>
    </>
  ) : null;

  const panel: ReactNode = (
    <>
      {saved ? (
        <Notice tone="success">
          {saved.mode === "publish" ? "Published" : "Saved as a draft"}: {saved.title}, in Reports ›{" "}
          {saved.mode === "publish" ? "Published" : "Drafts"}. <Link href={`/operations/reports/custom/${saved.id}`}>Open it</Link>
        </Notice>
      ) : null}
      {mode ? (
        <dialog
          ref={dialog}
          className={styles.confirmDialog}
          aria-labelledby="save-report-title"
          onCancel={(event) => {
            event.preventDefault();
            if (!busy) close();
          }}
        >
          <form
            className={styles.confirmBody}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <h2 id="save-report-title" className={styles.confirmTitle}>
              {mode === "publish" ? "Publish this report" : "Save as a draft"}
            </h2>
            <p className={styles.confirmMessage}>
              <strong>{period || label}</strong>
              {"\n"}
              {mode === "publish"
                ? "A frozen copy with today's figures goes into Reports › Published. Check the dates are the ones you mean."
                : "It goes into Reports › Drafts, where you can change it and publish it later."}
            </p>
            <Field label="Title">
              <input value={title} maxLength={200} required onChange={(event) => setTitle(event.target.value)} />
            </Field>
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div className={styles.confirmActions}>
              <Button type="button" variant="secondary" disabled={busy} onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !title.trim()}>
                {busy ? "Saving…" : mode === "publish" ? "Publish" : "Save as draft"}
              </Button>
            </div>
          </form>
        </dialog>
      ) : null}
    </>
  );

  return { allowed, items, buttons, panel, busy };
}
