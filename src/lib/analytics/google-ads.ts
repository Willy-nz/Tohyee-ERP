import { writeAuditEvent } from "@/lib/audit";
import {
  customerId,
  GADS_API_VERSION,
  GADS_LOAD_TABLE_NAME,
  GADS_MAX_PAGES,
  GADS_TABLE_PREFIX,
  GADS_TABLES,
  type GadsRow,
  gadsQuery,
  gadsRows,
  gadsTableColumns,
  gadsWindow,
} from "@/lib/analytics/google-ads-reports";
import { allPages, googleProblem, googleRequest, googleSource, type SourceRow } from "@/lib/analytics/google-source";
import { requireAnalytics } from "@/lib/analytics/sources";
import { businessTimeZone, isoDateAt } from "@/lib/dates";
import type { Actor, OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { OrganisationRecord } from "@/lib/organisations/registry";

/*
 * Google Ads as an Analytics data source (examples GADS1-GADS7), built like Merchant Center. An admin signs in with
 * Google allowing Google Ads, chooses an ads account (directly, or through
 * a manager account), and Tohyee loads spend, clicks, impressions and
 * conversions by campaign, ad group and keyword each day for about 13
 * months, replacing the tables at each load. Tohyee only reads. Google
 * lets a Google Cloud project reach real ads accounts only once it has
 * Basic access: until then Google refuses and the load says so.
 */

export const GADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const NAME = "Google Ads";
const API = `https://googleads.googleapis.com/${GADS_API_VERSION}`;

const problem = googleProblem(
  NAME,
  "Google Ads API",
  "Google refused. Either this Google Cloud project doesn't have Google Ads API Basic access yet (Google reviews each application), or this Google account can't see that ads account.",
);

function search(token: string, customer: string, query: string, login: string | null): Promise<GadsRow[]> {
  return allPages(
    NAME,
    GADS_MAX_PAGES,
    (pageToken) =>
      googleRequest<{ results?: GadsRow[]; nextPageToken?: string }>(NAME, `${API}/customers/${customer}/googleAds:search`, token, problem, {
        body: { query, ...(pageToken ? { pageToken } : {}) },
        headers: login ? { "login-customer-id": login } : {},
      }),
    (page) => page.results,
  );
}

export type GadsChoice = { customerId: string | null; customerName: string | null; loginCustomerId: string | null; currency: string | null };
export type GadsAccount = { customerId: string; name: string; currency: string | null; loginCustomerId: string | null };

async function load(token: string, row: SourceRow, now: Date) {
  const customer = String(row.customer_id);
  const login = (row.login_customer_id as string | null) ?? null;
  const currency = (row.currency as string | null) ?? null;
  const window = gadsWindow(isoDateAt(now, businessTimeZone()));
  const tables = [];
  for (const table of GADS_TABLES) {
    const rows = await search(token, customer, gadsQuery(table, window.from, window.to), login);
    tables.push({ name: table.table, columns: gadsTableColumns(table), rows: gadsRows(table, rows, currency) });
  }
  return tables;
}

export const googleAds = googleSource<GadsChoice>({
  product: "google_ads",
  table: "analytics_google_ads_connections",
  name: NAME,
  columns: ["customer_id", "customer_name", "login_customer_id", "currency"],
  scope: GADS_SCOPE,
  scopeRefused: "The sign-in didn't allow Google Ads. Connect again and tick the box for your Google Ads data.",
  prefix: GADS_TABLE_PREFIX,
  loadTableName: GADS_LOAD_TABLE_NAME,
  tables: GADS_TABLES.map((table) => table.table),
  toConnection: (row) => ({
    customerId: (row.customer_id as string | null) ?? null,
    customerName: (row.customer_name as string | null) ?? null,
    loginCustomerId: (row.login_customer_id as string | null) ?? null,
    currency: (row.currency as string | null) ?? null,
  }),
  chosen: (row) => Boolean(row.customer_id),
  chooseFirst: "Choose the Google Ads account to load first.",
  fileName: (row) => String(row.customer_name ?? row.customer_id ?? ""),
  load,
  auditKey: "google_ads",
});

type CustomerAnswer = { customer?: { id?: string; descriptiveName?: string; currencyCode?: string; manager?: boolean } };
type ClientAnswer = { customerClient?: { id?: string; descriptiveName?: string; currencyCode?: string; manager?: boolean; level?: string | number } };

/** The ads accounts the Google account can see: its own, and those under each manager account (reached through it). Manager accounts themselves have no ads, so aren't listed. */
export async function listGadsAccounts(organisation: OrganisationRecord, actor: Actor): Promise<GadsAccount[]> {
  const { token: fresh } = await googleAds.connection(organisation, actor);
  const token = await fresh();
  const answer = await googleRequest<{ resourceNames?: string[] }>(NAME, `${API}/customers:listAccessibleCustomers`, token, problem);
  const accounts = new Map<string, GadsAccount>();
  for (const resource of answer.resourceNames ?? []) {
    const id = customerId(resource);
    if (!id) continue;
    const [info] = (await search(token, id, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer", id)) as CustomerAnswer[];
    if (info?.customer?.manager) {
      const clients = (await search(
        token,
        id,
        "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.level FROM customer_client WHERE customer_client.level = 1",
        id,
      )) as ClientAnswer[];
      for (const client of clients) {
        const clientId = customerId(client.customerClient?.id);
        if (!clientId || client.customerClient?.manager || accounts.has(clientId)) continue;
        accounts.set(clientId, { customerId: clientId, name: (client.customerClient?.descriptiveName || `Ads account ${clientId}`).slice(0, 300), currency: client.customerClient?.currencyCode ?? null, loginCustomerId: id });
      }
    } else if (!accounts.has(id) || accounts.get(id)!.loginCustomerId) {
      accounts.set(id, { customerId: id, name: (info?.customer?.descriptiveName || `Ads account ${id}`).slice(0, 300), currency: info?.customer?.currencyCode ?? null, loginCustomerId: null });
    }
  }
  return [...accounts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Chooses the ads account and nightly loading (GADS2). A new account drops the tables to start again (the caller drops them after this commits). */
export async function saveGadsSettings(tx: OrgTx, input: { customerId?: unknown; reloadDaily?: unknown }, available: GadsAccount[] | null) {
  await requireAnalytics(tx);
  const row = await googleAds.read(tx, true);
  if (!row) throw new NotFoundError(`${NAME} isn't connected.`);
  let chosen: GadsAccount | null = null;
  if (input.customerId !== undefined && input.customerId !== row.customer_id) {
    chosen = available?.find((entry) => entry.customerId === input.customerId) ?? null;
    if (!chosen) throw new ValidationError("That isn't a Google Ads account this Google account can see. Open the list again.");
  }
  if (!chosen && !row.customer_id) throw new ValidationError("Choose the Google Ads account to load.");
  if (input.reloadDaily !== undefined && typeof input.reloadDaily !== "boolean") throw new ValidationError("reloadDaily must be true or false.");
  const reloadDaily = input.reloadDaily === undefined ? row.reload_daily : (input.reloadDaily as boolean);
  if (chosen) {
    await tx.query(
      "update analytics_google_ads_connections set customer_id = $1, customer_name = $2, login_customer_id = $3, currency = $4, reload_daily = $5, updated_at = now() where id = true",
      [chosen.customerId, chosen.name, chosen.loginCustomerId, chosen.currency && /^[A-Z]{3}$/.test(chosen.currency) ? chosen.currency : null, reloadDaily],
    );
  } else {
    await tx.query("update analytics_google_ads_connections set reload_daily = $1, updated_at = now() where id = true", [reloadDaily]);
  }
  await writeAuditEvent(tx, { eventType: "analytics.google_ads_settings_saved", entityType: "analytics_google_ads_connection", entityId: "google_ads", details: { customerId: chosen?.customerId ?? row.customer_id, reloadDaily } });
  return { connection: googleAds.connectionOf((await googleAds.read(tx))!, true), startAgain: Boolean(chosen) && Boolean(row.customer_id) };
}
