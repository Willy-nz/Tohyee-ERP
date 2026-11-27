"use client";

import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BackupServerSettings } from "@/lib/backup-server/mode";
import type { QuietState } from "@/lib/backup-server/alerts";
import type { MainReach, PracticeResult } from "@/lib/backup-server/practice";
import type { CopiesState } from "@/lib/backup-server/refresh";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";

/** Server › Backup server (BKS4-BKS7): make this Tohyee keep a copy of another one. */
export default function BackupServerPage() {
  const { user } = useWorkspace();
  const loaded = useApiData<{ backupServer: BackupServerSettings; copies: CopiesState | null; quiet: QuietState | null; main: MainReach | null; practice: { last: PracticeResult | null; due: boolean } | null; keepRemovedDays: number }>(user.isServerAdmin ? "/api/admin/backup-server" : null);
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
        <>
          {loaded.data?.quiet?.quiet ? (
            <Notice tone="error">
              No new backup has come from the main server for more than {loaded.data.quiet.hours} hours{loaded.data.quiet.newest ? ` (the newest copy is as at ${formatDateTime(loaded.data.quiet.newest)})` : ""}. Check the main server is running and its backups folder is still syncing here.
            </Notice>
          ) : null}
          <Paired settings={settings} onChanged={loaded.reload} />
          {loaded.data?.copies ? <Copies copies={loaded.data.copies} keepRemovedDays={loaded.data.keepRemovedDays} onChanged={loaded.reload} /> : null}
          {loaded.data?.main ? <MainAddress main={loaded.data.main} onChanged={loaded.reload} /> : null}
          {loaded.data?.practice ? <Practice practice={loaded.data.practice} onChanged={loaded.reload} /> : null}
        </>
      ) : (
        <>
          {settings.role === "fenced" ? <Fenced onChanged={loaded.reload} /> : null}
          <Pair settings={settings} onChanged={loaded.reload} />
        </>
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
          <li>It looks for new backups from the main server every 5 minutes and takes them.</li>
          <li>
            If the main server is lost, a server admin or an organisation&apos;s Owner can <a href="/switch-over">switch over</a> and make this the main server.
          </li>
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
    <Card
      title="Make this a backup server"
      description={settings.role === "fenced" ? "The organisations here are replaced by copies from the new main server's backups." : "For a fresh install of Tohyee with no organisations. The main server keeps running as it is."}
    >
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

/** The copies this backup server holds (BKS8-BKS11): each organisation as at the main's backup it was made from. */
function Copies({ copies, keepRemovedDays, onChanged }: { copies: CopiesState; keepRemovedDays: number; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  async function refresh() {
    setBusy(true);
    setMessage(null);
    try {
      const done = await api<{ result: { refreshed: string[]; failed: { organisationId: string | null; error: string }[] } }>("/api/admin/backup-server/refresh", { method: "POST" });
      setMessage(
        done.result.failed.length
          ? { tone: "error", text: done.result.failed.map((failure) => `${failure.organisationId ?? "People"}: ${failure.error}`).join(" ") }
          : { tone: "success", text: done.result.refreshed.length ? `New copies taken: ${done.result.refreshed.join(", ")}.` : "Nothing new to take." },
      );
      onChanged();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }
  const rows = Object.entries(copies.organisations).sort((left, right) => left[1].displayName.localeCompare(right[1].displayName));
  const removed = Object.entries(copies.removed);
  return (
    <Card title="The copies here" description={copies.lastRunAt ? `Last looked for new backups ${formatDateTime(copies.lastRunAt)}.` : "It hasn't looked for backups yet."}>
      <div className={ui.stack}>
        {copies.lastError ? <Notice tone="error">{copies.lastError}</Notice> : null}
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        {rows.length === 0 ? (
          <p className={ui.muted}>No copies yet. They arrive once the main server&apos;s backups are in the folder.</p>
        ) : (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Organisation</th>
                  <th>The books as at</th>
                  <th>Taken</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([id, copy]) => (
                  <tr key={id}>
                    <td data-label="Organisation">
                      {copy.displayName} <span className={ui.muted}>({id})</span>
                    </td>
                    <td data-label="The books as at">{copy.madeAt ? formatDateTime(copy.madeAt) : "No copy yet"}</td>
                    <td data-label="Taken">{copy.refreshedAt ? formatDateTime(copy.refreshedAt) : ""}</td>
                    <td data-label="State">
                      {copies.removed[id] ? <Badge tone="amber">Archived</Badge> : copy.error ? <Badge tone="red">Newest backup not taken</Badge> : <Badge tone="green">Up to date</Badge>}
                      {copy.error ? <div className={ui.muted}>{copy.error}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={ui.muted}>
          {copies.people?.madeAt ? `People and who's in what: as at ${formatDateTime(copies.people.madeAt)}.` : "People and memberships haven't been taken yet."}
          {copies.people?.error ? ` The newest couldn't be taken: ${copies.people.error}` : ""}
        </p>
        {removed.length ? (
          <Notice tone="warning">
            The main server no longer has {removed.map(([id, gone]) => `${gone.displayName} (${id}, archived ${formatDateTime(gone.archivedAt)})`).join(", ")}. Each copy is kept here for {keepRemovedDays} days, then deleted.
          </Notice>
        ) : null}
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>
            Take new copies now
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** An old main that found the backup server was made the main while it was away (BKS17-BKS18). */
function Fenced({ onChanged }: { onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function mainAfterAll() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/backup-server/main-after-all", { method: "POST" });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="This server is no longer the main one">
      <div className={ui.stack}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Notice tone="warning">The backup server was made the main server while this one was away. This server takes no changes and runs no automatic jobs. People can still read what&apos;s here.</Notice>
        <p>Usually: pair this server as the backup server below, pointing at the folder the new main backs up into. Anything entered here after the new main&apos;s copy was made isn&apos;t on the new main: note it down first, as pairing replaces the books here.</p>
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => void mainAfterAll()}>
            This is the main server after all
          </Button>
        </div>
        <p className={ui.muted}>Only if the switch-over was a mistake and the other server is being stopped. Two main servers would drift apart.</p>
      </div>
    </Card>
  );
}

/** Whether the main can be reached (BKS20): the backup server asks its address every 5 minutes. */
function MainAddress({ main, onChanged }: { main: MainReach; onChanged: () => void }) {
  const [url, setUrl] = useState(main.url ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/backup-server/main-address", { method: "PUT", body: { url } });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Can the main server be reached?" description="Give the main server's outside address and this server asks it every 5 minutes. After 15 minutes with no answer it emails the server admins, asking whether to switch over. It never switches by itself.">
      <form onSubmit={(event) => void save(event)} className={ui.stack}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {main.offer ? (
          <Notice tone="error">
            The main server hasn&apos;t answered since {main.unreachableSince ? formatDateTime(main.unreachableSince) : "a while ago"}. If it&apos;s lost or won&apos;t be back soon, <a href="/switch-over">switch over</a>.
          </Notice>
        ) : main.url && main.reachable === true ? (
          <p>
            <Badge tone="green">Answering</Badge> Last asked {main.checkedAt ? formatDateTime(main.checkedAt) : ""}.
          </p>
        ) : main.url && main.reachable === false ? (
          <p>
            <Badge tone="amber">No answer</Badge> Since {main.unreachableSince ? formatDateTime(main.unreachableSince) : ""}.
          </p>
        ) : null}
        <Field label="The main server's address" hint="Like https://books.example.nz. Leave empty to turn this off.">
          <input value={url} onChange={(event) => setUrl(event.target.value)} inputMode="url" />
        </Field>
        <div>
          <Button type="submit" variant="secondary" disabled={busy}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Practise a switch-over (BKS21-BKS22): everything one needs, checked without switching. */
function Practice({ practice, onChanged }: { practice: { last: PracticeResult | null; due: boolean }; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/backup-server/practice", { method: "POST" });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  const last = practice.last;
  return (
    <Card title="Practise a switch-over" description="Opens every copy, checks the note for the old main can be written, and tries this server's outside address. Nothing is switched.">
      <div className={ui.stack}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {practice.due ? <Notice tone="warning">{last ? "The last practice was more than 6 months ago. Worth doing again." : "A switch-over hasn't been practised yet. Until it has, nobody knows it works."}</Notice> : null}
        {last ? (
          <>
            <p>
              {last.ready ? <Badge tone="green">Ready</Badge> : <Badge tone="red">Not ready</Badge>} Practised {formatDateTime(last.at)} by {last.byEmail}.
            </p>
            {last.problems.length ? (
              <ul>
                {last.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            ) : null}
            <ul>
              {last.organisations.map((each) => (
                <li key={each.id}>
                  {each.displayName}: {each.opens ? "opens" : "doesn't open"}
                  {each.behindMinutes === null ? "" : `; ${each.behindMinutes} minutes of work would have been lost`}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => void run()}>
            Practise a switch-over
          </Button>
        </div>
      </div>
    </Card>
  );
}
