"use client";

import { InfoTip } from "@/components/info-tip";
import Link from "next/link";
import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import type { GmcAccount, GmcStatus } from "@/lib/analytics/merchant-center";
import { tableDescription, tableLabel } from "@/lib/analytics/labels";
import type { LoadRun } from "@/lib/analytics/sources";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";

function rows(value: string | null): string {
  return value === null ? "" : Number(value).toLocaleString("en-NZ");
}

/** What an admin sets up in Google Cloud first: the same app and return address as the other Google sources. */
function CloudHelp({ callbackPath }: { callbackPath: string }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <details style={{ overflowWrap: "anywhere" }}>
      <summary>What an admin sets up in Google Cloud first</summary>
      <ol style={{ paddingLeft: 20 }}>
        <li>
          Tohyee signs in with the Google app saved under <Link href="/operations/settings/email">Settings › Email</Link>, returning to the same address as Google
          Analytics: <code style={{ wordBreak: "break-all" }}>{origin}{callbackPath}</code>.
        </li>
        <li>In the same Google Cloud project, enable the <strong>Merchant API</strong> (APIs &amp; Services › Library).</li>
        <li>
          On the consent screen (Google Auth Platform › Data access), add the scope <code style={{ wordBreak: "break-all" }}>https://www.googleapis.com/auth/content</code>.
          Google has no read-only Merchant Center permission, so it asks to manage the account; Tohyee only ever reads.
        </li>
        <li>In Merchant Center, the Google account needs to be a user of the account. Clicks and impressions also need its &ldquo;Performance and insights&rdquo; access.</li>
        <li>While the app&apos;s publishing status is <strong>Testing</strong>, Google ends each sign-in after 7 days and you&apos;ll need to connect again.</li>
      </ol>
    </details>
  );
}

/**
 * Google Merchant Center in Analytics › Data sources:
 * sign in with Google, choose the account, load its products, their
 * problems and clicks by product, refresh or disconnect.
 */
export function MerchantCenterCard({
  organisationId,
  canManage,
  onlyIfConnected = false,
  returned,
  onChanged,
}: {
  organisationId: string;
  canManage: boolean;
  onlyIfConnected?: boolean;
  returned?: { ok: boolean; message: string } | null;
  onChanged: () => void;
}) {
  const status = useApiData<GmcStatus>("/api/analytics/google/merchant-center", { organisationId });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const confirm = useConfirm();

  if (status.error) return onlyIfConnected ? null : <Notice tone="error">{status.error}</Notice>;
  const data = status.data;
  if (!data) return null;
  const connection = data.connection;
  if (onlyIfConnected && !connection) return null;

  async function signIn() {
    setBusy("connect");
    setMessage(null);
    try {
      const { url } = await api<{ url: string }>("/api/analytics/google/merchant-center", { method: "POST", body: { organisationId } });
      window.location.assign(url);
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
      setBusy(null);
    }
  }

  async function refresh() {
    setBusy("load");
    setMessage(null);
    try {
      const { run } = await api<{ run: LoadRun }>("/api/analytics/google/merchant-center/load", { method: "POST", body: { organisationId } });
      setMessage(run.status === "ok" ? { tone: "success", text: `Loaded ${rows(run.rowsLoaded)} rows from Merchant Center.` } : { tone: "error", text: `Merchant Center didn't load: ${run.error}` });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
      status.reload();
      onChanged();
    }
  }

  async function disconnect() {
    const ok = await confirm(
      "Tohyee deletes the Google sign-in and every Merchant Center table it loaded. Reports that use them will show no data. Nothing changes in Merchant Center itself. The load history stays.",
      { title: "Disconnect Google Merchant Center?", confirmLabel: "Disconnect", danger: true },
    );
    if (!ok) return;
    setBusy("disconnect");
    setMessage(null);
    try {
      await api("/api/analytics/google/merchant-center", { method: "DELETE", query: { organisationId } });
      setMessage({ tone: "success", text: "Google Merchant Center is disconnected and its data removed." });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
      status.reload();
      onChanged();
    }
  }

  const run = data.lastLoad;
  const needsAccount = Boolean(connection && !connection.accountId);
  return (
    <Card
      title="Google Merchant Center"
      description="Your products as Google Shopping has them: whether each is approved, its problems, price and stock as Google sees them, and clicks and impressions by product and day."
      actions={
        canManage && connection && connection.accountId && !connection.needsReconnect ? (
          <Button size="small" onClick={() => void refresh()} disabled={busy !== null}>
            {busy === "load" ? "Loading…" : "Refresh now"}
          </Button>
        ) : null
      }
    >
      {returned ? <Notice tone={returned.ok ? "success" : "error"}>{returned.message}</Notice> : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {!connection ? (
        <>
          <p className={ui.muted}>
            Not connected. An admin signs in with a Google account that&apos;s a user of the Merchant Center account.{" "}
            <InfoTip label="Connecting">Tohyee only reads Merchant Center. It never changes products or settings there.</InfoTip>
          </p>
          {canManage ? (
            <>
              <CloudHelp callbackPath={data.callbackPath} />
              <div className={ui.rowButtons}>
                <Button onClick={() => void signIn()} disabled={busy !== null}>{busy === "connect" ? "Opening Google…" : "Sign in with Google"}</Button>
              </div>
            </>
          ) : null}
        </>
      ) : (
        <>
          {connection.needsReconnect ? (
            <Notice tone="warning">
              Google no longer accepts this sign-in, so nothing loads. {canManage ? "Connect again below." : "An admin needs to connect again."}
            </Notice>
          ) : null}
          <p className={ui.muted} style={{ overflowWrap: "anywhere" }}>
            {connection.accountId ? <strong>{connection.accountName ?? `Account ${connection.accountId}`}</strong> : "Signed in. Choose the Merchant Center account to load."}
            {connection.googleEmail ? ` · Signed in as ${connection.googleEmail}` : ""}
            {` · ${connection.reloadDaily ? "loads nightly after 4am" : "loads by hand only"}`}
          </p>
          <p className={ui.muted}>
            {run ? (
              <>
                <Badge tone={run.status === "ok" ? "green" : run.status === "failed" ? "red" : "blue"}>{run.status === "ok" ? "Loaded" : run.status === "failed" ? "Failed" : "Loading…"}</Badge>{" "}
                Last load {formatDateTime(run.startedAt)}
                {run.rowsLoaded ? ` · ${rows(run.rowsLoaded)} rows` : ""}
                {run.error ? ` · ${run.error}` : ""}
              </>
            ) : connection.accountId ? (
              "Not loaded yet."
            ) : null}
          </p>
          {connection.accountId ? (
            <details style={{ overflowWrap: "anywhere" }}>
              <summary>View the {data.tables.length} tables and what they hold</summary>
              <dl>
                {data.tables.map((table) => (
                  <div key={table}>
                    <dt>
                      <strong>{tableLabel(table)}</strong> <code>{table}</code>
                    </dt>
                    <dd style={{ margin: "0 0 8px" }}>{tableDescription(table)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
          {canManage && (choosing || needsAccount) && !connection.needsReconnect ? (
            <AccountChooser
              organisationId={organisationId}
              current={connection}
              onCancel={needsAccount ? undefined : () => setChoosing(false)}
              onSaved={(text, tone) => {
                setChoosing(false);
                setMessage({ tone, text });
                status.reload();
                onChanged();
              }}
            />
          ) : null}
          {canManage ? (
            <>
              {connection.needsReconnect ? <CloudHelp callbackPath={data.callbackPath} /> : null}
              <div className={ui.rowButtons}>
                {connection.needsReconnect ? (
                  <Button onClick={() => void signIn()} disabled={busy !== null}>{busy === "connect" ? "Opening Google…" : "Connect again"}</Button>
                ) : null}
                {connection.accountId && !choosing && !connection.needsReconnect ? (
                  <Button size="small" variant="secondary" onClick={() => setChoosing(true)} disabled={busy !== null}>
                    Change account or settings
                  </Button>
                ) : null}
                <Button size="small" variant="danger" onClick={() => void disconnect()} disabled={busy !== null}>
                  {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
                </Button>
              </div>
            </>
          ) : null}
        </>
      )}
    </Card>
  );
}

function AccountChooser({
  organisationId,
  current,
  onCancel,
  onSaved,
}: {
  organisationId: string;
  current: NonNullable<GmcStatus["connection"]>;
  onCancel?: () => void;
  onSaved: (text: string, tone: "success" | "error") => void;
}) {
  const list = useApiData<{ accounts: GmcAccount[] }>("/api/analytics/google/merchant-center/accounts", { organisationId });
  const [accountId, setAccountId] = useState(current.accountId ?? "");
  const [reloadDaily, setReloadDaily] = useState(current.reloadDaily);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accounts = list.data?.accounts ?? [];
  const chosen = accountId || accounts[0]?.accountId || "";

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/analytics/google/merchant-center", { method: "PATCH", body: { organisationId, ...(chosen !== current.accountId ? { accountId: chosen } : {}), reloadDaily } });
      const { run } = await api<{ run: LoadRun }>("/api/analytics/google/merchant-center/load", { method: "POST", body: { organisationId } });
      onSaved(run.status === "ok" ? `Saved, and loaded ${rows(run.rowsLoaded)} rows from Merchant Center.` : `Saved, but Merchant Center didn't load: ${run.error}`, run.status === "ok" ? "success" : "error");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {list.loading ? <p className={ui.muted}>Asking Google for your Merchant Center accounts…</p> : null}
      {list.data && accounts.length === 0 ? <Notice tone="warning">This Google account isn&apos;t a user of any Merchant Center account. Sign in with one that is.</Notice> : null}
      {accounts.length ? (
        <Field label="Merchant Center account">
          <select value={chosen} onChange={(event) => setAccountId(event.target.value)}>
            {accounts.map((account) => (
              <option key={account.accountId} value={account.accountId}>
                {account.name} ({account.accountId})
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {accounts.length ? (
        <label className={ui.checkbox}>
          <input type="checkbox" checked={reloadDaily} onChange={(event) => setReloadDaily(event.target.checked)} /> Load again every night after 4am
        </label>
      ) : null}
      <div className={ui.rowButtons}>
        <Button onClick={() => void save()} disabled={busy || !chosen}>
          {busy ? "Saving and loading…" : "Save and load"}
        </Button>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}
