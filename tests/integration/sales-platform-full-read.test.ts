import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { getOrganisation } from "@/lib/organisations/registry";
import { connectStore, listConnections, listSyncLog, syncConnection, testConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/shopify";
import { createTaxCode } from "@/lib/tax/codes";
import { CLIENT_ID, CLIENT_SECRET, fakeShopifyStore, order1001, order1002, storeState } from "../helpers/fake-shopify-orders";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * SPF5 (review H4): when read_all_orders is given later (SPC48), the full read of orders goes on from
 * where it stopped at each sync until it reaches the end, so orders past the first 200 are read too.
 */
const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
const CONNECTED_AT = new Date("2026-11-02T20:00:00Z");
const OLD = 210;

describeWithDatabase("SPF5: a full re-read of orders goes on past 200", () => {
  let server: TestServer;
  let owner: SessionUser;
  const savedKey = process.env.TOHYEE_SECRET_KEY;
  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("h4@review.nz", { serverAdmin: true, displayName: "H4" });
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });
  afterEach(() => setSalesPlatformFetchForTests(null));
  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  it("H4: of 210 orders older than 60 days, only 200 ever come in", async () => {
    const org = "h4-1-co";
    await createTestOrganisation(owner, org);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    await as(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "EXPORT", label: "Exports", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" });
      await updateOrganisationSettings(tx, { gstNumber: "123-456-789", gstRegistered: true, exportTaxCode: "EXPORT" });
    });
    // 210 orders in August (older than Shopify's 60 days on 3 Nov), one a minute apart, and #1002 in October.
    const old = Array.from({ length: OLD }, (_, i) => {
      const at = new Date(Date.parse("2026-08-10T01:00:00Z") + i * 60_000).toISOString();
      return order1001({ id: 50_000 + i, name: `#${2000 + i}`, processedAt: at, updatedAt: at, transactions: [{ id: 90_000 + i, kind: "SALE", amount: "46.00", processedAt: at }] });
    });
    const state = storeState({ now: CONNECTED_AT.toISOString(), orders: [...old, order1002({ updatedAt: "2026-11-01T00:00:00Z" })] });
    setSalesPlatformFetchForTests(fakeShopifyStore(state));
    const record = (await getOrganisation(org))!;
    const connection = await connectStore(
      record,
      actor,
      { platform: "shopify", storeDomain: "glenmore", authMethod: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      { webhookOrigin: null, now: CONNECTED_AT },
    );
    await as((tx) =>
      updateConnectionSettings(tx, connection.id, {
        postToAccounts: true,
        startDate: "2026-08-01",
        newClearingAccount: { code: "1010", name: "Money held by Shopify" },
        payoutAccountCode: "1000",
        feesAccountCode: "6020",
        salesAccountCode: "4000",
        shippingAccountCode: "4000",
        taxCodes: [{ rate: "15", taxCode: "GST" }],
        untaxedTaxCode: "ZERO",
      }),
    );
    const sync = (at: string) => syncConnection(record, connection.id, undefined, new Date(at));
    const oldInvoiced = async () =>
      Number((await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from sales_invoices where reference like '#2%'"))).rows[0].n);

    await sync("2026-11-02T21:00:00Z");
    expect(await oldInvoiced()).toBe(0);

    state.scopes.push("read_all_orders");
    await testConnection(record, actor, connection.id, { now: new Date("2026-11-03T20:00:00Z") });
    await sync("2026-11-03T21:00:00Z");
    await sync("2026-11-04T21:00:00Z");
    await sync("2026-11-05T21:00:00Z");

    const count = await oldInvoiced();
    const conn = (await as((tx) => listConnections(tx))).find((entry) => entry.id === connection.id)!;
    const note = (await as((tx) => listSyncLog(tx, connection.id))).entries.some((entry) => entry.message.includes("the rest come with the next sync"));
    console.log(`H4: ${count} of ${OLD} old orders invoiced; ordersReadFrom ${conn.ordersReadFrom}; olderOrders warning ${conn.olderOrders ? "shown" : "gone"}; 'rest come next sync' note logged: ${note}`);
    expect(note).toBe(true);
    // SPF5: the full read goes on where it stopped, so every old order is read, and only then is the warning gone.
    expect(count).toBe(OLD);
    expect(conn.olderOrders).toBeNull();
    expect(conn.ordersReadFrom).toBe("2026-08-01");
    const cursor = (await as((tx) => tx.query<{ full_read_after: string | null }>("select full_read_after from sales_platform_connections where id = $1", [connection.id])))
      .rows[0];
    expect(cursor.full_read_after).toBeNull();
  }, 600_000);
});
