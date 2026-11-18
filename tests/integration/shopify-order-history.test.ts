import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import type { OrgTx } from "@/lib/db/org-transaction";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { salesPlatformDiagnostics } from "@/lib/sales-platforms/diagnostics";
import { payoutGuidanceForLine, payoutMatchReport } from "@/lib/sales-platforms/payout-reconcile";
import { connectStore, listConnections, listSyncLog, syncConnection, testConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/shopify";
import { createTaxCode } from "@/lib/tax/codes";
import { CLIENT_ID, CLIENT_SECRET, fakeShopifyStore, order1001, order1002, payout70001, storeState } from "../helpers/fake-shopify-orders";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
const CONNECTED_AT = new Date("2026-11-02T20:00:00Z"); // 3 Nov 2026, 9am NZDT

/**
 * Examples SPC47-SPC51 (following common practice, not yet reviewed), with a made-up store: Shopify's 60 days of orders,
 * free orders, the store's own words on a payout's bank line, and why a payout's orders aren't in the books.
 */
describeWithDatabase("Shopify order history, free orders and payout words", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@order-history.test", { serverAdmin: true, displayName: "Owner" });
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });

  afterEach(() => {
    setSalesPlatformFetchForTests(null);
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  // #1001 on 13 Aug: older than the 60 days before 3 Nov. #1002 on 3 Oct: inside them.
  const older = () => order1001({ processedAt: "2026-08-13T01:30:00Z", updatedAt: "2026-08-13T01:31:00Z", transactions: [{ id: 9001, kind: "SALE", amount: "46.00", processedAt: "2026-08-13T01:30:00Z" }] });

  async function setup() {
    organisations += 1;
    const org = `history-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    await as(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "EXPORT", label: "Exports", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" });
      await updateOrganisationSettings(tx, { gstNumber: "123-456-789", gstRegistered: true, exportTaxCode: "EXPORT" });
    });
    const state = storeState({ now: CONNECTED_AT.toISOString(), orders: [older(), order1002()], payouts: [payout70001()] });
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
    const bank = (await as((tx) => tx.query<{ id: string }>("select id from accounts where code = '1000'"))).rows[0].id;
    let imports = 0;
    return {
      as,
      state,
      record,
      actor,
      connectionId: connection.id,
      sync: (at: string) => syncConnection(record, connection.id, undefined, new Date(at)),
      connection: async () => (await as((tx) => listConnections(tx))).find((entry) => entry.id === connection.id)!,
      log: async () => (await as((tx) => listSyncLog(tx, connection.id))).entries,
      invoices: async () => (await as((tx) => tx.query<{ reference: string }>("select reference from sales_invoices where status <> 'voided' order by reference"))).rows.map((row) => row.reference),
      bankLines: async (...rows: string[]) => {
        imports += 1;
        const csv = `Date,Amount,Payee\n${rows.join("\n")}\n`;
        await as((tx) => importStatementFile(tx, bank, { idempotencyKey: key(`import-${imports}`), fileName: `statement-${imports}.csv`, fileBase64: Buffer.from(csv).toString("base64") }));
        return (await as((tx) => listStatementLines(tx, bank, { status: "unreconciled" }))).lines;
      },
    };
  }

  it("SPC47-SPC48, SPC51: orders older than Shopify's 60 days are named as never read, then brought in once read_all_orders is given", async () => {
    const w = await setup();
    await w.sync("2026-11-02T21:00:00Z");

    // SPC47: only #1002 could be read.
    expect(await w.invoices()).toEqual(["#1002"]);
    const before = await w.connection();
    expect(before.ordersReadFrom).toBe("2026-09-04");
    expect(before.olderOrders).toMatchObject({ from: "2026-08-01", to: "2026-09-03" });
    expect(before.olderOrders!.message).toContain("read_all_orders");
    expect((await w.log()).some((entry) => entry.externalId === "5001")).toBe(false);
    const diagnosis = await w.as((tx) => salesPlatformDiagnostics(tx));
    const scopes = (diagnosis.connections[0] as unknown as { scopes: { needed: Array<{ scope: string; neededNow: boolean }>; missingNow: string[] } }).scopes;
    expect(scopes.missingNow).toEqual(["read_all_orders"]);

    // SPC51: the payout names #1001 as not in the books, and why.
    const report = await w.as((tx) => payoutMatchReport(tx, { from: "2026-10-01", to: "2026-10-31" }, "2026-11-03"));
    const payout = report.payouts[0] as { ordersNotInBooks?: string[]; ordersNotInBooksWhy?: Array<{ name: string; why: string }> };
    expect(payout.ordersNotInBooks).toEqual(["#1001"]);
    expect(payout.ordersNotInBooksWhy).toEqual([{ name: "#1001", why: expect.stringContaining("Never read from Shopify") }]);
    expect(payout.ordersNotInBooksWhy![0].why).toContain("2026-08-01 to 2026-09-03");

    // SPC48: the store gives read_all_orders; the connection is tested and the next sync reads back to the start date.
    w.state.scopes.push("read_all_orders");
    await testConnection(w.record, w.actor, w.connectionId, { now: new Date("2026-11-03T20:00:00Z") });
    await w.sync("2026-11-03T21:00:00Z");
    expect(await w.invoices()).toEqual(["#1001", "#1002"]);
    const after = await w.connection();
    expect(after.ordersReadFrom).toBe("2026-08-01");
    expect(after.olderOrders).toBeNull();
    expect((await w.log()).some((entry) => entry.message.includes("Read every Shopify order from 2026-08-01 again"))).toBe(true);
    const report2 = await w.as((tx) => payoutMatchReport(tx, { from: "2026-10-01", to: "2026-10-31" }, "2026-11-04"));
    expect((report2.payouts[0] as { ordersNotInBooks?: string[] }).ordersNotInBooks).toBeUndefined();

    // The sync after doesn't read everything again, and nothing is posted twice.
    const calls = w.state.calls.length;
    await w.sync("2026-11-04T21:00:00Z");
    // (The latest changed order is read again, as every changed-since read does; #1001 isn't.)
    expect(w.state.calls.slice(calls)).not.toContain("order:5001");
    expect(await w.invoices()).toEqual(["#1001", "#1002"]);

    // Moving the start date back reads back to it again.
    await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { startDate: "2026-07-01" }));
    expect((await w.connection()).olderOrders).toBeNull();
    const reads = w.state.calls.length;
    await w.sync("2026-11-05T21:00:00Z");
    expect(w.state.calls.slice(reads).filter((call) => call.startsWith("order:")).sort()).toEqual(["order:5001", "order:5002"]);
    expect((await w.connection()).ordersReadFrom).toBe("2026-07-01");
    expect(await w.invoices()).toEqual(["#1001", "#1002"]);
  });

  it("SPC49: a free order is logged once as nothing to post, and isn't tried again", async () => {
    const w = await setup();
    w.state.orders = [
      order1002({
        id: 5009,
        name: "#1009",
        processedAt: "2026-11-01T22:55:00Z",
        updatedAt: "2026-11-01T22:56:00Z",
        total: "0.00",
        lines: [{ id: 4009, name: "Wax melts - Vanilla", sku: "MELT-VAN", quantity: 2, variantId: 3002, originalTotal: "18.00", discount: "18.00" }],
        shipping: [],
        transactions: [],
      }),
    ];
    await w.sync("2026-11-02T21:00:00Z");
    const lines = (await w.log()).filter((entry) => entry.externalId === "5009");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ action: "skipped", message: expect.stringContaining("#1009 comes to 0.00 NZD, so there's nothing to post") });
    expect(await w.invoices()).toEqual([]);
    expect((await w.as((tx) => tx.query("select 1 from sales_orders"))).rowCount).toBe(0);
    await w.sync("2026-11-03T21:00:00Z");
    expect((await w.log()).filter((entry) => entry.externalId === "5009")).toHaveLength(1);
  });

  it("SPC50: the store's own words on the bank line make an amount-and-date fit a match, only on the payouts account", async () => {
    const w = await setup();
    await w.sync("2026-11-02T21:00:00Z");
    const [line] = await w.bankLines("08/10/2026,49.38,GLENMORE CANDLES TRF 1Z6");
    expect(await w.as((tx) => payoutGuidanceForLine(tx, line.id))).toMatchObject({ status: "needs_choice", evidence: "amount_date" });

    await expect(w.as((tx) => updateConnectionSettings(tx, w.connectionId, { payoutBankWords: ["ab"] }))).rejects.toThrow("3 to 60 characters");
    const saved = await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { payoutBankWords: ["  Glenmore   Candles ", "glenmore candles"] }));
    expect(saved.payoutBankWords).toEqual(["Glenmore Candles"]);
    expect((await w.log()).some((entry) => entry.message.includes("hat mean a payout on the bank line: \"Glenmore Candles\""))).toBe(true);
    expect(await w.as((tx) => payoutGuidanceForLine(tx, line.id))).toMatchObject({ status: "matched", evidence: "platform_amount_date", action: { kind: "match" } });

    // A different amount with the words is still not matched on the words alone.
    const lines = await w.bankLines("09/10/2026,12.00,GLENMORE CANDLES TRF 2Z7");
    const other = lines.find((entry) => entry.amount === "12.00")!;
    expect(await w.as((tx) => payoutGuidanceForLine(tx, other.id))).not.toMatchObject({ status: "matched" });
  });
});
