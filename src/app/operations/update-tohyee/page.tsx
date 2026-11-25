"use client";

import { useEffect, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import type { RemoteUpdateState } from "@/lib/updates/remote-update";
import { updaterBusy } from "@/lib/updates/updater-status";

/**
 * Update now (UPD1-UPD9): a server admin updates the Windows server from
 * any device. Everything is backed up first; the Tohyee updater on the
 * server installs it a minute or two later, and Tohyee restarts. Only a
 * download or install that's still going holds the button back (UPD7).
 */
export default function UpdateTohyeePage() {
  const { user } = useWorkspace();
  const confirm = useConfirm();
  const { data, error, reload } = useApiData<RemoteUpdateState>(user.isServerAdmin ? "/api/server-update" : null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const working = busy || (data?.pending != null && !data.pending.stuck) || updaterBusy(data?.updater ?? null);

  // While an update is on its way, look again every 15 seconds (Tohyee is away for a minute while it restarts).
  useEffect(() => {
    if (!working || busy) return;
    const timer = window.setInterval(reload, 15_000);
    return () => window.clearInterval(timer);
  }, [working, busy, reload]);

  if (!user.isServerAdmin) {
    return (
      <Page>
        <PageHeader title="Update Tohyee" />
        <Notice>Only a server admin can update Tohyee.</Notice>
      </Page>
    );
  }

  async function updateNow(version: string) {
    if (!(await confirm(`Update Tohyee to v${version}? Everything is backed up first, then Tohyee closes for a few minutes while it installs, for everyone using it.`))) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/server-update", { method: "POST", body: { version } });
      setMessage({ tone: "success", text: `Backed up. The update to v${version} starts within a minute or two; Tohyee will be away for a few minutes.` });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
      reload();
    }
  }

  return (
    <Page>
      <PageHeader title="Update Tohyee" />
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {data ? (
        <Card title={`This server runs v${data.currentVersion}`}>
          <div style={{ display: "grid", gap: 12 }}>
            {data.updateAvailable && data.latestVersion ? (
              <p>
                <Badge tone="blue">New</Badge> v{data.latestVersion} is out
                {data.publishedAt ? ` (${formatDateTime(data.publishedAt)})` : ""}.{" "}
                {data.releaseNotesUrl ? (
                  <a href={data.releaseNotesUrl} target="_blank" rel="noreferrer">
                    What&apos;s new
                  </a>
                ) : null}
              </p>
            ) : (
              <p>
                <Badge tone="green">Up to date</Badge>{" "}
                {data.checkedAt ? <span className={ui.muted}>Checked {formatDateTime(data.checkedAt)}</span> : null}
              </p>
            )}
            {data.checkError ? <Notice tone="warning">Couldn&apos;t check GitHub: {data.checkError}</Notice> : null}
            {data.pending ? (
              data.pending.stuck ? (
                <Notice tone="warning">
                  The update to v{data.pending.version} asked for at {formatDateTime(data.pending.requestedAt)} hasn&apos;t started.
                  The updater may not be running on the server: install this version once on the server computer, which sets it up.
                </Notice>
              ) : (
                <Notice>Updating to v{data.pending.version}: it starts within a minute or two.</Notice>
              )
            ) : null}
            {data.updater && !data.pending ? <UpdaterLine status={data.updater} current={data.currentVersion} /> : null}
            {!data.canUpdateHere ? <Notice tone="warning">{data.notHere}</Notice> : null}
            {data.canUpdateHere && data.updateAvailable && data.latestVersion ? (
              <div>
                <Button disabled={working} onClick={() => updateNow(data.latestVersion as string)}>
                  {busy ? "Backing up…" : `Update now to v${data.latestVersion}`}
                </Button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}
    </Page>
  );
}

function UpdaterLine({ status, current }: { status: NonNullable<RemoteUpdateState["updater"]>; current: string }) {
  const when = status.at ? ` (${formatDateTime(status.at)})` : "";
  switch (status.outcome) {
    case "old":
      return null;
    case "installed":
      return <Notice tone="success">Updated to v{current}{when}.</Notice>;
    case "working":
      return status.state === "downloading" ? (
        <Notice>Downloading v{status.version}…{when}</Notice>
      ) : (
        <Notice>Installing v{status.version}. Tohyee is away for a few minutes.{when}</Notice>
      );
    case "skipped":
      return (
        <Notice tone="warning">
          The last update was skipped{when}: {status.message ?? "no reason given"}
        </Notice>
      );
    case "failed":
      return (
        <Notice tone="error">
          The update to v{status.version ?? "?"} didn&apos;t work{when}. {status.note ?? status.message ?? "No reason was given."}
          {status.note && status.message ? <> ({status.message})</> : null}
        </Notice>
      );
  }
}
