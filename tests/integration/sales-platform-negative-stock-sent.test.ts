import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import { updateItem } from "@/lib/items/service";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { getOrganisation } from "@/lib/organisations/registry";
import { connectStore, listSyncLog, syncConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { stockStuck } from "@/lib/sales-platforms/stock-stuck";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/shopify";
import { createTaxCode } from "@/lib/tax/codes";
import { AROHA, CLIENT_ID, CLIENT_SECRET, type OrderFixture, fakeShopifyStore, storeState } from "../helpers/fake-shopify-orders";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Review H1: with "Allow negative stock" on, a Sales when sent order's fulfilment still fails with
 * "There's no stock on hand to take out", and the stuck-stock warning doesn't list it. The same order
 * without Sales when sent invoices fine (the setting works on the invoice path).
 */
const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
const GST = (amount: string) => [{ title: "GST", rate: 0.15, amount }];

function order(overrides: Partial<OrderFixture> = {}): OrderFixture {
  return {
    id: 7001,
    name: "#1001",
    processedAt: "2026-10-31T20:00:00Z",
    updatedAt: "2026-10-31T20:01:00Z",
    financialStatus: "PAID",
    taxesIncluded: true,
    total: "115.00",
    customer: AROHA,
    billingCountry: "NZ",
    lines: [{ id: 8001, name: "Paw pendant", sku: "GIFTBOX", quantity: 1, variantId: 3004, originalTotal: "115.00", tax: GST("15.00") }],
    shipping: [],
    transactions: [{ id: 9701, kind: "SALE", amount: "115.00", processedAt: "2026-10-31T20:00:00Z" }],
    ...overrides,
  };
}

describeWithDatabase("SPF1: sales when sent follows Allow negative stock", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;
  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("h1@review.nz", { serverAdmin: true, displayName: "H1" });
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });
  afterEach(() => setSalesPlatformFetchForTests(null));
  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  async function setup(whenSent: boolean) {
    organisations += 1;
    const org = `h1-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    await as(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "EXPORT", label: "Exports", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" });
      // Negative stock ON, as the store's warning suggests.
      await updateOrganisationSettings(tx, { gstNumber: "123-456-789", gstRegistered: true, exportTaxCode: "EXPORT", allowNegativeStock: true });
    });
    const state = storeState();
    setSalesPlatformFetchForTests(fakeShopifyStore(state));
    const record = (await getOrganisation(org))!;
    const connection = await connectStore(
      record,
      actor,
      { platform: "shopify", storeDomain: "glenmore", authMethod: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      { webhookOrigin: null, now: new Date("2026-10-01T00:03:01Z") },
    );
    await as((tx) =>
      updateConnectionSettings(tx, connection.id, {
        postToAccounts: true,
        startDate: "2026-10-01",
        newClearingAccount: { code: "1010", name: "Shopify clearing" },
        payoutAccountCode: "1000",
        feesAccountCode: "6020",
        salesAccountCode: "4000",
        shippingAccountCode: "4000",
        taxCodes: [{ rate: "15", taxCode: "GST" }],
        untaxedTaxCode: "ZERO",
        ...(whenSent ? { newSalesWhenSentAccount: { code: "2350", name: "Income in advance" } } : {}),
      }),
    );
    const sync = (at: string) => syncConnection(record, connection.id, undefined, new Date(at));
    await sync("2026-10-01T01:00:00Z");
    // GIFTBOX is a stock item with nothing on hand but a purchase price, so negative stock has a cost to use (ST11).
    const giftBox = (await as((tx) => tx.query<{ id: string; item_type: string }>("select id, item_type from items where code = 'GIFTBOX'"))).rows[0];
    expect(giftBox.item_type).toBe("stock");
    await as((tx) => updateItem(tx, giftBox.id, { purchasePrice: "20.00" }));
    return { as, state, sync, connectionId: connection.id };
  }

  it("control: without sales when sent the invoice takes stock below zero, as the setting says", async () => {
    const w = await setup(false);
    w.state.orders.push(order());
    await w.sync("2026-11-01T02:00:00Z");
    const invoiced = await w.as((tx) => tx.query("select 1 from sales_invoices where reference = '#1001'"));
    expect(invoiced.rowCount).toBe(1);
  });

  it("SPF1: with negative stock on, the fulfilment takes the stock below zero", async () => {
    const w = await setup(true);
    w.state.orders.push(order());
    await w.sync("2026-11-01T02:00:00Z");
    expect((await w.as((tx) => tx.query("select 1 from sales_invoices where reference = '#1001'"))).rowCount).toBe(1);
    w.state.orders[0].fulfilments = [{ id: 9901, createdAt: "2026-11-02T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }] }];
    await w.sync("2026-11-03T02:00:00Z");
    const log = (await w.as((tx) => listSyncLog(tx, w.connectionId))).entries.filter((entry) => entry.externalId === "7001");
    // SPF1: the fulfilment takes GIFTBOX below zero, costed at its purchase price, as an invoice would.
    expect(log[0].message).not.toContain("no stock on hand");
    expect(log[0].message).toContain("Counted what #1001 sent as sales");
    expect((await w.as((tx) => tx.query("select 1 from ledger_journals where origin = 'sales_when_sent'"))).rowCount).toBe(1);
    const issue = await w.as((tx) => tx.query<{ quantity_delta: string; value_delta: string; movement_date: string }>("select quantity_delta::text, value_delta::text, movement_date::text from inventory_movements where movement_type = 'issue'"));
    expect(issue.rows).toEqual([{ quantity_delta: "-1", value_delta: "-20.00", movement_date: "2026-11-03" }]);
    const balance = await w.as((tx) => tx.query<{ on_hand_quantity: string; carrying_value: string }>("select on_hand_quantity::text, carrying_value::text from inventory_item_balances where item_code = 'GIFTBOX'"));
    expect(balance.rows[0]).toEqual({ on_hand_quantity: "-1", carrying_value: "-20.00" });
    expect((await w.as((tx) => stockStuck(tx, w.connectionId))).orders).toEqual([]);
  });

  it("SPF1: with negative stock off, the stuck fulfilment is in the stuck-stock warning and says what to do", async () => {
    const w = await setup(true);
    await w.as((tx) => updateOrganisationSettings(tx, { allowNegativeStock: false }));
    w.state.orders.push(order());
    await w.sync("2026-11-01T02:00:00Z");
    w.state.orders[0].fulfilments = [{ id: 9901, createdAt: "2026-11-02T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }] }];
    await w.sync("2026-11-03T02:00:00Z");
    const log = (await w.as((tx) => listSyncLog(tx, w.connectionId))).entries.filter((entry) => entry.externalId === "7001");
    expect(log[0].message).toContain("There's no stock on hand to take out");
    expect(log[0].message).toContain("turn on Allow negative stock in Organisation settings");
    expect((await w.as((tx) => stockStuck(tx, w.connectionId))).orders).toEqual([{ orderId: "7001", name: "#1001" }]);
  });

  it("SPF2: stock sent before the item's latest movement goes out on that later day, with a note", async () => {
    const w = await setup(true);
    w.state.orders.push(order());
    await w.sync("2026-11-01T02:00:00Z");
    const giftBox = (await w.as((tx) => tx.query<{ id: string }>("select id from items where code = 'GIFTBOX'"))).rows[0];
    const supplier = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Box Co", isSupplier: true }))).contact;
    const bill = await w.as((tx) =>
      createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: supplier.id,
        billDate: "2026-11-05",
        dueDate: "2026-12-20",
        supplierInvoiceNumber: "B-1",
        amountsMode: "exclusive",
        lines: [{ itemId: giftBox.id, description: "Gift boxes", quantity: "2", unitPrice: "10.00", accountCode: "1400", taxCode: "GST" }],
      }),
    );
    await w.as((tx) => approveBill(tx, bill.bill.id, { idempotencyKey: key("a") }));
    // Sent on 3 Nov (NZ), but GIFTBOX already has a movement on 5 Nov.
    w.state.orders[0].fulfilments = [{ id: 9901, createdAt: "2026-11-02T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }] }];
    await w.sync("2026-11-06T02:00:00Z");
    const issue = await w.as((tx) =>
      tx.query<{ movement_date: string; value_delta: string; description: string }>("select movement_date::text, value_delta::text, description from inventory_movements where movement_type = 'issue'"),
    );
    expect(issue.rows).toHaveLength(1);
    expect(issue.rows[0]).toMatchObject({ movement_date: "2026-11-05", value_delta: "-10.00" });
    expect(issue.rows[0].description).toContain("stock can't be backdated");
    // What was sent still counts as sales on the day it was sent.
    const sent = await w.as((tx) => tx.query<{ posting_date: string }>("select posting_date::text from ledger_journals where origin = 'sales_when_sent'"));
    expect(sent.rows).toEqual([{ posting_date: "2026-11-03" }]);
  });
});
