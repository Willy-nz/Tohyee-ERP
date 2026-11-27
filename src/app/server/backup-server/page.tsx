"use client";

import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BackupServerSettings } from "@/lib/backup-server/mode";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";

/** Server › Backup server (BKS4-BKS7): make this Tohyee keep a copy of another one. */
export default function BackupServerPage() {
  const { user } = useWorkspace();
  const loaded = useApiData<{ backupServer: BackupServerSettings }>(user.isServerAdmin ? "/api/admin/backup-server" : null);
  if (!user.isServerAdmin) {
    return (
      <Page>
        <Notice tone="error">Only a server admin can open this.</Notice>
      </Page>
    );
  }
  const settings = loaded.data?.backupServer;
  return (
    <Page>
      <PageHeader title="Backup server" />
      <p className={ui.muted}>A second Tohyee, at a second place, that keeps a copy of the main one and can take over if the main is lost.</p>
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {!settings ? (
        loaded.error ? null : (
          <p className={ui.muted}>Loading…</p>
        )
      ) : settings.role === "backup" ? (
        <Paired settings={settings} onChanged={loaded.reload} />
      ) : (
        <Pair settings={settings} onChanged={loaded.reload} />
      )}
    </Page>
  );
}

function Paired({ settings, onChanged }: { settings: BackupServerSettings; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function unpair() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/backup-server", { method: "DELETE" });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="This is a backup server" description={`It reads the main server's backups from ${settings.folder ?? "its folder"}.`}>
      <div className={ui.stack}>
        {settings.restartNeeded ? <Notice tone="warning">Restart Tohyee on this computer to finish: until then its automatic jobs haven&apos;t been switched off at the source.</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <p>
          <Badge tone="blue">Backup copy</Badge> Paired {settings.pairedAt ? formatDateTime(settings.pairedAt) : ""} by {settings.pairedByEmail ?? "a server admin"}.
        </p>
        <ul>
          <li>Nothing can be changed here, and only server admins can look.</li>
          <li>No emails, feeds, imports or other automatic jobs run here. The main server runs them.</li>
          <li>Keeping the copy up to date, and switching over, come in the next stages of this feature.</li>
        </ul>
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => void unpair()}>
            Stop being a backup server
          </Button>
        </div>
        <p className={ui.muted}>Only while it holds no organisations. Once it has copies, it becomes the main server by switching over.</p>
      </div>
    </Card>
  );
}

function Pair({ settings, onChanged }: { settings: BackupServerSettings; onChanged: () => void }) {
  const [folder, setFolder] = useState("");
  const [key, setKey] = useState("");
  const [kitFile, setKitFile] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/backup-server", { method: "PUT", body: { folder, key: key.trim() || undefined, kitFile: kitFile || undefined, passphrase: passphrase || undefined } });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Make this a backup server" description="For a fresh install of Tohyee with no organisations. The main server keeps running as it is.">
      <form onSubmit={(event) => void pair(event)} className={ui.stack}>
        {settings.restartNeeded ? <Notice tone="warning">Restart Tohyee on this computer to finish going back to a main server.</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <ol>
          <li>On the main server, set backups to every hour, into a folder that syncs (OneDrive, say).</li>
          <li>On this computer, sign in to the same sync so that folder is here too.</li>
          <li>Give that folder below, and the main server&apos;s recovery kit (from its Backups page).</li>
        </ol>
        <Field label="The main server's backups folder, on this computer" hint="A full path, like C:\Users\you\OneDrive\Tohyee backups.">
          <input value={folder} onChange={(event) => setFolder(event.target.value)} required />
        </Field>
        <Field label="The main server's recovery code" hint="Or use its recovery file and passphrase below.">
          <textarea value={key} onChange={(event) => setKey(event.target.value)} rows={3} autoComplete="off" spellCheck={false} />
        </Field>
        <div className={ui.grid2}>
          <Field label="Recovery file">
            <input
              type="file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return setKitFile("");
                void file.text().then(setKitFile);
              }}
            />
          </Field>
          <Field label="Its passphrase">
            <input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="off" />
          </Field>
        </div>
        <Notice tone="info">Tohyee checks the kit opens the newest backup in that folder before anything changes. Nothing is copied at this step.</Notice>
        <div>
          <Button type="submit" disabled={busy}>
            Make this a backup server
          </Button>
        </div>
      </form>
    </Card>
  );
}
