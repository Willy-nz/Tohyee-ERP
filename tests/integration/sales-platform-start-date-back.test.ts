import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { getOrganisation } from "@/lib/organisations/registry";
import { connectStore, syncConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/shopify";
import { createTaxCode } from "@/lib/tax/codes";
import { CLIENT_ID, CLIENT_SECRET, fakeShopifyStore, order1001, payout70001, storeState } from "../helpers/fake-shopify-orders";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** SPF7 (review M1): moving the start date back reads the earlier payouts again, as well as the earlier orders. */
const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";

describeWithDatabase("SPF7: start date moved back", () => {
  let server: TestServer;
  let owner: SessionUser;
  const savedKey = process.env.TOHYEE_SECRET_KEY;
  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("m1@review.nz", { serverAdmin: true, displayName: "M1" });
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });
  afterEach(() => setSalesPlatformFetchForTests(null));
  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  it("M1: September's order comes in, its September payout doesn't, and clearing keeps it", async () => {
    const org = "m1-1-co";
    await createTestOrganisation(owner, org);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    await as(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "EXPORT", label: "Exports", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" });
      await updateOrganisationSettings(tx, { gstNumber: "123-456-789", gstRegistered: true, exportTaxCode: "EXPORT" });
    });
    const sept = "2026-09-15T01:30:00Z";
    const state = storeState({
      orders: [order1001({ processedAt: sept, updatedAt: sept, transactions: [{ id: 9001, kind: "SALE", amount: "46.00", processedAt: sept }] })],
      payouts: [
        payout70001({ issuedAt: "2026-09-18T03:00:00Z", net: "44.62", transactions: [{ id: 80001, type: "CHARGE", amount: "46.00", fee: "1.38", net: "44.62", orderName: "#1001" }] }),
        payout70001({ id: 70009, issuedAt: "2026-10-20T03:00:00Z", net: "10.00", transactions: [{ id: 80099, type: "ADJUSTMENT", amount: "10.00", fee: "0.00", net: "10.00" }] }),
      ],
    });
    // (70009 is refused, as an adjustment in Tohyee's favour; it's only there so the payout cursor moves past September.)
    setSalesPlatformFetchForTests(fakeShopifyStore(state));
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
    const sync = (at: string) => syncConnection(record, connection.id, undefined, new Date(at));
    const balance = async (code: string) =>
      (
        await as((tx) =>
          tx.query<{ net: string }>(
            `select to_char(coalesce(sum(l.debit_amount - l.credit_amount), 0), 'FM999999990.00') as net
               from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = $1`,
            [code],
          ),
        )
      ).rows[0].net;
    await sync("2026-10-21T01:00:00Z");
    expect(await balance("1010")).toBe("0.00");

    await as((tx) => updateConnectionSettings(tx, connection.id, { startDate: "2026-09-01" }));
    await sync("2026-10-22T01:00:00Z");
    await sync("2026-10-23T01:00:00Z");
    const invoiced = (await as((tx) => tx.query("select 1 from sales_invoices where reference = '#1001'"))).rowCount;
    const payoutPosted = (await as((tx) => tx.query("select 1 from sales_platform_documents where record_kind = 'payout' and external_id = '70001'"))).rowCount;
    console.log(`M1: #1001 invoiced ${invoiced}; payout 70001 posted ${payoutPosted}; clearing ${await balance("1010")}`);
    expect(invoiced).toBe(1);
    // SPF7: the September payout is read again from the new start date and posted; clearing clears.
    expect(payoutPosted).toBe(1);
    expect(await balance("1010")).toBe("0.00");
  }, 120_000);
});
