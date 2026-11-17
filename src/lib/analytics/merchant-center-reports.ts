import { dec, divide, toFixedString } from "@/lib/money/decimal";

/*
 * Google Merchant Center's tables in Analytics (examples GMC1-GMC8): what's loaded, and turning Google's answers into
 * rows. No database or network here, so the rules can be tested alone.
 */

export const GMC_TABLE_PREFIX = "google_merchant_center_";
/** The load history's name for Merchant Center loads (no source row). */
export const GMC_LOAD_TABLE_NAME = "google_merchant_center_*";
export const GMC_SOURCE_NAME = "Google Merchant Center";
/** How far back the clicks and impressions go: about 13 months, so this month can be compared with the same month last year. */
export const GMC_HISTORY_DAYS = 400;
/** Products asked for at once (Google's most). */
export const GMC_PAGE_SIZE = 1000;
/** The most pages read from one list, so a runaway answer can't go on for ever (1,000 a page). */
export const GMC_MAX_PAGES = 200;

export type GmcColumnType = "DATE" | "VARCHAR" | "BIGINT" | "DECIMAL(18,2)" | "INTEGER";
export type GmcTable = { table: string; label: string; noun: string; description: string; columns: Array<{ name: string; type: GmcColumnType }> };

export const GMC_TABLES: GmcTable[] = [
  {
    table: "google_merchant_center_products",
    label: "Merchant Center products",
    noun: "products",
    description:
      "The products in the Google Merchant Center account as Google has them now (replaced at each load): title, brand, link, price and sale price in their currency, stock as Google has it, and whether Google shows each one in Shopping ads and in free listings: approved, pending or disapproved, with the countries. issues is how many problems Google lists; top_issue is the first one. shopify_product_id and shopify_variant_id are filled when the product came from Shopify (an offer id like shopify_NZ_123_456), to join with the Shopify tables.",
    columns: [
      { name: "offer_id", type: "VARCHAR" },
      { name: "title", type: "VARCHAR" },
      { name: "brand", type: "VARCHAR" },
      { name: "link", type: "VARCHAR" },
      { name: "gtin", type: "VARCHAR" },
      { name: "price", type: "DECIMAL(18,2)" },
      { name: "sale_price", type: "DECIMAL(18,2)" },
      { name: "currency", type: "VARCHAR" },
      { name: "availability", type: "VARCHAR" },
      { name: "shopping_ads_status", type: "VARCHAR" },
      { name: "free_listings_status", type: "VARCHAR" },
      { name: "approved_countries", type: "VARCHAR" },
      { name: "disapproved_countries", type: "VARCHAR" },
      { name: "issues", type: "INTEGER" },
      { name: "top_issue", type: "VARCHAR" },
      { name: "feed_label", type: "VARCHAR" },
      { name: "content_language", type: "VARCHAR" },
      { name: "shopify_product_id", type: "VARCHAR" },
      { name: "shopify_variant_id", type: "VARCHAR" },
    ],
  },
  {
    table: "google_merchant_center_issues",
    label: "Merchant Center product issues",
    noun: "issues",
    description:
      "Each problem Google lists for a product (replaced at each load): how serious it is (disapproved means it isn't shown; demoted means it's shown less; not impacted is advice), what it's about, Google's words for it, where it applies and in which countries.",
    columns: [
      { name: "offer_id", type: "VARCHAR" },
      { name: "title", type: "VARCHAR" },
      { name: "severity", type: "VARCHAR" },
      { name: "where_shown", type: "VARCHAR" },
      { name: "issue", type: "VARCHAR" },
      { name: "detail", type: "VARCHAR" },
      { name: "attribute", type: "VARCHAR" },
      { name: "countries", type: "VARCHAR" },
      { name: "code", type: "VARCHAR" },
    ],
  },
  {
    table: "google_merchant_center_product_days",
    label: "Merchant Center clicks by product",
    noun: "product days",
    description:
      "Clicks and impressions for each product each day, across Shopping ads and free listings, in the Merchant Center account's time zone, for about the last 13 months (reloaded each time; the newest days may still change). Impressions: times the product was shown on Google; clicks: times someone clicked it. Days with no clicks or impressions aren't listed.",
    columns: [
      { name: "date", type: "DATE" },
      { name: "offer_id", type: "VARCHAR" },
      { name: "title", type: "VARCHAR" },
      { name: "clicks", type: "BIGINT" },
      { name: "impressions", type: "BIGINT" },
    ],
  },
];

/** Whether a table is one of Merchant Center's own. */
export function isGmcTable(name: string): boolean {
  return name.startsWith(GMC_TABLE_PREFIX);
}

export function gmcTableColumns(table: GmcTable): Array<{ name: string; type: string }> {
  return table.columns.map((column) => ({ name: column.name, type: column.type }));
}

// Google's answers ---------------------------------------------------------------------------

export type GmcPrice = { amountMicros?: string; currencyCode?: string };
export type GmcProduct = {
  offerId?: string;
  contentLanguage?: string;
  feedLabel?: string;
  productAttributes?: {
    title?: string;
    brand?: string;
    link?: string;
    gtins?: string[];
    price?: GmcPrice;
    salePrice?: GmcPrice;
    availability?: string;
  };
  productStatus?: {
    destinationStatuses?: Array<{ reportingContext?: string; approvedCountries?: string[]; pendingCountries?: string[]; disapprovedCountries?: string[] }>;
    itemLevelIssues?: Array<{
      code?: string;
      severity?: string;
      reportingContext?: string;
      description?: string;
      detail?: string;
      attribute?: string;
      applicableCountries?: string[];
    }>;
  };
};
export type GmcPerformanceRow = {
  productPerformanceView?: { date?: { year?: number; month?: number; day?: number }; offerId?: string; title?: string; clicks?: string; impressions?: string };
};

/** Google's money is in millionths ("15990000" is 15.99): exact decimals, never floats. */
export function gmcMoney(price: GmcPrice | undefined): string | null {
  if (!price || typeof price.amountMicros !== "string" || !/^-?\d{1,20}$/.test(price.amountMicros)) return null;
  return toFixedString(divide(dec(price.amountMicros), dec("1000000"), 2), 2);
}

/** A whole number Google sent as text; anything else is 0. */
export function gmcCount(value: unknown): string {
  return typeof value === "string" && /^\d{1,18}$/.test(value) ? value : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "0";
}

const AVAILABILITY: Record<string, string> = {
  IN_STOCK: "In stock",
  OUT_OF_STOCK: "Out of stock",
  PREORDER: "Pre-order",
  BACKORDER: "Backorder",
  LIMITED_AVAILABILITY: "Limited",
};

const PLACES: Record<string, string> = {
  SHOPPING_ADS: "Shopping ads",
  FREE_LISTINGS: "Free listings",
  DISPLAY_ADS: "Display ads",
  LOCAL_INVENTORY_ADS: "Local inventory ads",
  FREE_LOCAL_LISTINGS: "Free local listings",
  YOUTUBE_SHOPPING: "YouTube shopping",
  YOUTUBE_AFFILIATE: "YouTube affiliate",
};

const SEVERITIES: Record<string, string> = { DISAPPROVED: "Disapproved", DEMOTED: "Demoted", NOT_IMPACTED: "Not impacted" };

function words(value: unknown, known: Record<string, string>): string | null {
  if (typeof value !== "string" || !value) return null;
  return known[value] ?? value.toLowerCase().replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase());
}

function text(value: unknown, max = 2000): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** Approved, Pending, Disapproved or Partly approved (some countries each way) where it's shown; null when it isn't meant to be shown there. */
export function gmcStatus(statuses: NonNullable<GmcProduct["productStatus"]>["destinationStatuses"], context: string): string | null {
  const entry = statuses?.find((status) => status.reportingContext === context);
  if (!entry) return null;
  const approved = entry.approvedCountries?.length ?? 0;
  const pending = entry.pendingCountries?.length ?? 0;
  const disapproved = entry.disapprovedCountries?.length ?? 0;
  if (disapproved && (approved || pending)) return "Partly approved";
  if (disapproved) return "Disapproved";
  if (pending) return "Pending";
  if (approved) return "Approved";
  return null;
}

/** Shopify's own Google channel names products shopify_<country>_<product>_<variant>. */
export function shopifyIds(offerId: string): { product: string | null; variant: string | null } {
  const match = /^shopify_[A-Z]{2}_(\d{1,20})_(\d{1,20})$/i.exec(offerId);
  return match ? { product: match[1], variant: match[2] } : { product: null, variant: null };
}

function countries(list: Array<string[] | undefined>): string | null {
  const all = [...new Set(list.flatMap((entry) => entry ?? []).filter((code) => typeof code === "string" && /^[A-Z]{2}$/.test(code)))].sort();
  return all.length ? all.join(", ") : null;
}

export function gmcProductRows(products: GmcProduct[]): Array<Array<string | null>> {
  const rows: Array<Array<string | null>> = [];
  for (const product of products) {
    const offerId = text(product.offerId, 200);
    if (!offerId) continue;
    const attributes = product.productAttributes ?? {};
    const statuses = product.productStatus?.destinationStatuses ?? [];
    const issues = product.productStatus?.itemLevelIssues ?? [];
    const price = gmcMoney(attributes.price);
    const sale = gmcMoney(attributes.salePrice);
    const ids = shopifyIds(offerId);
    rows.push([
      offerId,
      text(attributes.title, 500),
      text(attributes.brand, 200),
      text(attributes.link, 2000),
      Array.isArray(attributes.gtins) ? (text(attributes.gtins[0], 50) ?? null) : null,
      price,
      sale,
      text(attributes.price?.currencyCode ?? attributes.salePrice?.currencyCode, 3),
      words(attributes.availability, AVAILABILITY),
      gmcStatus(statuses, "SHOPPING_ADS"),
      gmcStatus(statuses, "FREE_LISTINGS"),
      countries(statuses.map((status) => status.approvedCountries)),
      countries(statuses.map((status) => status.disapprovedCountries)),
      String(issues.length),
      text(issues.find((issue) => issue.severity === "DISAPPROVED")?.description ?? issues[0]?.description, 500),
      text(product.feedLabel, 50),
      text(product.contentLanguage, 10),
      ids.product,
      ids.variant,
    ]);
  }
  return rows;
}

export function gmcIssueRows(products: GmcProduct[]): Array<Array<string | null>> {
  const rows: Array<Array<string | null>> = [];
  for (const product of products) {
    const offerId = text(product.offerId, 200);
    if (!offerId) continue;
    for (const issue of product.productStatus?.itemLevelIssues ?? []) {
      rows.push([
        offerId,
        text(product.productAttributes?.title, 500),
        words(issue.severity, SEVERITIES),
        words(issue.reportingContext, PLACES),
        text(issue.description, 500),
        text(issue.detail, 2000),
        text(issue.attribute, 100),
        countries([issue.applicableCountries]),
        text(issue.code, 100),
      ]);
    }
  }
  return rows;
}

function isoDay(date: { year?: number; month?: number; day?: number } | undefined): string | null {
  if (!date || !Number.isInteger(date.year) || !Number.isInteger(date.month) || !Number.isInteger(date.day)) return null;
  const day = `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
  return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(day) ? day : null;
}

export function gmcDayRows(rows: GmcPerformanceRow[]): Array<Array<string | null>> {
  const out: Array<Array<string | null>> = [];
  for (const row of rows) {
    const view = row.productPerformanceView;
    const day = isoDay(view?.date);
    const offerId = text(view?.offerId, 200);
    if (!day || !offerId) continue;
    out.push([day, offerId, text(view?.title, 500), gmcCount(view?.clicks), gmcCount(view?.impressions)]);
  }
  return out;
}

/** The report question for clicks and impressions by product and day (Merchant Center's query language). */
export function gmcPerformanceQuery(from: string, to: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error("Dates must be YYYY-MM-DD.");
  return `SELECT date, offer_id, title, clicks, impressions FROM product_performance_view WHERE date BETWEEN '${from}' AND '${to}'`;
}

/** The days to load: about 13 months up to today. */
export function gmcWindow(today: string): { from: string; to: string } {
  const [year, month, day] = today.split("-").map(Number);
  const from = new Date(Date.UTC(year, month - 1, day - GMC_HISTORY_DAYS)).toISOString().slice(0, 10);
  return { from, to: today };
}
