"use client";

import { InfoTip } from "@/components/info-tip";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import type { GadsAccount, GadsChoice } from "@/lib/analytics/google-ads";
import type { GbpChoice, GbpLocation } from "@/lib/analytics/business-profile";
import type { SourceStatus } from "@/lib/analytics/google-source";
import { tableDescription, tableLabel } from "@/lib/analytics/labels";
import type { LoadRun } from "@/lib/analytics/sources";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";

type Option = { value: string; label: string };

type Spec<C> = {
  api: string;
  title: string;
  description: string;
  /** What's chosen, in words, or null when nothing is yet. */
  chosen: (connection: C) => string | null;
  /** The list to choose from: its address under `api`, the key in its answer, and each entry as an option. */
  list: { path: string; key: string; option: (entry: never) => Option; noun: string; empty: string };
  /** The PATCH body's key for the choice. */
  field: string;
  current: (connection: C) => string | null;
  cloud: (origin: string, callbackPath: string) => ReactNode;
  notConnected: ReactNode;
};

function rows(value: string | null): string {
  return value === null ? "" : Number(value).toLocaleString("en-NZ");
}

function cloudHelp(api: string, scope: string, approval: ReactNode) {
  return function Help(origin: string, callbackPath: string) {
    return (
      <details style={{ overflowWrap: "anywhere" }}>
        <summary>What an admin sets up in Google Cloud first</summary>
        <ol style={{ paddingLeft: 20 }}>
          <li>
            Tohyee signs in with the Google app saved under <Link href="/operations/settings/email">Settings › Email</Link>, returning to the same address as Google
            Analytics: <code style={{ wordBreak: "break-all" }}>{origin}{callbackPath}</code>.
          </li>
          <li>{approval}</li>
          <li>In the same Google Cloud project, enable the <strong>{api}</strong> (APIs &amp; Services › Library).</li>
          <li>
            On the consent screen (Google Auth Platform › Data access), add the scope <code style={{ wordBreak: "break-all" }}>{scope}</code>. Google has no read-only kind of
            it; Tohyee only ever reads.
          </li>
          <li>While the app&apos;s publishing status is <strong>Testing</strong>, Google ends each sign-in after 7 days and you&apos;ll need to connect again.</li>
        </ol>
      </details>
    );
  };
}

/** Google Business Profile in Analytics › Data sources. */
export const BUSINESS_PROFILE: Spec<GbpChoice> = {
  api: "/api/analytics/google/business-profile",
  title: "Google Business Profile",
  description: "The business's Google listing on Search and Maps: views, calls, direction requests and website clicks by day, reviews and replies, and what people searched for.",
  chosen: (connection) => connection.locationTitle,
  list: {
    path: "locations",
    key: "locations",
    option: ((entry: GbpLocation) => ({ value: entry.locationName, label: entry.address ? `${entry.title} (${entry.address})` : entry.title })) as (entry: never) => Option,
    noun: "Business Profile",
    empty: "This Google account doesn't manage any Business Profile. Sign in with one that does.",
  },
  field: "locationName",
  current: (connection) => connection.locationName,
  cloud: cloudHelp(
    "Business Profile Performance API, My Business Account Management API, My Business Business Information API and Google My Business API",
    "https://www.googleapis.com/auth/business.manage",
    <>
      Google lets only approved projects use the Business Profile APIs. Request access for the Google Cloud project with Google&apos;s Business Profile API access form; Google
      says it reviews requests within 14 days. Until then, loading is refused.
    </>,
  ),
  notConnected: <>Not connected. An admin signs in with a Google account that manages the business&apos;s profile.</>,
};

/** Google Ads in Analytics › Data sources. */
export const GOOGLE_ADS: Spec<GadsChoice> = {
  api: "/api/analytics/google/google-ads",
  title: "Google Ads",
  description: "Spend, clicks, impressions and conversions by campaign, ad group and keyword each day, to set beside Advertising in the books.",
  chosen: (connection) => (connection.customerName ? `${connection.customerName}${connection.currency ? ` (${connection.currency})` : ""}` : null),
  list: {
    path: "accounts",
    key: "accounts",
    option: ((entry: GadsAccount) => ({
      value: entry.customerId,
      label: `${entry.name} (${entry.customerId.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3")}${entry.loginCustomerId ? ", through a manager account" : ""})`,
    })) as (entry: never) => Option,
    noun: "Google Ads account",
    empty: "This Google account can't see any Google Ads accounts. Sign in with one that can.",
  },
  field: "customerId",
  current: (connection) => connection.customerId,
  cloud: cloudHelp(
    "Google Ads API",
    "https://www.googleapis.com/auth/adwords",
    <>
      Google lets a Google Cloud project reach real ads accounts only once it has <strong>Basic access</strong>: apply on the Google Ads API page of the project in Google Cloud.
      Until then, loading is refused.
    </>,
  ),
  notConnected: <>Not connected. An admin signs in with a Google account that can see the ads account.</>,
};

export function GoogleSourceCard<C>({
  spec,
  organisationId,
  canManage,
  onlyIfConnected = false,
  returned,
  onChanged,
}: {
  spec: Spec<C>;
  organisationId: string;
  canManage: boolean;
  onlyIfConnected?: boolean;
  returned?: { ok: boolean; message: string } | null;
  onChanged: () => void;
}) {
  const status = useApiData<SourceStatus<C>>(spec.api, { organisationId });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const confirm = useConfirm();

  if (status.error) return onlyIfConnected ? null : <Notice tone="error">{status.error}</Notice>;
  const data = status.data;
  if (!data) return null;
  const connection = data.connection;
  if (onlyIfConnected && !connection) return null;
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  async function signIn() {
    setBusy("connect");
    setMessage(null);
    try {
      const { url } = await api<{ url: string }>(spec.api, { method: "POST", body: { organisationId } });
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
      const { run } = await api<{ run: LoadRun }>(`${spec.api}/load`, { method: "POST", body: { organisationId } });
      setMessage(run.status === "ok" ? { tone: "success", text: `Loaded ${rows(run.rowsLoaded)} rows from ${spec.title}.` } : { tone: "error", text: `${spec.title} didn't load: ${run.error}` });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
      status.reload();
      onChanged();
    }
  }

  async function disconnect() {
    const ok = await confirm(`Tohyee deletes the Google sign-in and every ${spec.title} table it loaded. Reports that use them will show no data. Nothing changes at Google. The load history stays.`, {
      title: `Disconnect ${spec.title}?`,
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok) return;
    setBusy("disconnect");
    setMessage(null);
    try {
      await api(spec.api, { method: "DELETE", query: { organisationId } });
      setMessage({ tone: "success", text: `${spec.title} is disconnected and its data removed.` });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
      status.reload();
      onChanged();
    }
  }

  const run = data.lastLoad;
  const chosen = connection ? spec.chosen(connection) : null;
  const needsChoice = Boolean(connection && !chosen);
  return (
    <Card
      title={spec.title}
      description={spec.description}
      actions={
        canManage && connection && chosen && !connection.needsReconnect ? (
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
            {spec.notConnected} <InfoTip label="Connecting">Tohyee only reads. It never changes anything at Google.</InfoTip>
          </p>
          {canManage ? (
            <>
              {spec.cloud(origin, data.callbackPath)}
              <div className={ui.rowButtons}>
                <Button onClick={() => void signIn()} disabled={busy !== null}>{busy === "connect" ? "Opening Google…" : "Sign in with Google"}</Button>
              </div>
            </>
          ) : null}
        </>
      ) : (
        <>
          {connection.needsReconnect ? <Notice tone="warning">Google no longer accepts this sign-in, so nothing loads. {canManage ? "Connect again below." : "An admin needs to connect again."}</Notice> : null}
          <p className={ui.muted} style={{ overflowWrap: "anywhere" }}>
            {chosen ? <strong>{chosen}</strong> : `Signed in. Choose the ${spec.list.noun} to load.`}
            {connection.googleEmail ? ` · Signed in as ${connection.googleEmail}` : ""}
            {` · ${connection.reloadDaily ? "loads nightly after 4am" : "loads by hand only"}`}
          </p>
          <p className={ui.muted}>
            {run ? (
              <>
                <Badge tone={run.status === "ok" ? "green" : run.status === "failed" ? "red" : "blue"}>{run.status === "ok" ? "Loaded" : run.status === "failed" ? "Failed" : "Loading…"}</Badge> Last load{" "}
                {formatDateTime(run.startedAt)}
                {run.rowsLoaded ? ` · ${rows(run.rowsLoaded)} rows` : ""}
                {run.error ? ` · ${run.error}` : ""}
              </>
            ) : chosen ? (
              "Not loaded yet."
            ) : null}
          </p>
          {chosen ? (
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
          {canManage && (choosing || needsChoice) && !connection.needsReconnect ? (
            <Chooser
              spec={spec}
              organisationId={organisationId}
              current={spec.current(connection)}
              reloadDaily={connection.reloadDaily}
              onCancel={needsChoice ? undefined : () => setChoosing(false)}
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
              {connection.needsReconnect ? spec.cloud(origin, data.callbackPath) : null}
              <div className={ui.rowButtons}>
                {connection.needsReconnect ? <Button onClick={() => void signIn()} disabled={busy !== null}>{busy === "connect" ? "Opening Google…" : "Connect again"}</Button> : null}
                {chosen && !choosing && !connection.needsReconnect ? (
                  <Button size="small" variant="secondary" onClick={() => setChoosing(true)} disabled={busy !== null}>
                    Change {spec.list.noun} or settings
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

function Chooser<C>({
  spec,
  organisationId,
  current,
  reloadDaily: savedDaily,
  onCancel,
  onSaved,
}: {
  spec: Spec<C>;
  organisationId: string;
  current: string | null;
  reloadDaily: boolean;
  onCancel?: () => void;
  onSaved: (text: string, tone: "success" | "error") => void;
}) {
  const list = useApiData<Record<string, never[]>>(`${spec.api}/${spec.list.path}`, { organisationId });
  const [value, setValue] = useState(current ?? "");
  const [reloadDaily, setReloadDaily] = useState(savedDaily);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = (list.data?.[spec.list.key] ?? []).map((entry) => spec.list.option(entry));
  const chosen = value || options[0]?.value || "";

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(spec.api, { method: "PATCH", body: { organisationId, ...(chosen !== current ? { [spec.field]: chosen } : {}), reloadDaily } });
      const { run } = await api<{ run: LoadRun }>(`${spec.api}/load`, { method: "POST", body: { organisationId } });
      onSaved(run.status === "ok" ? `Saved, and loaded ${rows(run.rowsLoaded)} rows from ${spec.title}.` : `Saved, but ${spec.title} didn't load: ${run.error}`, run.status === "ok" ? "success" : "error");
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
      {list.loading ? <p className={ui.muted}>Asking Google…</p> : null}
      {list.data && options.length === 0 ? <Notice tone="warning">{spec.list.empty}</Notice> : null}
      {options.length ? (
        <Field label={spec.list.noun}>
          <select value={chosen} onChange={(event) => setValue(event.target.value)}>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {options.length ? (
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
