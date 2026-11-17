/*
 * Google Business Profile's tables in Analytics (examples GBP1-GBP7): the Search and Maps listing's views and actions by
 * day, its reviews, and the searches it showed for by month. No database or
 * network here, so the rules can be tested alone.
 */

export const GBP_TABLE_PREFIX = "google_business_profile_";
export const GBP_LOAD_TABLE_NAME = "google_business_profile_*";
export const GBP_SOURCE_NAME = "Google Business Profile";
/** Google keeps about 18 months of daily figures; Tohyee asks for 540 days, in parts. */
export const GBP_HISTORY_DAYS = 540;
/** Days asked for in one request. */
export const GBP_DAYS_A_REQUEST = 180;
/** Months of search terms (one request each). */
export const GBP_SEARCH_MONTHS = 12;
export const GBP_MAX_PAGES = 100;

export type GbpColumnType = "DATE" | "VARCHAR" | "BIGINT" | "INTEGER" | "BOOLEAN";
export type GbpTable = { table: string; label: string; noun: string; description: string; columns: Array<{ name: string; type: GbpColumnType }> };

/** Google's daily figures and the columns they become. */
export const GBP_METRICS: Array<{ metric: string; column: string }> = [
  { metric: "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", column: "views_search_mobile" },
  { metric: "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", column: "views_search_desktop" },
  { metric: "BUSINESS_IMPRESSIONS_MOBILE_MAPS", column: "views_maps_mobile" },
  { metric: "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", column: "views_maps_desktop" },
  { metric: "CALL_CLICKS", column: "calls" },
  { metric: "BUSINESS_DIRECTION_REQUESTS", column: "direction_requests" },
  { metric: "WEBSITE_CLICKS", column: "website_clicks" },
  { metric: "BUSINESS_CONVERSATIONS", column: "messages" },
  { metric: "BUSINESS_BOOKINGS", column: "bookings" },
];

export const GBP_TABLES: GbpTable[] = [
  {
    table: "google_business_profile_days",
    label: "Business Profile by day",
    noun: "days",
    description:
      "How the business's Google listing (Search and Maps) did each day, for about the last 18 months: views is how many people saw the profile (each person counted once a day per device and place), split into Search and Maps on phones and computers; then calls, direction requests, website clicks, messages and bookings made from it. Google's figures can take a few days to settle.",
    columns: [{ name: "date", type: "DATE" }, { name: "views", type: "BIGINT" }, ...GBP_METRICS.map((entry) => ({ name: entry.column, type: "BIGINT" as const }))],
  },
  {
    table: "google_business_profile_reviews",
    label: "Business Profile reviews",
    noun: "reviews",
    description:
      "Each Google review of the business: when it was written, its stars (1 to 5), who wrote it (their public Google name), what they said, and the business's reply if it has one. Replaced at each load, so a deleted review goes.",
    columns: [
      { name: "review_id", type: "VARCHAR" },
      { name: "date", type: "DATE" },
      { name: "stars", type: "INTEGER" },
      { name: "reviewer", type: "VARCHAR" },
      { name: "comment", type: "VARCHAR" },
      { name: "replied", type: "BOOLEAN" },
      { name: "reply", type: "VARCHAR" },
      { name: "reply_date", type: "DATE" },
    ],
  },
  {
    table: "google_business_profile_search_terms",
    label: "Business Profile search terms",
    noun: "search terms",
    description:
      "What people searched for on Google when the profile was shown, by month, for the last 12 months. impressions is Google's count; when Google only says it was fewer than a number (to protect privacy), impressions is blank and fewer_than holds that number.",
    columns: [
      { name: "month", type: "DATE" },
      { name: "search_term", type: "VARCHAR" },
      { name: "impressions", type: "BIGINT" },
      { name: "fewer_than", type: "BIGINT" },
    ],
  },
];

export function isGbpTable(name: string): boolean {
  return name.startsWith(GBP_TABLE_PREFIX);
}

export function gbpTableColumns(table: GbpTable): Array<{ name: string; type: string }> {
  return table.columns.map((column) => ({ name: column.name, type: column.type }));
}

// Days ---------------------------------------------------------------------------------------

function addDays(day: string, count: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + count)).toISOString().slice(0, 10);
}

/** The spans to ask for: the last 540 days up to yesterday, in parts of 180 days, oldest first. */
export function gbpSpans(today: string): Array<{ from: string; to: string }> {
  const last = addDays(today, -1);
  const first = addDays(today, -GBP_HISTORY_DAYS);
  const spans: Array<{ from: string; to: string }> = [];
  for (let from = first; from <= last; from = addDays(from, GBP_DAYS_A_REQUEST)) {
    const to = addDays(from, GBP_DAYS_A_REQUEST - 1);
    spans.push({ from, to: to < last ? to : last });
  }
  return spans;
}

/** The last 12 whole months before this one, oldest first, as their first days. */
export function gbpMonths(today: string): string[] {
  const [year, month] = today.split("-").map(Number);
  const months: string[] = [];
  for (let back = GBP_SEARCH_MONTHS; back >= 1; back -= 1) {
    const date = new Date(Date.UTC(year, month - 1 - back, 1));
    months.push(date.toISOString().slice(0, 10));
  }
  return months;
}

/** The query string for one span of daily figures. */
export function gbpDailyQuery(span: { from: string; to: string }): string {
  const params = new URLSearchParams();
  for (const entry of GBP_METRICS) params.append("dailyMetrics", entry.metric);
  const [fy, fm, fd] = span.from.split("-").map(Number);
  const [ty, tm, td] = span.to.split("-").map(Number);
  params.set("dailyRange.startDate.year", String(fy));
  params.set("dailyRange.startDate.month", String(fm));
  params.set("dailyRange.startDate.day", String(fd));
  params.set("dailyRange.endDate.year", String(ty));
  params.set("dailyRange.endDate.month", String(tm));
  params.set("dailyRange.endDate.day", String(td));
  return params.toString();
}

// Google's answers ---------------------------------------------------------------------------

export type GbpDaily = {
  multiDailyMetricTimeSeries?: Array<{
    dailyMetricTimeSeries?: Array<{ dailyMetric?: string; timeSeries?: { datedValues?: Array<{ date?: { year?: number; month?: number; day?: number }; value?: string }> } }>;
  }>;
};
export type GbpReview = {
  reviewId?: string;
  name?: string;
  reviewer?: { displayName?: string; isAnonymous?: boolean };
  starRating?: string;
  comment?: string;
  createTime?: string;
  reviewReply?: { comment?: string; updateTime?: string };
};
export type GbpKeywords = { searchKeywordsCounts?: Array<{ searchKeyword?: string; insightsValue?: { value?: string; threshold?: string } }> };

function isoDay(date: { year?: number; month?: number; day?: number } | undefined): string | null {
  if (!date || !Number.isInteger(date.year) || !Number.isInteger(date.month) || !Number.isInteger(date.day)) return null;
  const day = `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
  return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(day) ? day : null;
}

function count(value: unknown): bigint {
  return typeof value === "string" && /^\d{1,18}$/.test(value) ? BigInt(value) : BigInt(0);
}

/** Every span's figures into one row a day; a day Google sent nothing for isn't listed. Views is the four kinds added up. */
export function gbpDayRows(answers: GbpDaily[]): Array<Array<string | null>> {
  const byDay = new Map<string, Map<string, bigint>>();
  for (const answer of answers) {
    for (const multi of answer.multiDailyMetricTimeSeries ?? []) {
      for (const series of multi.dailyMetricTimeSeries ?? []) {
        const column = GBP_METRICS.find((entry) => entry.metric === series.dailyMetric)?.column;
        if (!column) continue;
        for (const point of series.timeSeries?.datedValues ?? []) {
          const day = isoDay(point.date);
          if (!day) continue;
          const values = byDay.get(day) ?? new Map<string, bigint>();
          values.set(column, (values.get(column) ?? BigInt(0)) + count(point.value));
          byDay.set(day, values);
        }
      }
    }
  }
  return [...byDay.keys()].sort().map((day) => {
    const values = byDay.get(day)!;
    const views = ["views_search_mobile", "views_search_desktop", "views_maps_mobile", "views_maps_desktop"].reduce((total, column) => total + (values.get(column) ?? BigInt(0)), BigInt(0));
    return [day, String(views), ...GBP_METRICS.map((entry) => String(values.get(entry.column) ?? BigInt(0)))];
  });
}

const STARS: Record<string, string> = { ONE: "1", TWO: "2", THREE: "3", FOUR: "4", FIVE: "5" };

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function dayOf(timestamp: unknown, timeZone: string): string | null {
  if (typeof timestamp !== "string") return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Google's reviews: stars as a number, the reviewer's public name ("A Google user" when anonymous), dates in the business's time zone. */
export function gbpReviewRows(reviews: GbpReview[], timeZone: string): Array<Array<string | null>> {
  const rows: Array<Array<string | null>> = [];
  for (const review of reviews) {
    const id = text(review.reviewId, 200) ?? text(review.name?.split("/").pop(), 200);
    if (!id) continue;
    const reply = text(review.reviewReply?.comment, 4000);
    rows.push([
      id,
      dayOf(review.createTime, timeZone),
      STARS[review.starRating ?? ""] ?? null,
      review.reviewer?.isAnonymous ? "A Google user" : text(review.reviewer?.displayName, 200),
      text(review.comment, 4000),
      reply ? "true" : "false",
      reply,
      reply ? dayOf(review.reviewReply?.updateTime, timeZone) : null,
    ]);
  }
  return rows;
}

export function gbpSearchTermRows(month: string, answer: GbpKeywords[]): Array<Array<string | null>> {
  const rows: Array<Array<string | null>> = [];
  for (const page of answer) {
    for (const entry of page.searchKeywordsCounts ?? []) {
      const term = text(entry.searchKeyword, 300);
      if (!term) continue;
      const value = entry.insightsValue?.value;
      const threshold = entry.insightsValue?.threshold;
      rows.push([month, term, typeof value === "string" && /^\d{1,18}$/.test(value) ? value : null, typeof threshold === "string" && /^\d{1,18}$/.test(threshold) ? threshold : null]);
    }
  }
  return rows;
}
