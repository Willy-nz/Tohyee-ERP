import { writeAuditEvent } from "@/lib/audit";
import {
  GBP_LOAD_TABLE_NAME,
  GBP_MAX_PAGES,
  GBP_TABLE_PREFIX,
  GBP_TABLES,
  type GbpDaily,
  type GbpKeywords,
  type GbpReview,
  gbpDailyQuery,
  gbpDayRows,
  gbpMonths,
  gbpReviewRows,
  gbpSearchTermRows,
  gbpSpans,
  gbpTableColumns,
} from "@/lib/analytics/business-profile-reports";
import { allPages, googleProblem, googleRequest, googleSource, type SourceRow } from "@/lib/analytics/google-source";
import { requireAnalytics } from "@/lib/analytics/sources";
import { businessTimeZone, isoDateAt } from "@/lib/dates";
import type { Actor, OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { OrganisationRecord } from "@/lib/organisations/registry";

/*
 * Google Business Profile as an Analytics data source (examples GBP1-GBP7), built like Merchant Center. An admin signs in
 * with Google allowing Business Profile, chooses one of the business's
 * profiles (a location), and Tohyee loads its daily views and actions
 * (about 18 months), its reviews and the searches it showed for by month,
 * replacing the tables at each load. Tohyee only reads. Google lets only
 * approved Google Cloud projects use these APIs: until the organisation's
 * project is approved, Google refuses and the load says so.
 */

export const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";
const NAME = "Google Business Profile";
const ACCOUNTS = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";
const PERFORMANCE = "https://businessprofileperformance.googleapis.com/v1";
const REVIEWS = "https://mybusiness.googleapis.com/v4";

const problem = googleProblem(
  NAME,
  "Business Profile APIs",
  "Google refused. Either this Google Cloud project hasn't been approved for the Business Profile APIs yet (Google reviews each request, usually within 14 days), or this Google account can't manage that profile.",
);

const request = <T>(url: string, token: string) => googleRequest<T>(NAME, url, token, problem);
const pages = <T, R>(fetchPage: (pageToken: string | null) => Promise<T & { nextPageToken?: string }>, items: (page: T) => R[] | undefined) => allPages(NAME, GBP_MAX_PAGES, fetchPage, items);
const withToken = (url: string, pageToken: string | null) => (pageToken ? `${url}${url.includes("?") ? "&" : "?"}pageToken=${encodeURIComponent(pageToken)}` : url);

export type GbpChoice = { accountName: string | null; locationName: string | null; locationTitle: string | null };
export type GbpLocation = { accountName: string; locationName: string; title: string; address: string | null };

async function load(token: string, row: SourceRow, now: Date) {
  const account = String(row.account_name);
  const location = String(row.location_name);
  const today = isoDateAt(now, businessTimeZone());
  const daily: GbpDaily[] = [];
  for (const span of gbpSpans(today)) daily.push(await request<GbpDaily>(`${PERFORMANCE}/${location}:fetchMultiDailyMetricsTimeSeries?${gbpDailyQuery(span)}`, token));
  const reviews = await pages<{ reviews?: GbpReview[] }, GbpReview>(
    (pageToken) => request(withToken(`${REVIEWS}/${account}/${location}/reviews?pageSize=50`, pageToken), token),
    (page) => page.reviews,
  );
  const terms: Array<Array<string | null>> = [];
  for (const month of gbpMonths(today)) {
    const [year, number] = month.split("-").map(Number);
    const range = `monthlyRange.startMonth.year=${year}&monthlyRange.startMonth.month=${number}&monthlyRange.endMonth.year=${year}&monthlyRange.endMonth.month=${number}`;
    const answer = await pages<GbpKeywords, GbpKeywords>((pageToken) => request(withToken(`${PERFORMANCE}/${location}/searchkeywords/impressions/monthly?${range}&pageSize=100`, pageToken), token), (page) => [page]);
    terms.push(...gbpSearchTermRows(month, answer));
  }
  const byName: Record<string, Array<Array<string | null>>> = {
    google_business_profile_days: gbpDayRows(daily),
    google_business_profile_reviews: gbpReviewRows(reviews, businessTimeZone()),
    google_business_profile_search_terms: terms,
  };
  return GBP_TABLES.map((table) => ({ name: table.table, columns: gbpTableColumns(table), rows: byName[table.table] }));
}

export const businessProfile = googleSource<GbpChoice>({
  product: "business_profile",
  table: "analytics_business_profile_connections",
  name: NAME,
  columns: ["account_name", "location_name", "location_title"],
  scope: GBP_SCOPE,
  scopeRefused: "The sign-in didn't allow Business Profile. Connect again and tick the box for your Business Profile.",
  prefix: GBP_TABLE_PREFIX,
  loadTableName: GBP_LOAD_TABLE_NAME,
  tables: GBP_TABLES.map((table) => table.table),
  toConnection: (row) => ({ accountName: (row.account_name as string | null) ?? null, locationName: (row.location_name as string | null) ?? null, locationTitle: (row.location_title as string | null) ?? null }),
  chosen: (row) => Boolean(row.location_name),
  chooseFirst: "Choose the Business Profile to load first.",
  fileName: (row) => String(row.location_title ?? row.location_name ?? ""),
  load,
  auditKey: "business_profile",
});

/** The profiles (locations) the Google account manages, across its accounts, by name. */
export async function listGbpLocations(organisation: OrganisationRecord, actor: Actor): Promise<GbpLocation[]> {
  const { token: fresh } = await businessProfile.connection(organisation, actor);
  const token = await fresh();
  const accounts = await pages<{ accounts?: Array<{ name?: string }> }, { name?: string }>((pageToken) => request(withToken(`${ACCOUNTS}/accounts?pageSize=20`, pageToken), token), (page) => page.accounts);
  const locations: GbpLocation[] = [];
  for (const account of accounts) {
    if (typeof account.name !== "string" || !/^accounts\/\d{1,30}$/.test(account.name)) continue;
    const found = await pages<{ locations?: Array<{ name?: string; title?: string; storefrontAddress?: { addressLines?: string[]; locality?: string } }> }, { name?: string; title?: string; storefrontAddress?: { addressLines?: string[]; locality?: string } }>(
      (pageToken) => request(withToken(`${INFO}/${account.name}/locations?readMask=name,title,storefrontAddress&pageSize=100`, pageToken), token),
      (page) => page.locations,
    );
    for (const location of found) {
      if (typeof location.name !== "string" || !/^locations\/\d{1,30}$/.test(location.name)) continue;
      const address = [...(location.storefrontAddress?.addressLines ?? []), location.storefrontAddress?.locality].filter((part): part is string => typeof part === "string" && part.trim() !== "").join(", ");
      locations.push({ accountName: account.name, locationName: location.name, title: (typeof location.title === "string" && location.title.trim() ? location.title.trim() : location.name).slice(0, 300), address: address || null });
    }
  }
  return locations.sort((a, b) => a.title.localeCompare(b.title));
}

/** Chooses the profile and nightly loading (GBP2). A new profile drops the tables to start again (the caller drops them after this commits). */
export async function saveGbpSettings(tx: OrgTx, input: { locationName?: unknown; reloadDaily?: unknown }, available: GbpLocation[] | null) {
  await requireAnalytics(tx);
  const row = await businessProfile.read(tx, true);
  if (!row) throw new NotFoundError(`${NAME} isn't connected.`);
  let chosen: GbpLocation | null = null;
  if (input.locationName !== undefined && input.locationName !== row.location_name) {
    chosen = available?.find((entry) => entry.locationName === input.locationName) ?? null;
    if (!chosen) throw new ValidationError("That isn't a Business Profile this Google account manages. Open the list again.");
  }
  if (!chosen && !row.location_name) throw new ValidationError("Choose the Business Profile to load.");
  if (input.reloadDaily !== undefined && typeof input.reloadDaily !== "boolean") throw new ValidationError("reloadDaily must be true or false.");
  const reloadDaily = input.reloadDaily === undefined ? row.reload_daily : (input.reloadDaily as boolean);
  await tx.query(
    `update analytics_business_profile_connections set account_name = coalesce($1, account_name), location_name = coalesce($2, location_name),
            location_title = coalesce($3, location_title), reload_daily = $4, updated_at = now() where id = true`,
    [chosen?.accountName ?? null, chosen?.locationName ?? null, chosen?.title ?? null, reloadDaily],
  );
  await writeAuditEvent(tx, { eventType: "analytics.business_profile_settings_saved", entityType: "analytics_business_profile_connection", entityId: "business_profile", details: { location: chosen?.locationName ?? row.location_name, reloadDaily } });
  return { connection: businessProfile.connectionOf((await businessProfile.read(tx))!, true), startAgain: Boolean(chosen) && Boolean(row.location_name) };
}
