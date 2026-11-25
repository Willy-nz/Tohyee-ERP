import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { getOrganisation } from "@/lib/organisations/registry";
import { connectStore, syncConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/shopify";
import { createTaxCode } from "@/lib/tax/codes";
import { CLIENT_ID, CLIENT_SECRET, fakeShopifyStore, order1001, storeState } from "../helpers/fake-shopify-orders";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** SPF10 (review M3): one order Shopify answers with an error no longer stops the other orders or pauses the store. */
const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";

describeWithDatabase("SPF10: one bad order", () => {
  let server: TestServer;
  let owner: SessionUser;
  const savedKey = process.env.TOHYEE_SECRET_KEY;
  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("m3@review.nz", { serverAdmin: true, displayName: "M1" });
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });
  afterEach(() => setSalesPlatformFetchForTests(null));
  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  it("SPF10: #1002's error doesn't keep #1001 out or pause the store, and #1002 comes in once Shopify answers", async () => {
    const org = "m3-1-co";
    await createTestOrganisation(owner, org);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    await as(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "EXPORT", label: "Exports", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" });
      await updateOrganisationSettings(tx, { gstNumber: "123-456-789", gstRegistered: true, exportTaxCode: "EXPORT" });
    });
    const state = storeState({ orders: [order1001(), order1001({ id: 5002, name: "#1002", updatedAt: "2026-10-02T02:00:00Z" })] });
    const store = fakeShopifyStore(state);
    let broken = false;
    // #1002 (gid .../Order/5002) is answered with a GraphQL error, as Shopify does for an internal error on one record.
    setSalesPlatformFetchForTests(async (input: string, init?: RequestInit) => {
      if (broken && init?.body && String(init.body).includes("gid://shopify/Order/5002")) {
        return new Response(JSON.stringify({ errors: [{ message: "Internal error. Looks like something went wrong on our end." }] }), { status: 200 });
      }
      return store(input, init);
    });
    const record = (await getOrganisation(org))!;
    const connection = await connectStore(
      record,
      actor,
      { platform: "shopify", storeDomain: "glenmore", authMethod: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      { webhookOrigin: null, now: new Date("2026-10-01T00:00:00Z") },
    );
    await as((tx) =>
      updateConnectionSettings(tx, connection.id, {
        postToAccounts: true,
        startDate: "2026-10-01",
        newClearingAccount: { code: "1010", name: "Money held by Shopify" },
        payoutAccountCode: "1000",
        feesAccountCode: "6020",
        salesAccountCode: "4000",
        shippingAccountCode: "4000",
        taxCodes: [{ rate: "15", taxCode: "GST" }],
        untaxedTaxCode: "ZERO",
      }),
    );
    broken = true;
    for (const at of ["2026-10-03T01:00:00Z", "2026-10-03T01:15:00Z", "2026-10-03T01:30:00Z"]) {
      await syncConnection(record, connection.id, undefined, new Date(at)).catch(() => undefined);
    }
    const invoices = (await as((tx) => tx.query("select 1 from sales_invoices"))).rowCount;
    const status = (await as((tx) => tx.query<{ status: string }>("select status from sales_platform_connections"))).rows[0].status;
    // SPF10: #1001 comes in, the store keeps syncing, and #1002 waits with a note.
    expect(invoices).toBe(1);
    expect(status).toBe("active");
    const notes = (await as((tx) => tx.query<{ message: string }>("select message from sales_platform_sync_log where message like 'Order 5002 couldn''t be read%'"))).rows;
    expect(notes.length).toBeGreaterThan(0);
    broken = false;
    await syncConnection(record, connection.id, undefined, new Date("2026-10-03T01:45:00Z"));
    expect((await as((tx) => tx.query("select 1 from sales_invoices"))).rowCount).toBe(2);

    // SPF10: a short outage (Shopify can't be reached) fails the syncs but doesn't pause the store.
    setSalesPlatformFetchForTests(async () => {
      throw new TypeError("fetch failed");
    });
    for (const at of ["2026-10-03T02:00:00Z", "2026-10-03T02:15:00Z", "2026-10-03T02:30:00Z", "2026-10-03T02:45:00Z"]) {
      await expect(syncConnection(record, connection.id, undefined, new Date(at))).rejects.toThrow();
    }
    const afterOutage = (await as((tx) => tx.query<{ status: string; failures: number }>("select status, failures from sales_platform_connections"))).rows[0];
    expect(afterOutage).toEqual({ status: "active", failures: 4 });
    setSalesPlatformFetchForTests(store);
    await syncConnection(record, connection.id, undefined, new Date("2026-10-03T03:00:00Z"));
    expect((await as((tx) => tx.query<{ failures: number }>("select failures from sales_platform_connections"))).rows[0].failures).toBe(0);
  }, 120_000);
});
