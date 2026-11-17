import { writeAuditEvent } from "@/lib/audit";
import { dropTablesWithPrefix, replaceTableSet, type TableCopy } from "@/lib/analytics/engine";
import { GA_CALLBACK_PATH, newGoogleState } from "@/lib/analytics/google-analytics";
import {
  GMC_LOAD_TABLE_NAME,
  GMC_MAX_PAGES,
  GMC_PAGE_SIZE,
  GMC_SOURCE_NAME,
  GMC_TABLE_PREFIX,
  GMC_TABLES,
  type GmcPerformanceRow,
  type GmcProduct,
  gmcDayRows,
  gmcIssueRows,
  gmcPerformanceQuery,
  gmcProductRows,
  gmcTableColumns,
  gmcWindow,
} from "@/lib/analytics/merchant-center-reports";
import { rebuildShapedTablesForTables, shapesUsing } from "@/lib/analytics/shaped-tables";
import { type LoadRun, requireAnalytics, RUN_COLUMNS, type RunRow, toRun } from "@/lib/analytics/sources";
import { authorisationUrl, exchangeCode, googleAccountAddress, type ProviderApp, type Tokens } from "@/lib/crm/mail/providers";
import { allPages, freshAccessToken, googleProblem, googleRequest, setGoogleSourceRetryDelaysForTests, SHARED_GOOGLE_ACCOUNT_SQL, withdrawGoogleSignIn } from "@/lib/analytics/google-source";
import { googleApp } from "@/lib/crm/mail/service";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { businessTimeZone, isoDateAt } from "@/lib/dates";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";

/*
 * Google Merchant Center as an Analytics data source (examples GMC1-GMC8), built like Google Search Console (decisions
 * 1180-1189). An admin signs in with Google through the organisation's own
 * Google app (Settings › Email), allowing Merchant Center; chooses one
 * Merchant Center account; and Tohyee loads its products as Google has
 * them, their problems, and clicks and impressions by product and day
 * (about 13 months) into `google_merchant_center_*` tables, replacing them
 * at each load. Tohyee only reads: Google's Merchant Center permission has
 * no read-only kind, so the code never sends anything but reads. Tokens
 * are stored encrypted. Network calls happen outside database
 * transactions.
 */

export const GMC_SCOPE = "https://www.googleapis.com/auth/content";
export const GMC_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", GMC_SCOPE];
const API = "https://merchantapi.googleapis.com";

export type GmcConnection = {
  googleEmail: string | null;
  accountId: string | null;
  accountName: string | null;
  reloadDaily: boolean;
  needsReconnect: boolean;
  connectedByEmail: string;
  connectedAt: string;
};
export type GmcStatus = { connection: GmcConnection | null; lastLoad: LoadRun | null; callbackPath: string; tables: string[] };
export type GmcAccount = { accountId: string; name: string };

type ConnectionRow = {
  google_email: string;
  refresh_token_ciphertext: string;
  access_token_ciphertext: string | null;
  access_token_expires_at: Date | null;
  account_id: string | null;
  account_name: string | null;
  reload_daily: boolean;
  needs_reconnect: boolean;
  connected_by_email: string;
  connected_at: Date;
};

const COLUMNS = "google_email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, account_id, account_name, reload_daily, needs_reconnect, connected_by_email, connected_at";

async function connectionRow(tx: OrgTx, lock = false): Promise<ConnectionRow | null> {
  const result = await tx.query<ConnectionRow>(`select ${COLUMNS} from analytics_merchant_center_connections where id = true${lock ? " for update" : ""}`);
  return result.rows[0] ?? null;
}

function toConnection(row: ConnectionRow, showEmail: boolean): GmcConnection {
  return {
    googleEmail: showEmail ? row.google_email : null,
    accountId: row.account_id,
    accountName: row.account_name,
    reloadDaily: row.reload_daily,
    needsReconnect: row.needs_reconnect,
    connectedByEmail: row.connected_by_email,
    connectedAt: new Date(row.connected_at).toISOString(),
  };
}

export async function lastGmcRun(tx: OrgTx): Promise<LoadRun | null> {
  const result = await tx.query<RunRow>(
    `select ${RUN_COLUMNS} from analytics_load_runs where source_id is null and table_name = $1 order by started_at desc, id desc limit 1`,
    [GMC_LOAD_TABLE_NAME],
  );
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

/** The connection (if any), its last load and its tables. Anyone in the organisation; the Google address only for admins. */
export async function getGmcStatus(tx: OrgTx, isAdmin: boolean): Promise<GmcStatus> {
  await requireAnalytics(tx);
  const row = await connectionRow(tx);
  return { connection: row ? toConnection(row, isAdmin) : null, lastLoad: await lastGmcRun(tx), callbackPath: GA_CALLBACK_PATH, tables: GMC_TABLES.map((table) => table.table) };
}

function redirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${GA_CALLBACK_PATH}`;
}

// Connecting (GMC1) ---------------------------------------------------------------------------

/** Google's sign-in address for Merchant Center, returning to the shared Google address. The route checks the role. */
export async function startGmcConnect(tx: OrgTx, origin: string): Promise<{ url: string }> {
  await requireAnalytics(tx);
  if (!tx.actor.userId) throw new ForbiddenError("Sign in to connect Google Merchant Center.");
  if (!secretsAvailable()) throw new UnavailableError("The server has no TOHYEE_SECRET_KEY, so it can't store Google's sign-in.");
  const app = await googleApp(tx);
  const state = await newGoogleState(tx, "merchant_center");
  return { url: authorisationUrl("google", app, redirectUri(origin), state, GMC_SCOPES) };
}

export type GmcSignIn = { tokens: Tokens; email: string };

/** Exchanges the code and finds the Google account's address (network, no transaction). */
export async function fetchGmcSignIn(app: ProviderApp, code: string, origin: string): Promise<GmcSignIn> {
  const tokens = await exchangeCode("google", app, code, redirectUri(origin));
  if (!tokens.refreshToken) throw new ValidationError("The sign-in didn't allow offline access, so Tohyee can't load every night. Try connecting again.");
  if (tokens.scope && !new Set(tokens.scope.split(/\s+/)).has(GMC_SCOPE)) {
    throw new ValidationError("The sign-in didn't allow Merchant Center. Connect again and tick the box for your Merchant Center data.");
  }
  const email = (await googleAccountAddress(tokens.accessToken)).toLowerCase();
  return { tokens, email };
}

/** Stores the sign-in (tokens encrypted). Connecting again keeps the account and its settings. */
export async function saveGmcSignIn(tx: OrgTx, signIn: GmcSignIn, now = new Date()): Promise<GmcConnection> {
  await requireAnalytics(tx);
  await tx.query(
    `insert into analytics_merchant_center_connections (id, google_email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, connected_by_email)
     values (true, $1, $2, $3, $4, $5)
     on conflict (id) do update set google_email = excluded.google_email, refresh_token_ciphertext = excluded.refresh_token_ciphertext,
            access_token_ciphertext = excluded.access_token_ciphertext, access_token_expires_at = excluded.access_token_expires_at,
            connected_by_email = excluded.connected_by_email, connected_at = now(), needs_reconnect = false, updated_at = now()`,
    [signIn.email, encryptSecret(signIn.tokens.refreshToken!), encryptSecret(signIn.tokens.accessToken), new Date(now.getTime() + signIn.tokens.expiresInSeconds * 1000).toISOString(), tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "analytics.merchant_center_connected", entityType: "analytics_merchant_center_connection", entityId: "google_merchant_center", details: { googleEmail: signIn.email } });
  return toConnection((await connectionRow(tx))!, true);
}

// Talking to Google ------------------------------------------------------------------------

const NAME = "Google Merchant Center";
/** What went wrong, in words an admin can act on (GMC6). */
const problem = googleProblem(
  NAME,
  "Merchant API",
  `Google says this Google account can't read that Merchant Center account's data. It needs to be a user of the account; clicks and impressions also need the "Performance and insights" access in Merchant Center.`,
);

function gmcRequest<T>(url: string, token: string, body?: unknown): Promise<T> {
  return googleRequest<T>(NAME, url, token, problem, body === undefined ? {} : { body });
}

/** Tests don't wait between retries. */
export function setGmcRetryDelaysForTests(delays: number[] | null): void {
  setGoogleSourceRetryDelaysForTests(delays);
}

async function loadConnection(organisation: OrganisationRecord, actor: Actor): Promise<{ row: ConnectionRow; app: ProviderApp }> {
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    const row = await connectionRow(tx);
    if (!row) throw new NotFoundError("Google Merchant Center isn't connected.");
    return { row, app: await googleApp(tx) };
  });
}

const reconnectMessage =
  "Google no longer accepts this Merchant Center sign-in (it ran out or was withdrawn). An admin needs to connect again. While the organisation's Google app is in Testing, Google ends sign-ins after 7 days.";

function accessToken(organisation: OrganisationRecord, actor: Actor, row: ConnectionRow, app: ProviderApp, now = new Date()): Promise<string> {
  return freshAccessToken(organisation, actor, "analytics_merchant_center_connections", row, app, reconnectMessage, now);
}

function pages<T, R>(fetchPage: (pageToken: string | null) => Promise<T & { nextPageToken?: string }>, items: (page: T) => R[] | undefined): Promise<R[]> {
  return allPages(NAME, GMC_MAX_PAGES, fetchPage, items);
}

// Choosing the account (GMC2) ------------------------------------------------------------------

/** The Merchant Center accounts the connected Google account can see, by name. */
export async function listGmcAccounts(organisation: OrganisationRecord, actor: Actor): Promise<GmcAccount[]> {
  const { row, app } = await loadConnection(organisation, actor);
  const token = await accessToken(organisation, actor, row, app);
  const accounts = await pages<{ accounts?: Array<{ accountId?: string; name?: string; accountName?: string }> }, { accountId?: string; name?: string; accountName?: string }>(
    (pageToken) => gmcRequest(`${API}/accounts/v1/accounts?pageSize=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, token),
    (page) => page.accounts,
  );
  const list: GmcAccount[] = [];
  for (const account of accounts) {
    const id = typeof account.accountId === "string" && /^\d{1,20}$/.test(account.accountId) ? account.accountId : typeof account.name === "string" ? (/^accounts\/(\d{1,20})$/.exec(account.name)?.[1] ?? null) : null;
    if (!id) continue;
    const name = typeof account.accountName === "string" && account.accountName.trim() ? account.accountName.trim().slice(0, 300) : `Account ${id}`;
    list.push({ accountId: id, name });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Chooses the account and nightly loading (GMC2). `available` is what
 * Google listed just now, needed only when the account changes. A new
 * account starts again: the caller drops the tables once this commits.
 */
export async function saveGmcSettings(tx: OrgTx, input: { accountId?: unknown; reloadDaily?: unknown }, available: GmcAccount[] | null): Promise<{ connection: GmcConnection; startAgain: boolean }> {
  await requireAnalytics(tx);
  const row = await connectionRow(tx, true);
  if (!row) throw new NotFoundError("Google Merchant Center isn't connected.");
  let account: GmcAccount | null = null;
  if (input.accountId !== undefined && input.accountId !== row.account_id) {
    account = available?.find((entry) => entry.accountId === input.accountId) ?? null;
    if (!account) throw new ValidationError("That isn't a Merchant Center account this Google account can see. Open the list again.");
  }
  if (!account && !row.account_id) throw new ValidationError("Choose the Merchant Center account to load.");
  if (input.reloadDaily !== undefined && typeof input.reloadDaily !== "boolean") throw new ValidationError("reloadDaily must be true or false.");
  const reloadDaily = input.reloadDaily === undefined ? row.reload_daily : (input.reloadDaily as boolean);
  await tx.query(
    "update analytics_merchant_center_connections set account_id = coalesce($1, account_id), account_name = coalesce($2, account_name), reload_daily = $3, updated_at = now() where id = true",
    [account?.accountId ?? null, account?.name ?? null, reloadDaily],
  );
  await writeAuditEvent(tx, {
    eventType: "analytics.merchant_center_settings_saved",
    entityType: "analytics_merchant_center_connection",
    entityId: "google_merchant_center",
    details: { accountId: account?.accountId ?? row.account_id, reloadDaily },
  });
  return { connection: toConnection((await connectionRow(tx))!, true), startAgain: Boolean(account) && Boolean(row.account_id) };
}

export function dropGmcTables(organisationId: string): Promise<string[]> {
  return dropTablesWithPrefix(organisationId, GMC_TABLE_PREFIX);
}

// Loading (GMC3-GMC6) ------------------------------------------------------------------------

/**
 * Loads the chosen account now (nightly, or Refresh now): its products and
 * their problems, and clicks and impressions by product and day for about
 * 13 months. Google is read with no transaction open; the three tables are
 * replaced together, so a failed load changes nothing (GMC3-GMC6).
 */
export async function refreshGmc(organisation: OrganisationRecord, actor: Actor, trigger: "schedule" | "manual", now = new Date()): Promise<LoadRun> {
  const started = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    const row = await connectionRow(tx);
    if (!row) throw new NotFoundError("Google Merchant Center isn't connected.");
    if (!row.account_id) throw new ConflictError("Choose the Merchant Center account to load first.");
    const busy = await tx.query("select 1 from analytics_load_runs where source_id is null and table_name = $1 and status = 'running' and started_at > now() - interval '1 hour'", [GMC_LOAD_TABLE_NAME]);
    if (busy.rows.length > 0) throw new ConflictError("Google Merchant Center is loading already.");
    const run = await tx.query<{ id: string }>(
      `insert into analytics_load_runs (source_id, source_name, table_name, file_name, trigger, requested_by_email)
       values (null, $1, $2, $3, $4, $5) returning id::text`,
      [GMC_SOURCE_NAME, GMC_LOAD_TABLE_NAME, row.account_name ?? `Account ${row.account_id}`, trigger, trigger === "manual" ? actor.email : null],
    );
    return { runId: run.rows[0].id, accountId: row.account_id };
  });

  const began = performance.now();
  let rows: number | null = null;
  let error: string | null = null;
  try {
    const { row, app } = await loadConnection(organisation, actor);
    const token = await accessToken(organisation, actor, row, app, now);
    const account = encodeURIComponent(started.accountId);
    const products = await pages<{ products?: GmcProduct[] }, GmcProduct>(
      (pageToken) => gmcRequest(`${API}/products/v1/accounts/${account}/products?pageSize=${GMC_PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, token),
      (page) => page.products,
    );
    const window = gmcWindow(isoDateAt(now, businessTimeZone()));
    const days = await pages<{ results?: GmcPerformanceRow[] }, GmcPerformanceRow>(
      (pageToken) =>
        gmcRequest(`${API}/reports/v1/accounts/${account}/reports:search`, token, { query: gmcPerformanceQuery(window.from, window.to), pageSize: GMC_PAGE_SIZE, ...(pageToken ? { pageToken } : {}) }),
      (page) => page.results,
    );
    const byName: Record<string, Array<Array<string | null>>> = {
      google_merchant_center_products: gmcProductRows(products),
      google_merchant_center_issues: gmcIssueRows(products),
      google_merchant_center_product_days: gmcDayRows(days),
    };
    const tables: TableCopy[] = GMC_TABLES.map((table) => ({ name: table.table, columns: gmcTableColumns(table), rows: byName[table.table] }));
    rows = await replaceTableSet(organisation.id, GMC_TABLE_PREFIX, tables, "The Merchant Center data couldn't be loaded");
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const milliseconds = Math.round(performance.now() - began);
  const run = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const result = await tx.query<RunRow>(
      `update analytics_load_runs set status = $2, finished_at = now(), rows_loaded = $3, milliseconds = $4, error = $5 where id = $1 returning ${RUN_COLUMNS}`,
      [started.runId, error ? "failed" : "ok", rows === null ? null : String(rows), milliseconds, error],
    );
    return toRun(result.rows[0]);
  });
  if (!error) {
    try {
      await rebuildShapedTablesForTables(organisation, actor, GMC_TABLES.map((table) => table.table), trigger);
    } catch (caught) {
      console.warn("[tohyee] Shaped tables after loading Google Merchant Center:", caught instanceof Error ? caught.message : caught);
    }
  }
  return run;
}

/** Whether the nightly load should consider Merchant Center: an account chosen, nightly on, and the sign-in still good. */
export async function gmcLoadsNightly(tx: OrgTx): Promise<boolean> {
  const row = await connectionRow(tx);
  return Boolean(row && row.account_id && row.reload_daily && !row.needs_reconnect);
}

// Disconnecting (GMC7) ------------------------------------------------------------------------

/**
 * Disconnects: deletes the tokens and the connection, then (after it
 * commits) asks Google to withdraw the sign-in, unless another Google
 * connection uses the same account, and drops every
 * `google_merchant_center_*` table. The load history stays. Refused while a
 * shaped table is built from the data, or a load is running.
 */
export async function disconnectGmc(organisation: OrganisationRecord, actor: Actor): Promise<void> {
  const refreshToken = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    const row = await connectionRow(tx, true);
    if (!row) throw new NotFoundError("Google Merchant Center isn't connected.");
    const running = await tx.query("select 1 from analytics_load_runs where source_id is null and table_name = $1 and status = 'running' and started_at > now() - interval '1 hour'", [GMC_LOAD_TABLE_NAME]);
    if (running.rows.length > 0) throw new ConflictError("Google Merchant Center is loading. Try again when it's finished.");
    const users = new Set<string>();
    for (const table of GMC_TABLES) for (const name of await shapesUsing(tx, table.table)) users.add(name);
    if (users.size > 0) {
      const list = [...users];
      throw new ConflictError(`The shaped table${list.length === 1 ? "" : "s"} ${list.join(", ")} ${list.length === 1 ? "uses" : "use"} Merchant Center data. Change or remove ${list.length === 1 ? "it" : "them"} first.`);
    }
    await tx.query("delete from analytics_merchant_center_connections where id = true");
    await tx.query("delete from analytics_google_states where product = 'merchant_center'");
    await writeAuditEvent(tx, { eventType: "analytics.merchant_center_disconnected", entityType: "analytics_merchant_center_connection", entityId: "google_merchant_center", details: { accountId: row.account_id } });
    // Google may withdraw everything the account allowed this Google app, so not while another Google connection uses it.
    const shared = await tx.query(SHARED_GOOGLE_ACCOUNT_SQL, [row.google_email]);
    return shared.rows.length ? null : decryptSecret(row.refresh_token_ciphertext);
  });
  if (refreshToken) await withdrawGoogleSignIn(refreshToken);
  await dropGmcTables(organisation.id);
}
