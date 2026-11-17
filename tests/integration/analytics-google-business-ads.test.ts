import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as gaCallback from "@/app/api/analytics/google/callback/route";
import * as gbpRoute from "@/app/api/analytics/google/business-profile/route";
import * as gbpListRoute from "@/app/api/analytics/google/business-profile/locations/route";
import * as gbpLoadRoute from "@/app/api/analytics/google/business-profile/load/route";
import * as adsRoute from "@/app/api/analytics/google/google-ads/route";
import * as adsListRoute from "@/app/api/analytics/google/google-ads/accounts/route";
import * as adsLoadRoute from "@/app/api/analytics/google/google-ads/load/route";
import { closeAnalytics, listTables, queryAnalytics } from "@/lib/analytics/engine";
import { setGoogleSourceRetryDelaysForTests } from "@/lib/analytics/google-source";
import type { SessionUser } from "@/lib/auth/sessions";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { saveMailSettings } from "@/lib/crm/mail/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "gbp-ads-shop";
const noContext = undefined as unknown;
const BASIC = "openid https://www.googleapis.com/auth/userinfo.email";
type Json = Record<string, unknown>;

/** Examples GBP1-GBP7 and GADS1-GADS7 in docs/ACCOUNTING-EXAMPLES.md (following common practice, not yet reviewed). Google is a fake; the figures are made up. */
describeWithDatabase("analytics: Google Business Profile and Google Ads", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  let root: string;
  let scope = "";
  let calls: Array<{ url: string; body: Json | null; headers: Record<string, string> }> = [];
  let refuse: string | null = null;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fake = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? (JSON.parse(init.body) as Json) : null;
    calls.push({ url: input, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") return reply({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope });
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/revoke") return new Response("", { status: 200 });
    if (url.pathname === "/oauth2/v2/userinfo") return reply({ email: "jade@shop.example", verified_email: true });
    if (refuse && url.host.includes(refuse)) return reply({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403);
    // Business Profile
    if (url.host === "mybusinessaccountmanagement.googleapis.com") return reply({ accounts: [{ name: "accounts/111" }] });
    if (url.host === "mybusinessbusinessinformation.googleapis.com") {
      return reply({ locations: [{ name: "locations/222", title: "Glenmore by Jade", storefrontAddress: { addressLines: ["1 George Street"], locality: "Dunedin" } }] });
    }
    if (url.host === "businessprofileperformance.googleapis.com" && url.pathname.endsWith(":fetchMultiDailyMetricsTimeSeries")) {
      // A figure on the last day of each span asked for, whatever today is.
      const end = { year: Number(url.searchParams.get("dailyRange.endDate.year")), month: Number(url.searchParams.get("dailyRange.endDate.month")), day: Number(url.searchParams.get("dailyRange.endDate.day")) };
      const point = (value: string) => ({ timeSeries: { datedValues: [{ date: end, value }] } });
      return reply({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", ...point("40") }, { dailyMetric: "WEBSITE_CLICKS", ...point("6") }] }] });
    }
    if (url.host === "businessprofileperformance.googleapis.com" && url.pathname.endsWith("/searchkeywords/impressions/monthly")) {
      return reply({ searchKeywordsCounts: [{ searchKeyword: "pendant necklace", insightsValue: { value: "55" } }] });
    }
    if (url.host === "mybusiness.googleapis.com" && url.pathname === "/v4/accounts/111/locations/222/reviews") {
      return reply({ reviews: [{ reviewId: "r1", reviewer: { displayName: "Aroha N." }, starRating: "FIVE", comment: "Lovely", createTime: "2026-11-13T22:30:00Z" }], averageRating: 5, totalReviewCount: 1 });
    }
    // Google Ads
    if (url.host === "googleads.googleapis.com" && url.pathname.endsWith("customers:listAccessibleCustomers")) return reply({ resourceNames: ["customers/9990001111", "customers/1234567890"] });
    if (url.host === "googleads.googleapis.com" && url.pathname.endsWith("/googleAds:search")) {
      const query = String(body?.query ?? "");
      const customer = url.pathname.split("/")[3];
      if (query.includes("FROM customer_client")) return reply({ results: [{ customerClient: { id: "5550001111", descriptiveName: "Glenmore ads", currencyCode: "NZD", manager: false, level: "1" } }] });
      if (query.includes("FROM customer")) {
        return reply({ results: [customer === "9990001111" ? { customer: { id: "9990001111", descriptiveName: "Agency manager", manager: true } } : { customer: { id: "1234567890", descriptiveName: "Old test account", currencyCode: "AUD", manager: false } }] });
      }
      if (query.includes("FROM campaign")) {
        return reply({ results: [{ segments: { date: "2026-11-14" }, campaign: { id: "777", name: "Pendants NZ", status: "ENABLED" }, metrics: { costMicros: "12340000", clicks: "9", impressions: "300", conversions: 1, conversionsValue: 89 } }] });
      }
      return reply({ results: [] });
    }
    return new Response("not found", { status: 404 });
  };

  async function connect(route: typeof gbpRoute | typeof adsRoute, path: string, key: string) {
    const started = await route.POST(apiRequest(path, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), noContext);
    const { url } = (await started.json()) as { url: string };
    const state = new URL(url).searchParams.get("state")!;
    const back = await gaCallback.GET(apiRequest(`/api/analytics/google/callback?state=${encodeURIComponent(state)}&code=c`, { cookie: ownerCookie }));
    expect(back.headers.get("location")).toBe(`http://tohyee.test/analytics/sources?${key}=connected`);
    return new URL(url).searchParams.get("scope");
  }

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "business-ads-test-secret-key-0123456789abcdefgh";
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-gbp-"));
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("gbp-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("gbp-viewer@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);
    await as(owner, (tx) => updateOrganisationSettings(tx, { analyticsEnabled: true }));
    await as(owner, (tx) => saveMailSettings(tx, { googleClientId: "g-client.apps.googleusercontent.com", googleClientSecret: "g-secret" }));
    setMailFetchForTests(fake);
    setGoogleSourceRetryDelaysForTests([0, 0, 0]);
  });

  afterAll(async () => {
    setMailFetchForTests(null);
    setGoogleSourceRetryDelaysForTests(null);
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  it("GBP1-GBP5: connects, lists the profiles, loads days, reviews and search terms", async () => {
    expect((await gbpRoute.POST(apiRequest("/api/analytics/google/business-profile", { method: "POST", cookie: viewerCookie, body: { organisationId: ORG } }), noContext)).status).toBe(403);
    scope = `${BASIC} https://www.googleapis.com/auth/business.manage`;
    expect(await connect(gbpRoute, "/api/analytics/google/business-profile", "googleBusinessProfile")).toBe(scope);
    const listed = await gbpListRoute.GET(apiRequest(`/api/analytics/google/business-profile/locations?organisationId=${ORG}`, { cookie: ownerCookie }), noContext);
    expect(((await listed.json()) as { locations: unknown }).locations).toEqual([{ accountName: "accounts/111", locationName: "locations/222", title: "Glenmore by Jade", address: "1 George Street, Dunedin" }]);
    expect((await gbpRoute.PATCH(apiRequest("/api/analytics/google/business-profile", { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, locationName: "locations/999" } }), noContext)).status).toBe(400);
    await gbpRoute.PATCH(apiRequest("/api/analytics/google/business-profile", { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, locationName: "locations/222" } }), noContext);
    const { run } = (await (await gbpLoadRoute.POST(apiRequest("/api/analytics/google/business-profile/load", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), noContext)).json()) as { run: Json };
    expect(run).toMatchObject({ status: "ok", sourceName: "Google Business Profile", fileName: "Glenmore by Jade" });
    // Three spans of 180 days, each with one day of figures.
    expect(await queryAnalytics(ORG, "select count(*)::int as days, sum(views)::int as views, sum(website_clicks)::int as clicks from google_business_profile_days")).toEqual([{ days: 3, views: 120, clicks: 18 }]);
    expect(await queryAnalytics(ORG, "select stars, reviewer, replied from google_business_profile_reviews")).toEqual([{ stars: 5, reviewer: "Aroha N.", replied: false }]);
    // One row for each of the last 12 months.
    expect(await queryAnalytics(ORG, "select count(*)::int as months, min(search_term) as term, sum(impressions)::int as impressions from google_business_profile_search_terms")).toEqual([{ months: 12, term: "pendant necklace", impressions: 660 }]);
  });

  it("GBP6: until Google approves the project, the load is refused and says why; what was loaded stays", async () => {
    refuse = "businessprofileperformance";
    const { run } = (await (await gbpLoadRoute.POST(apiRequest("/api/analytics/google/business-profile/load", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), noContext)).json()) as { run: Json };
    expect(run.status).toBe("failed");
    expect(String(run.error)).toContain("hasn't been approved for the Business Profile APIs");
    expect(await queryAnalytics(ORG, "select count(*)::int as n from google_business_profile_reviews")).toEqual([{ n: 1 }]);
    refuse = null;
  });

  it("GADS1-GADS5: connects, lists ads accounts (through a manager too), loads spend by campaign with the manager's header", async () => {
    scope = `${BASIC} https://www.googleapis.com/auth/adwords`;
    await connect(adsRoute, "/api/analytics/google/google-ads", "googleAds");
    const listed = await adsListRoute.GET(apiRequest(`/api/analytics/google/google-ads/accounts?organisationId=${ORG}`, { cookie: ownerCookie }), noContext);
    expect(((await listed.json()) as { accounts: unknown }).accounts).toEqual([
      { customerId: "5550001111", name: "Glenmore ads", currency: "NZD", loginCustomerId: "9990001111" },
      { customerId: "1234567890", name: "Old test account", currency: "AUD", loginCustomerId: null },
    ]);
    await adsRoute.PATCH(apiRequest("/api/analytics/google/google-ads", { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, customerId: "5550001111" } }), noContext);
    calls = [];
    const { run } = (await (await adsLoadRoute.POST(apiRequest("/api/analytics/google/google-ads/load", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), noContext)).json()) as { run: Json };
    expect(run).toMatchObject({ status: "ok", sourceName: "Google Ads", fileName: "Glenmore ads" });
    const searches = calls.filter((call) => call.url.endsWith("/customers/5550001111/googleAds:search"));
    expect(searches).toHaveLength(3);
    expect(searches.every((call) => call.headers["login-customer-id"] === "9990001111" && call.url.includes("/v26/"))).toBe(true);
    expect(await queryAnalytics(ORG, "select campaign, cost::varchar as cost, clicks::int as clicks, conversion_value::varchar as value, currency from google_ads_campaign_days")).toEqual([
      { campaign: "Pendants NZ", cost: "12.34", clicks: 9, value: "89.00", currency: "NZD" },
    ]);
  });

  it("GADS7/GBP7: disconnecting deletes the sign-in and tables; the shared Google account's sign-in isn't withdrawn while another source uses it", async () => {
    calls = [];
    expect((await adsRoute.DELETE(apiRequest(`/api/analytics/google/google-ads?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }), noContext)).status).toBe(200);
    expect(calls.some((call) => call.url.includes("/revoke"))).toBe(false);
    expect([...(await listTables(ORG)).keys()].filter((name) => name.startsWith("google_ads_"))).toEqual([]);
    await gbpRoute.DELETE(apiRequest(`/api/analytics/google/business-profile?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }), noContext);
    expect(calls.some((call) => call.url.includes("/revoke"))).toBe(true);
    expect([...(await listTables(ORG)).keys()].filter((name) => name.startsWith("google_business_profile_"))).toEqual([]);
  });
});
