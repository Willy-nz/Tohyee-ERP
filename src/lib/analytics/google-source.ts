import { authorisationUrl, exchangeCode, googleAccountAddress, ProviderError, providerFetch, type ProviderApp, refreshAccess, type Tokens } from "@/lib/crm/mail/providers";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { writeAuditEvent } from "@/lib/audit";
import { dropTablesWithPrefix, replaceTableSet, type TableCopy } from "@/lib/analytics/engine";
import { GA_CALLBACK_PATH, type GoogleProduct, newGoogleState } from "@/lib/analytics/google-analytics";
import { rebuildShapedTablesForTables, shapesUsing } from "@/lib/analytics/shaped-tables";
import { type LoadRun, requireAnalytics, RUN_COLUMNS, type RunRow, toRun } from "@/lib/analytics/sources";
import { googleApp } from "@/lib/crm/mail/service";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";

/*
 * What Google Merchant Center, Business Profile and Ads share as Analytics
 * sources: asking Google with retries, keeping the
 * sign-in's access token fresh, and reading every page of a list. Each
 * source has its own connection table with the same token columns.
 */

export type GoogleSourceTable = "analytics_merchant_center_connections" | "analytics_business_profile_connections" | "analytics_google_ads_connections";

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null,
    readonly detail: string,
  ) {
    super(detail);
  }
}

let retryDelaysMs = [5_000, 15_000, 45_000];
/** Tests don't wait between retries. */
export function setGoogleSourceRetryDelaysForTests(delays: number[] | null): void {
  retryDelaysMs = delays ?? [5_000, 15_000, 45_000];
}

const TIMEOUT_MS = 60_000;

/**
 * One request to a Google API. Passing limits and outages
 * are tried again after 5, 15 and 45 seconds; any other refusal goes to
 * `problem`, which says what an admin can do about it.
 */
export async function googleRequest<T>(
  name: string,
  url: string,
  token: string,
  problem: (error: GoogleApiError) => Error,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await providerFetch(url, {
        method: options.body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt < retryDelaysMs.length) {
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
        continue;
      }
      throw new UnavailableError(`Couldn't reach ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const textBody = await response.text();
    let parsed: unknown = null;
    try {
      parsed = textBody ? JSON.parse(textBody) : null;
    } catch {
      parsed = null;
    }
    if (response.ok) {
      if (parsed === null && !textBody) return {} as T;
      if (!parsed || typeof parsed !== "object") throw new ValidationError(`${name} sent an answer Tohyee can't read.`);
      return parsed as T;
    }
    const body = Array.isArray(parsed) ? parsed[0] : parsed;
    const failure = (body as { error?: { message?: string; status?: string; details?: Array<{ reason?: string; errors?: Array<{ errorCode?: Record<string, string> }> }> } } | null)?.error;
    const reason =
      failure?.details?.find((entry) => typeof entry?.reason === "string")?.reason ??
      failure?.details?.flatMap((entry) => entry.errors ?? []).map((entry) => Object.values(entry.errorCode ?? {})[0])[0] ??
      failure?.status ??
      null;
    const error = new GoogleApiError(response.status, reason ?? null, typeof failure?.message === "string" ? failure.message : textBody.slice(0, 300));
    if ((response.status === 429 || response.status === 500 || response.status === 503) && attempt < retryDelaysMs.length) {
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
      continue;
    }
    throw problem(error);
  }
}

/** The usual words for a refusal: limits, a disabled API, a refused sign-in, an outage. `forbidden` says what a 403 means for this source. */
export function googleProblem(name: string, apiName: string, forbidden: string): (error: GoogleApiError) => Error {
  return (error) => {
    const google = error.detail ? ` Google said: ${error.detail.slice(0, 300)}` : "";
    if (error.status === 429 || error.reason === "RESOURCE_EXHAUSTED") return new UnavailableError(`${name}'s limit is used up for now. The data already loaded is kept; try again later.`);
    if (error.reason === "SERVICE_DISABLED" || /has not been used in project|is disabled/i.test(error.detail)) {
      return new ConflictError(`The ${apiName} isn't turned on in the Google Cloud project of this organisation's Google app. An admin needs to enable it in Google Cloud (APIs & Services › Library), then try again.${google}`);
    }
    if (error.status === 401) return new ConflictError(`Google didn't accept the sign-in. Connect ${name} again.`);
    if (error.status === 403) return new ConflictError(`${forbidden}${google}`);
    if (error.status >= 500) return new UnavailableError(`${name} isn't answering just now. The data already loaded is kept; try again later.${google}`);
    return new ValidationError(`${name} refused the request (${error.status}).${google}`);
  };
}

export type TokenRow = { refresh_token_ciphertext: string; access_token_ciphertext: string | null; access_token_expires_at: Date | null; needs_reconnect: boolean };

/** A current access token, refreshed (and stored) when it's about to run out. Google refusing the sign-in marks it for reconnecting. */
export async function freshAccessToken(
  organisation: OrganisationRecord,
  actor: Actor,
  table: GoogleSourceTable,
  row: TokenRow,
  app: ProviderApp,
  reconnectMessage: string,
  now = new Date(),
): Promise<string> {
  if (row.needs_reconnect) throw new ConflictError(reconnectMessage);
  if (row.access_token_ciphertext && row.access_token_expires_at && new Date(row.access_token_expires_at).getTime() > now.getTime() + 60_000) {
    return decryptSecret(row.access_token_ciphertext);
  }
  let refreshed: Tokens;
  try {
    refreshed = await refreshAccess("google", app, decryptSecret(row.refresh_token_ciphertext));
  } catch (error) {
    if (error instanceof ProviderError && (error.code === "invalid_grant" || error.status === 401)) {
      await withOrganisationTransaction(organisation, actor, (tx) => tx.query(`update ${table} set needs_reconnect = true, access_token_ciphertext = null, updated_at = now() where id = true`));
      throw new ConflictError(reconnectMessage);
    }
    throw error;
  }
  await withOrganisationTransaction(organisation, actor, (tx) =>
    tx.query(
      `update ${table} set access_token_ciphertext = $1, access_token_expires_at = $2, refresh_token_ciphertext = coalesce($3, refresh_token_ciphertext), updated_at = now() where id = true`,
      [encryptSecret(refreshed.accessToken), new Date(now.getTime() + refreshed.expiresInSeconds * 1000).toISOString(), refreshed.refreshToken ? encryptSecret(refreshed.refreshToken) : null],
    ),
  );
  return refreshed.accessToken;
}

/** Every page of a list, following nextPageToken, up to `maxPages`. */
export async function allPages<T, R>(
  name: string,
  maxPages: number,
  fetchPage: (pageToken: string | null) => Promise<T & { nextPageToken?: string }>,
  items: (page: T) => R[] | undefined,
): Promise<R[]> {
  const all: R[] = [];
  let token: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const answer = await fetchPage(token);
    all.push(...(items(answer) ?? []));
    token = typeof answer.nextPageToken === "string" && answer.nextPageToken ? answer.nextPageToken : null;
    if (!token) return all;
  }
  throw new ValidationError(`${name} sent more pages than Tohyee reads at once. Nothing was loaded.`);
}

/** Asks Google to withdraw a sign-in. A courtesy: the token is already deleted in Tohyee, so a failure doesn't matter. */
export async function withdrawGoogleSignIn(refreshToken: string): Promise<void> {
  try {
    await providerFetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Nothing more to do.
  }
}

/** Whether another Google connection uses the same Google account (so its sign-in mustn't be withdrawn). */
export const SHARED_GOOGLE_ACCOUNT_SQL = `select 1 from analytics_google_connections where google_email = $1
  union all select 1 from analytics_search_console_connections where google_email = $1
  union all select 1 from analytics_merchant_center_connections where google_email = $1
  union all select 1 from analytics_business_profile_connections where google_email = $1
  union all select 1 from analytics_google_ads_connections where google_email = $1`;

// A whole source --------------------------------------------------------------------------------
// Connecting, the saved choice, loading, nightly loads and disconnecting, the same for each of
// Merchant Center, Business Profile and Google Ads; each says what it chooses and how it loads.


/** The columns every source's connection table has. */
export type SourceRow = TokenRow & { google_email: string; reload_daily: boolean; connected_by_email: string; connected_at: Date } & Record<string, unknown>;

export type SourceConnection<C> = C & { googleEmail: string | null; reloadDaily: boolean; needsReconnect: boolean; connectedByEmail: string; connectedAt: string };
export type SourceStatus<C> = { connection: SourceConnection<C> | null; lastLoad: LoadRun | null; callbackPath: string; tables: string[] };

export type GoogleSourceSpec<C> = {
  product: GoogleProduct;
  table: GoogleSourceTable;
  /** "Google Business Profile" */
  name: string;
  /** The extra connection columns to read, after the shared ones. */
  columns: string[];
  scope: string;
  scopeRefused: string;
  prefix: string;
  loadTableName: string;
  tables: string[];
  /** The source's own part of the connection, from its row. */
  toConnection: (row: SourceRow) => C;
  /** Whether what it loads has been chosen. */
  chosen: (row: SourceRow) => boolean;
  chooseFirst: string;
  /** The load history's file name: what was loaded. */
  fileName: (row: SourceRow) => string;
  /** Reads Google (no transaction open) and returns the tables to replace. */
  load: (token: string, row: SourceRow, now: Date) => Promise<TableCopy[]>;
  auditKey: string;
};

const SHARED_COLUMNS = "google_email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, reload_daily, needs_reconnect, connected_by_email, connected_at";

export function googleSource<C>(spec: GoogleSourceSpec<C>) {
  const reconnectMessage = `Google no longer accepts this ${spec.name} sign-in (it ran out or was withdrawn). An admin needs to connect again. While the organisation's Google app is in Testing, Google ends sign-ins after 7 days.`;
  const read = async (tx: OrgTx, lock = false): Promise<SourceRow | null> => {
    const result = await tx.query<SourceRow>(`select ${SHARED_COLUMNS}, ${spec.columns.join(", ")} from ${spec.table} where id = true${lock ? " for update" : ""}`);
    return result.rows[0] ?? null;
  };
  const connectionOf = (row: SourceRow, showEmail: boolean): SourceConnection<C> => ({
    ...spec.toConnection(row),
    googleEmail: showEmail ? row.google_email : null,
    reloadDaily: row.reload_daily,
    needsReconnect: row.needs_reconnect,
    connectedByEmail: row.connected_by_email,
    connectedAt: new Date(row.connected_at).toISOString(),
  });
  const redirectUri = (origin: string) => `${origin.replace(/\/+$/, "")}${GA_CALLBACK_PATH}`;
  const running = (tx: OrgTx) =>
    tx.query("select 1 from analytics_load_runs where source_id is null and table_name = $1 and status = 'running' and started_at > now() - interval '1 hour'", [spec.loadTableName]);

  async function lastRun(tx: OrgTx): Promise<LoadRun | null> {
    const result = await tx.query<RunRow>(`select ${RUN_COLUMNS} from analytics_load_runs where source_id is null and table_name = $1 order by started_at desc, id desc limit 1`, [spec.loadTableName]);
    return result.rows[0] ? toRun(result.rows[0]) : null;
  }

  async function connection(organisation: OrganisationRecord, actor: Actor): Promise<{ row: SourceRow; token: (now?: Date) => Promise<string> }> {
    const { row, app } = await withOrganisationTransaction(organisation, actor, async (tx) => {
      await requireAnalytics(tx);
      const found = await read(tx);
      if (!found) throw new NotFoundError(`${spec.name} isn't connected.`);
      return { row: found, app: await googleApp(tx) };
    });
    return { row, token: (now = new Date()) => freshAccessToken(organisation, actor, spec.table, row, app, reconnectMessage, now) };
  }

  return {
    read,
    connectionOf,
    connection,
    async status(tx: OrgTx, isAdmin: boolean): Promise<SourceStatus<C>> {
      await requireAnalytics(tx);
      const row = await read(tx);
      return { connection: row ? connectionOf(row, isAdmin) : null, lastLoad: await lastRun(tx), callbackPath: GA_CALLBACK_PATH, tables: spec.tables };
    },
    /** Google's sign-in address for this source; the route checks the role. */
    async startConnect(tx: OrgTx, origin: string): Promise<{ url: string }> {
      await requireAnalytics(tx);
      if (!tx.actor.userId) throw new ForbiddenError(`Sign in to connect ${spec.name}.`);
      if (!secretsAvailable()) throw new UnavailableError("The server has no TOHYEE_SECRET_KEY, so it can't store Google's sign-in.");
      const app = await googleApp(tx);
      const state = await newGoogleState(tx, spec.product);
      return { url: authorisationUrl("google", app, redirectUri(origin), state, ["openid", "https://www.googleapis.com/auth/userinfo.email", spec.scope]) };
    },
    /** Exchanges the code and finds the Google account's address (network, no transaction). */
    async fetchSignIn(app: ProviderApp, code: string, origin: string): Promise<{ tokens: Tokens; email: string }> {
      const tokens = await exchangeCode("google", app, code, redirectUri(origin));
      if (!tokens.refreshToken) throw new ValidationError("The sign-in didn't allow offline access, so Tohyee can't load every night. Try connecting again.");
      if (tokens.scope && !new Set(tokens.scope.split(/\s+/)).has(spec.scope)) throw new ValidationError(spec.scopeRefused);
      return { tokens, email: (await googleAccountAddress(tokens.accessToken)).toLowerCase() };
    },
    /** Stores the sign-in (tokens encrypted). Connecting again keeps the choice and settings. */
    async saveSignIn(tx: OrgTx, signIn: { tokens: Tokens; email: string }, now = new Date()): Promise<SourceConnection<C>> {
      await requireAnalytics(tx);
      await tx.query(
        `insert into ${spec.table} (id, google_email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, connected_by_email)
         values (true, $1, $2, $3, $4, $5)
         on conflict (id) do update set google_email = excluded.google_email, refresh_token_ciphertext = excluded.refresh_token_ciphertext,
                access_token_ciphertext = excluded.access_token_ciphertext, access_token_expires_at = excluded.access_token_expires_at,
                connected_by_email = excluded.connected_by_email, connected_at = now(), needs_reconnect = false, updated_at = now()`,
        [signIn.email, encryptSecret(signIn.tokens.refreshToken!), encryptSecret(signIn.tokens.accessToken), new Date(now.getTime() + signIn.tokens.expiresInSeconds * 1000).toISOString(), tx.actor.email],
      );
      await writeAuditEvent(tx, { eventType: `analytics.${spec.auditKey}_connected`, entityType: spec.table.replace(/s$/, ""), entityId: spec.auditKey, details: { googleEmail: signIn.email } });
      return connectionOf((await read(tx))!, true);
    },
    /** Loads now (nightly, or Refresh now): Google is read with no transaction open, and the tables are replaced together, so a failed load changes nothing. */
    async refresh(organisation: OrganisationRecord, actor: Actor, trigger: "schedule" | "manual", now = new Date()): Promise<LoadRun> {
      const started = await withOrganisationTransaction(organisation, actor, async (tx) => {
        await requireAnalytics(tx);
        const row = await read(tx);
        if (!row) throw new NotFoundError(`${spec.name} isn't connected.`);
        if (!spec.chosen(row)) throw new ConflictError(spec.chooseFirst);
        if ((await running(tx)).rows.length > 0) throw new ConflictError(`${spec.name} is loading already.`);
        const run = await tx.query<{ id: string }>(
          `insert into analytics_load_runs (source_id, source_name, table_name, file_name, trigger, requested_by_email) values (null, $1, $2, $3, $4, $5) returning id::text`,
          [spec.name, spec.loadTableName, spec.fileName(row).slice(0, 255), trigger, trigger === "manual" ? actor.email : null],
        );
        return run.rows[0].id;
      });
      const began = performance.now();
      let rows: number | null = null;
      let error: string | null = null;
      try {
        const { row, token } = await connection(organisation, actor);
        const tables = await spec.load(await token(now), row, now);
        rows = await replaceTableSet(organisation.id, spec.prefix, tables, `The ${spec.name} data couldn't be loaded`);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const milliseconds = Math.round(performance.now() - began);
      const run = await withOrganisationTransaction(organisation, actor, async (tx) => {
        const result = await tx.query<RunRow>(`update analytics_load_runs set status = $2, finished_at = now(), rows_loaded = $3, milliseconds = $4, error = $5 where id = $1 returning ${RUN_COLUMNS}`, [
          started,
          error ? "failed" : "ok",
          rows === null ? null : String(rows),
          milliseconds,
          error,
        ]);
        return toRun(result.rows[0]);
      });
      if (!error) {
        try {
          await rebuildShapedTablesForTables(organisation, actor, spec.tables, trigger);
        } catch (caught) {
          console.warn(`[tohyee] Shaped tables after loading ${spec.name}:`, caught instanceof Error ? caught.message : caught);
        }
      }
      return run;
    },
    /** Whether the nightly load should consider it: chosen, nightly on, and the sign-in still good. */
    async loadsNightly(tx: OrgTx): Promise<boolean> {
      const row = await read(tx);
      return Boolean(row && spec.chosen(row) && row.reload_daily && !row.needs_reconnect);
    },
    dropTables(organisationId: string): Promise<string[]> {
      return dropTablesWithPrefix(organisationId, spec.prefix);
    },
    /** Deletes the sign-in and the tables; asks Google to withdraw it unless another Google source uses the account. Refused while a shaped table uses the data or a load runs. */
    async disconnect(organisation: OrganisationRecord, actor: Actor): Promise<void> {
      const refreshToken = await withOrganisationTransaction(organisation, actor, async (tx) => {
        await requireAnalytics(tx);
        const row = await read(tx, true);
        if (!row) throw new NotFoundError(`${spec.name} isn't connected.`);
        if ((await running(tx)).rows.length > 0) throw new ConflictError(`${spec.name} is loading. Try again when it's finished.`);
        const users = new Set<string>();
        for (const table of spec.tables) for (const name of await shapesUsing(tx, table)) users.add(name);
        if (users.size > 0) {
          const list = [...users];
          throw new ConflictError(`The shaped table${list.length === 1 ? "" : "s"} ${list.join(", ")} ${list.length === 1 ? "uses" : "use"} ${spec.name} data. Change or remove ${list.length === 1 ? "it" : "them"} first.`);
        }
        await tx.query(`delete from ${spec.table} where id = true`);
        await tx.query("delete from analytics_google_states where product = $1", [spec.product]);
        await writeAuditEvent(tx, { eventType: `analytics.${spec.auditKey}_disconnected`, entityType: spec.table.replace(/s$/, ""), entityId: spec.auditKey, details: {} });
        const shared = await tx.query(SHARED_GOOGLE_ACCOUNT_SQL, [row.google_email]);
        return shared.rows.length ? null : decryptSecret(row.refresh_token_ciphertext);
      });
      if (refreshToken) await withdrawGoogleSignIn(refreshToken);
      await dropTablesWithPrefix(organisation.id, spec.prefix);
    },
  };
}
