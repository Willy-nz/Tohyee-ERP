import { dec, divide, toFixedString } from "@/lib/money/decimal";

/*
 * Google Ads' tables in Analytics (examples GADS1-GADS7): spend, clicks, impressions and conversions by campaign, ad
 * group and keyword each day. No database or network here.
 */

export const GADS_TABLE_PREFIX = "google_ads_";
export const GADS_LOAD_TABLE_NAME = "google_ads_*";
export const GADS_SOURCE_NAME = "Google Ads";
/**
 * The Google Ads API version Tohyee speaks. Google retires each version
 * about a year after it comes out (v26: October 2026, retired about
 * November 2027), so this needs moving on each year.
 */
export const GADS_API_VERSION = "v26";
export const GADS_HISTORY_DAYS = 400;
export const GADS_MAX_PAGES = 200;

export type GadsColumnType = "DATE" | "VARCHAR" | "BIGINT" | "DECIMAL(18,2)";
export type GadsTable = { table: string; label: string; noun: string; description: string; resource: string; fields: string[]; columns: Array<{ name: string; type: GadsColumnType }> };

const METRIC_FIELDS = ["metrics.cost_micros", "metrics.clicks", "metrics.impressions", "metrics.conversions", "metrics.conversions_value"];
const METRIC_COLUMNS: GadsTable["columns"] = [
  { name: "cost", type: "DECIMAL(18,2)" },
  { name: "clicks", type: "BIGINT" },
  { name: "impressions", type: "BIGINT" },
  { name: "conversions", type: "DECIMAL(18,2)" },
  { name: "conversion_value", type: "DECIMAL(18,2)" },
  { name: "currency", type: "VARCHAR" },
];
const COMMON =
  "cost is what Google charged in the account's currency (compare it with Advertising in the books); impressions are times an ad was shown, clicks times someone clicked; conversions and conversion_value are what Google Ads counted as results (sales or leads, as the account's conversion tracking defines them; they can be fractions). Days in the account's time zone, about the last 13 months; a day with nothing isn't listed.";

export const GADS_TABLES: GadsTable[] = [
  {
    table: "google_ads_campaign_days",
    label: "Google Ads by campaign",
    noun: "campaign days",
    description: `Each campaign's results each day, with its status. ${COMMON}`,
    resource: "campaign",
    fields: ["segments.date", "campaign.id", "campaign.name", "campaign.status", ...METRIC_FIELDS],
    columns: [{ name: "date", type: "DATE" }, { name: "campaign_id", type: "VARCHAR" }, { name: "campaign", type: "VARCHAR" }, { name: "campaign_status", type: "VARCHAR" }, ...METRIC_COLUMNS],
  },
  {
    table: "google_ads_ad_group_days",
    label: "Google Ads by ad group",
    noun: "ad group days",
    description: `Each ad group's results each day, with its campaign. ${COMMON}`,
    resource: "ad_group",
    fields: ["segments.date", "campaign.name", "ad_group.id", "ad_group.name", ...METRIC_FIELDS],
    columns: [{ name: "date", type: "DATE" }, { name: "campaign", type: "VARCHAR" }, { name: "ad_group_id", type: "VARCHAR" }, { name: "ad_group", type: "VARCHAR" }, ...METRIC_COLUMNS],
  },
  {
    table: "google_ads_keyword_days",
    label: "Google Ads by keyword",
    noun: "keyword days",
    description: `Each search keyword's results each day, with how it matches searches (exact, phrase or broad), its ad group and campaign. ${COMMON}`,
    resource: "keyword_view",
    fields: ["segments.date", "campaign.name", "ad_group.name", "ad_group_criterion.keyword.text", "ad_group_criterion.keyword.match_type", ...METRIC_FIELDS],
    columns: [
      { name: "date", type: "DATE" },
      { name: "campaign", type: "VARCHAR" },
      { name: "ad_group", type: "VARCHAR" },
      { name: "keyword", type: "VARCHAR" },
      { name: "match_type", type: "VARCHAR" },
      ...METRIC_COLUMNS,
    ],
  },
];

export function isGadsTable(name: string): boolean {
  return name.startsWith(GADS_TABLE_PREFIX);
}

export function gadsTableColumns(table: GadsTable): Array<{ name: string; type: string }> {
  return table.columns.map((column) => ({ name: column.name, type: column.type }));
}

/** The question for one table, Google Ads Query Language; only days with something are returned. */
export function gadsQuery(table: GadsTable, from: string, to: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error("Dates must be YYYY-MM-DD.");
  return `SELECT ${table.fields.join(", ")} FROM ${table.resource} WHERE segments.date BETWEEN '${from}' AND '${to}' AND metrics.impressions > 0`;
}

export function gadsWindow(today: string): { from: string; to: string } {
  const [year, month, day] = today.split("-").map(Number);
  return { from: new Date(Date.UTC(year, month - 1, day - GADS_HISTORY_DAYS)).toISOString().slice(0, 10), to: today };
}

/** Google Ads' ten-digit customer id from "customers/1234567890" or "123-456-7890". */
export function customerId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/^customers\//, "").replace(/-/g, "");
  return /^\d{10}$/.test(digits) ? digits : null;
}

// Google's answers ---------------------------------------------------------------------------

export type GadsRow = {
  segments?: { date?: string };
  campaign?: { id?: string; name?: string; status?: string };
  adGroup?: { id?: string; name?: string };
  adGroupCriterion?: { keyword?: { text?: string; matchType?: string } };
  metrics?: { costMicros?: string; clicks?: string; impressions?: string; conversions?: number | string; conversionsValue?: number | string };
};

function text(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function count(value: unknown): string {
  return typeof value === "string" && /^\d{1,18}$/.test(value) ? value : "0";
}

/** Google's millionths ("1230000" is 1.23), exactly. */
export function micros(value: unknown): string {
  return typeof value === "string" && /^-?\d{1,20}$/.test(value) ? toFixedString(divide(dec(value), dec("1000000"), 2), 2) : "0.00";
}

/** Conversions come as plain numbers (they can be fractions): read as written, rounded once to 2 places. */
export function amount(value: unknown): string {
  const written = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value : "";
  return /^-?\d{1,15}(\.\d{1,12})?$/.test(written) ? toFixedString(divide(dec(written), dec("1"), 2), 2) : "0.00";
}

const STATUS: Record<string, string> = { ENABLED: "Enabled", PAUSED: "Paused", REMOVED: "Removed" };
const MATCH: Record<string, string> = { EXACT: "Exact", PHRASE: "Phrase", BROAD: "Broad" };

export function gadsRows(table: GadsTable, rows: GadsRow[], currency: string | null): Array<Array<string | null>> {
  const out: Array<Array<string | null>> = [];
  for (const row of rows) {
    const date = typeof row.segments?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.segments.date) ? row.segments.date : null;
    if (!date) continue;
    const metrics = [micros(row.metrics?.costMicros), count(row.metrics?.clicks), count(row.metrics?.impressions), amount(row.metrics?.conversions), amount(row.metrics?.conversionsValue), currency];
    if (table.resource === "campaign") {
      out.push([date, text(row.campaign?.id, 30), text(row.campaign?.name), STATUS[row.campaign?.status ?? ""] ?? text(row.campaign?.status, 30), ...metrics]);
    } else if (table.resource === "ad_group") {
      out.push([date, text(row.campaign?.name), text(row.adGroup?.id, 30), text(row.adGroup?.name), ...metrics]);
    } else {
      const keyword = row.adGroupCriterion?.keyword;
      out.push([date, text(row.campaign?.name), text(row.adGroup?.name), text(keyword?.text), MATCH[keyword?.matchType ?? ""] ?? text(keyword?.matchType, 30), ...metrics]);
    }
  }
  return out;
}
