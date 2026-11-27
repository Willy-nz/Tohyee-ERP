"use client";

import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import type { SwitchOverPreview, SwitchOverResult } from "@/lib/backup-server/switch";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";

/** Switch over (BKS15-BKS16): make this backup server the main one. A server admin, or an organisation's Owner. */
export default function SwitchOverPage() {
  const loaded = useApiData<{ preview: SwitchOverPreview }>("/api/backup-server/switch-over");
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");
  const [off, setOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SwitchOverResult | null>(null);
  const preview = loaded.data?.preview;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setDone((await api<{ result: SwitchOverResult }>("/api/backup-server/switch-over", { method: "POST", body: { password, reason, oldMainIsOff: off } })).result);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <PageHeader title="Switch over" />
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {!preview ? (
        loaded.error ? null : (
          <p className={ui.muted}>Loading…</p>
        )
      ) : done ? (
        <Card title="This is now the main server">
          <div className={ui.stack}>
            <Notice tone="success">Changes are taken here from now. Automatic jobs are on for {done.organisations.length === 1 ? "1 organisation" : `${done.organisations.length} organisations`}.</Notice>
            {done.noteWritten ? (
              <p>A note for the old main server was left in the backups folder. If it comes back, it will stop and take no changes.</p>
            ) : (
              <Notice tone="error">The note for the old main server couldn&apos;t be written to the backups folder. Keep the old main switched off, or it will carry on as a main server.</Notice>
            )}
            <p>
              <strong>Next, a server admin on this computer:</strong>
            </p>
            <ol>
              <li>Restart Tohyee, so its automatic jobs start.</li>
              <li>Set where this server backs up, and save its own recovery kit.</li>
              <li>Tell everyone the address to use, and check what was entered since each copy&apos;s time below: that work is not here.</li>
              <li>Reconnect AI and app connections; they aren&apos;t copied.</li>
            </ol>
          </div>
        </Card>
      ) : preview.role !== "backup" ? (
        <Notice tone="info">{preview.role === "main" ? "This is the main server already. There's nothing to switch over." : "This server is no longer the main one. A server admin pairs it as the backup server, or says it's the main after all, on the server computer."}</Notice>
      ) : !preview.allowed ? (
        <Notice tone="error">Only a server admin or an organisation&apos;s Owner can switch over.</Notice>
      ) : (
        <>
          <Notice tone="warning">Only do this when the main server is lost or can&apos;t be reached and won&apos;t be back soon. Anything entered on the main after each time below is not here and will have to be entered again.</Notice>
          <Card title="What's on this server" description={preview.lastLookedAt ? `It last looked for new backups ${formatDateTime(preview.lastLookedAt)}.` : undefined}>
            <div className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`}>
                <thead>
                  <tr>
                    <th>Organisation</th>
                    <th>The books as at</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.organisations.map((organisation) => (
                    <tr key={organisation.id}>
                      <td data-label="Organisation">
                        {organisation.displayName} {organisation.archived ? <Badge tone="amber">Archived: stays off</Badge> : null}
                      </td>
                      <td data-label="The books as at">{organisation.asAt ? formatDateTime(organisation.asAt) : "No copy yet"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={ui.muted}>{preview.peopleAsAt ? `People, passwords and who's in what: as at ${formatDateTime(preview.peopleAsAt)}.` : "People haven't been copied yet."}</p>
          </Card>
          <Card title="How people will reach this server">
            {preview.links.length === 0 ? <p className={ui.muted}>Couldn&apos;t read this server&apos;s remote access settings.</p> : null}
            {preview.links.map((link) => (
              <p key={link.method}>
                {link.address ? <strong>{link.address}</strong> : "No outside address"} {link.reachable === "yes" ? <Badge tone="green">Answering</Badge> : link.on ? <Badge tone="amber">Check it</Badge> : <Badge tone="red">Off</Badge>}
                <br />
                <span className={ui.muted}>{link.note}</span>
              </p>
            ))}
          </Card>
          <Card title="Make this the main server">
            <form onSubmit={(event) => void submit(event)} className={ui.stack}>
              {error ? <Notice tone="error">{error}</Notice> : null}
              <ul>
                <li>Changes will be taken here.</li>
                <li>Every organisation&apos;s automatic jobs come on: bank feeds, emails, repeating invoices and the rest.</li>
                <li>If the old main comes back, it finds a note in the backups folder and stops.</li>
              </ul>
              <Field label="Why are you switching over?" hint="Kept in the record.">
                <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required />
              </Field>
              <Field label="Your password, again">
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
              </Field>
              <label className={ui.checkbox}>
                <input type="checkbox" checked={off} onChange={(event) => setOff(event.target.checked)} /> The old main server is off, or can&apos;t be reached.
              </label>
              <div>
                <Button type="submit" variant="danger" disabled={busy || !off}>
                  Make this the main server
                </Button>
              </div>
            </form>
          </Card>
        </>
      )}
    </Page>
  );
}
