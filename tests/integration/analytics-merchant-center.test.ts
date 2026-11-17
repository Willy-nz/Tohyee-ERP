import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as gaCallback from "@/app/api/analytics/google/callback/route";
import * as gmcRoute from "@/app/api/analytics/google/merchant-center/route";
import * as gmcAccountsRoute from "@/app/api/analytics/google/merchant-center/accounts/route";
import * as gmcLoadRoute from "@/app/api/analytics/google/merchant-center/load/route";
import { closeAnalytics, listTables, queryAnalytics } from "@/lib/analytics/engine";
import { claimGaState } from "@/lib/analytics/google-analytics";
import { disconnectGmc, getGmcStatus, gmcLoadsNightly, setGmcRetryDelaysForTests, startGmcConnect } from "@/lib/analytics/merchant-center";
import type { SessionUser } from "@/lib/auth/sessions";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { saveMailSettings } from "@/lib/crm/mail/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getOrganisation, type OrganisationRecord } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "gmc-shop";
const noContext = undefined as unknown;
const SCOPE = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/content";
const API = "https://merchantapi.googleapis.com";

const product = (offerId: string, title: string, micros: string, statuses: unknown[], issues: unknown[] = []) => ({
  name: `accounts/5551234/products/en~NZ~${offerId}`,
  offerId,
  contentLanguage: "en",
  feedLabel: "NZ",
  productAttributes: { title, brand: "Glenmore", link: `https://shop.example/${offerId}`, price: { amountMicros: micros, currencyCode: "NZD" }, availability: "IN_STOCK" },
  productStatus: { destinationStatuses: statuses, itemLevelIssues: issues },
});

/** Examples GMC1-GMC8 in docs/ACCOUNTING-EXAMPLES.md (Google Merchant Center, following common practice, not yet reviewed). Google is a fake; the products are made up. */
describeWithDatabase("analytics: Google Merchant Center products", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  let root: string;
  let organisation: OrganisationRecord;
  let calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  let failReports: Response | null = null;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fake = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url: input, body });
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") return reply({ access_token: "gmc-access", refresh_token: "gmc-refresh", expires_in: 3600, scope: SCOPE });
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/revoke") return new Response("", { status: 200 });
    if (url.pathname === "/oauth2/v2/userinfo") return reply({ email: "Jade@Shop.example", verified_email: true });
    if (input.startsWith(`${API}/accounts/v1/accounts`)) return reply({ accounts: [{ name: "accounts/5551234", accountId: "5551234", accountName: "Glenmore by Jade" }, { name: "accounts/999", accountId: "999", accountName: "Another shop" }] });
    if (url.pathname === "/products/v1/accounts/5551234/products") {
      // Two pages, to check paging.
      if (!url.searchParams.get("pageToken")) {
        return reply({
          products: [
            product("shopify_NZ_77_43", "Pendant pendant", "89000000", [{ reportingContext: "SHOPPING_ADS", approvedCountries: ["NZ"] }, { reportingContext: "FREE_LISTINGS", approvedCountries: ["NZ"] }]),
          ],
          nextPageToken: "page-2",
        });
      }
      return reply({
        products: [
          product("NOSE-RING", "Fern print ring", "129500000", [{ reportingContext: "SHOPPING_ADS", disapprovedCountries: ["NZ"] }], [
            { code: "missing_shipping", severity: "DISAPPROVED", reportingContext: "SHOPPING_ADS", description: "Missing shipping", applicableCountries: ["NZ"] },
          ]),
        ],
      });
    }
    if (url.pathname === "/reports/v1/accounts/5551234/reports:search") {
      if (failReports) return failReports;
      return reply({
        results: [
          { productPerformanceView: { date: { year: 2026, month: 11, day: 14 }, offerId: "shopify_NZ_77_43", title: "Pendant pendant", clicks: "3", impressions: "140" } },
          { productPerformanceView: { date: { year: 2026, month: 11, day: 15 }, offerId: "shopify_NZ_77_43", title: "Pendant pendant", clicks: "5", impressions: "210" } },
          { productPerformanceView: { date: { year: 2026, month: 11, day: 15 }, offerId: "NOSE-RING", title: "Fern print ring", impressions: "12" } },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  };

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "merchant-center-test-secret-key-0123456789abcd";
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-gmc-"));
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("gmc-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("gmc-viewer@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);
    await as(owner, (tx) => updateOrganisationSettings(tx, { analyticsEnabled: true }));
    await as(owner, (tx) => saveMailSettings(tx, { googleClientId: "g-client.apps.googleusercontent.com", googleClientSecret: "g-secret" }));
    organisation = (await getOrganisation(ORG))!;
    setMailFetchForTests(fake);
    setGmcRetryDelaysForTests([0, 0, 0]);
  });

  afterAll(async () => {
    setMailFetchForTests(null);
    setGmcRetryDelaysForTests(null);
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  it("GMC1 an admin signs in for Merchant Center through the shared Google address; stored encrypted", async () => {
    expect((await gmcRoute.POST(apiRequest("/api/analytics/google/merchant-center", { method: "POST", cookie: viewerCookie, body: { organisationId: ORG } }), noContext)).status).toBe(403);
    const started = await gmcRoute.POST(apiRequest("/api/analytics/google/merchant-center", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), noContext);
    const { url } = (await started.json()) as { url: string };
    const query = new URL(url).searchParams;
    expect([query.get("scope"), query.get("redirect_uri")]).toEqual([SCOPE, "http://tohyee.test/api/analytics/google/callback"]);
    // A Merchant Center state can't finish a Google Analytics sign-in.
    const other = await as(owner, async (tx) => new URL((await startGmcConnect(tx, "https://tohyee.test")).url).searchParams.get("state")!);
    await expect(as(owner, (tx) => claimGaState(tx, other))).rejects.toThrow("for another connection");
    const back = await gaCallback.GET(apiRequest(`/api/analytics/google/callback?state=${encodeURIComponent(query.get("state")!)}&code=code-1`, { cookie: ownerCookie }));
    expect(back.headers.get("location")).toBe("http://tohyee.test/analytics/sources?googleMerchantCenter=connected");
    const stored = await as(owner, (tx) => tx.query<{ refresh_token_ciphertext: string; google_email: string }>("select * from analytics_merchant_center_connections"));
    expect(stored.rows[0].google_email).toBe("jade@shop.example");
    expect(stored.rows[0].refresh_token_ciphertext).not.toContain("gmc-refresh");
    expect((await as(viewer, (tx) => getGmcStatus(tx, false))).connection).toMatchObject({ googleEmail: null, accountId: null });
  });

  it("GMC2 lists the accounts by name, and only those can be chosen", async () => {
    const listed = await gmcAccountsRoute.GET(apiRequest(`/api/analytics/google/merchant-center/accounts?organisationId=${ORG}`, { cookie: ownerCookie }), noContext);
    expect(((await listed.json()) as { accounts: unknown }).accounts).toEqual([
      { accountId: "999", name: "Another shop" },
      { accountId: "5551234", name: "Glenmore by Jade" },
    ]);
    const wrong = await gmcRoute.PATCH(apiRequest("/api/analytics/google/merchant-center", { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, accountId: "123" } }), noContext);
    expect(wrong.status).toBe(400);
    const saved = await gmcRoute.PATCH(apiRequest("/api/analytics/google/merchant-center", { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, accountId: "5551234" } }), noContext);
    expect(((await saved.json()) as { connection: unknown }).connection).toMatchObject({ accountId: "5551234", accountName: "Glenmore by Jade", reloadDaily: true });
    expect(await as(owner, (tx) => gmcLoadsNightly(tx))).toBe(true);
  });

  it("GMC3-GMC5 loads every page of products, their issues and clicks by day, with exact prices and Shopify's ids", async () => {
    calls = [];
    const response = await gmcLoadRoute.POST(apiRequest("/api/analytics/google/merchant-center/load", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), noContext);
    const { run } = (await response.json()) as { run: { status: string; error: string | null; sourceName: string } };
    expect(run).toMatchObject({ status: "ok", error: null, sourceName: "Google Merchant Center" });
    const report = calls.find((call) => call.url.endsWith("reports:search"))!;
    expect(String(report.body!.query)).toMatch(/^SELECT date, offer_id, title, clicks, impressions FROM product_performance_view WHERE date BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'$/);
    expect(calls.every((call) => !call.body || call.url.endsWith("reports:search") || call.url.includes("oauth2"))).toBe(true);

    expect(await queryAnalytics(ORG, "select offer_id, title, price::varchar as price, currency, shopping_ads_status, issues, top_issue, shopify_product_id from google_merchant_center_products order by offer_id")).toEqual([
      { offer_id: "NOSE-RING", title: "Fern print ring", price: "129.50", currency: "NZD", shopping_ads_status: "Disapproved", issues: 1, top_issue: "Missing shipping", shopify_product_id: null },
      { offer_id: "shopify_NZ_77_43", title: "Pendant pendant", price: "89.00", currency: "NZD", shopping_ads_status: "Approved", issues: 0, top_issue: null, shopify_product_id: "77" },
    ]);
    expect(await queryAnalytics(ORG, "select severity, where_shown, issue from google_merchant_center_issues")).toEqual([{ severity: "Disapproved", where_shown: "Shopping ads", issue: "Missing shipping" }]);
    expect(await queryAnalytics(ORG, "select offer_id, sum(clicks)::int as clicks, sum(impressions)::int as impressions from google_merchant_center_product_days group by offer_id order by offer_id")).toEqual([
      { offer_id: "NOSE-RING", clicks: 0, impressions: 12 },
      { offer_id: "shopify_NZ_77_43", clicks: 8, impressions: 350 },
    ]);
  });

  it("GMC6 a refused report keeps what was loaded and says what to do", async () => {
    failReports = reply({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403);
    const response = await gmcLoadRoute.POST(apiRequest("/api/analytics/google/merchant-center/load", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), noContext);
    const { run } = (await response.json()) as { run: { status: string; error: string } };
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Performance and insights");
    expect(await queryAnalytics(ORG, "select count(*)::int as n from google_merchant_center_products")).toEqual([{ n: 2 }]);
    failReports = null;
  });

  it("GMC7 disconnecting deletes the sign-in and the tables", async () => {
    await disconnectGmc(organisation, { userId: owner.id, email: owner.email });
    expect((await as(owner, (tx) => getGmcStatus(tx, true))).connection).toBeNull();
    expect([...(await listTables(ORG)).keys()].filter((name) => name.startsWith("google_merchant_center_"))).toEqual([]);
    expect(calls.some((call) => call.url.includes("/revoke"))).toBe(true);
  });
});
