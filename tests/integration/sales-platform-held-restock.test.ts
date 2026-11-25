import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { getOrganisation } from "@/lib/organisations/registry";
import { connectStore, syncConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/shopify";
import { createTaxCode } from "@/lib/tax/codes";
import { AROHA, CLIENT_ID, CLIENT_SECRET, type OrderFixture, fakeShopifyStore, storeState } from "../helpers/fake-shopify-orders";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
const GST = (amount: string) => [{ title: "GST", rate: 0.15, amount }];

/**
 *  as in SWS1 (made-up): Paw pendant (GIFTBOX, a stock item) 115.00,
 * Impression kit (CANDLE-L, not stock) 23.00, shipping 11.50, paid 1 Nov.
 */
function order(overrides: Partial<OrderFixture> = {}): OrderFixture {
  return {
    id: 7001,
    name: "#1001",
    processedAt: "2026-10-31T20:00:00Z",
    updatedAt: "2026-10-31T20:01:00Z",
    financialStatus: "PAID",
    taxesIncluded: true,
    total: "149.50",
    customer: AROHA,
    billingCountry: "NZ",
    lines: [
      { id: 8001, name: "Paw pendant", sku: "GIFTBOX", quantity: 1, variantId: 3004, originalTotal: "115.00", tax: GST("15.00") },
      { id: 8002, name: "Impression kit", sku: "CANDLE-L", quantity: 1, variantId: 3001, originalTotal: "23.00", tax: GST("3.00") },
    ],
    shipping: [{ id: 8101, title: "NZ Post", amount: "11.50", tax: GST("1.50") }],
    transactions: [{ id: 9701, kind: "SALE", amount: "149.50", processedAt: "2026-10-31T20:00:00Z" }],
    ...overrides,
  };
}

/** Shopify sales when sent (SWS1-SWS9; not yet reviewed). Not tried against a real store. */
describeWithDatabase("SPF6: restocked refund of a line held after invoicing", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("jade@sales-when-sent.nz", { serverAdmin: true, displayName: "Jade" });
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });
  afterEach(() => setSalesPlatformFetchForTests(null));
  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  /** Glenmore Ltd as in SPC11, posting from 1 Oct, with sales when sent on (Income in advance 2350) unless `whenSent` is false. */
  async function setup(options: { whenSent?: boolean; pendants?: number } = {}) {
    organisations += 1;
    const org = `when-sent-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    await as(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "EXPORT", label: "Exports", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" });
      await updateOrganisationSettings(tx, { gstNumber: "123-456-789", gstRegistered: true, exportTaxCode: "EXPORT" });
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
        ...(options.whenSent === false ? {} : { newSalesWhenSentAccount: { code: "2350", name: "Income in advance" } }),
      }),
    );
    const sync = (at: string) => syncConnection(record, connection.id, undefined, new Date(at));
    // The products come in (GIFTBOX is a stock item), then pendants are bought at 20.00 each.
    await sync("2026-10-01T01:00:00Z");
    const giftBox = (await as((tx) => tx.query<{ id: string }>("select id from items where code = 'GIFTBOX'"))).rows[0];
    const supplier = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Silver Co", isSupplier: true }))).contact;
    const bill = await as((tx) =>
      createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: supplier.id,
        billDate: "2026-10-01",
        dueDate: "2026-10-20",
        supplierInvoiceNumber: "S-1",
        amountsMode: "exclusive",
        lines: [{ itemId: giftBox.id, description: "Pendants", quantity: String(options.pendants ?? 1), unitPrice: "20.00", accountCode: "1400", taxCode: "GST" }],
      }),
    );
    await as((tx) => approveBill(tx, bill.bill.id, { idempotencyKey: key("a") }));
    return { org, as, state, connectionId: connection.id, sync };
  }
  type World = Awaited<ReturnType<typeof setup>>;

  const balance = async (w: World, code: string) =>
    (
      await w.as((tx) =>
        tx.query<{ net: string }>(
          `select to_char(coalesce(sum(l.debit_amount - l.credit_amount), 0), 'FM999999990.00') as net
             from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = $1`,
          [code],
        ),
      )
    ).rows[0].net;
  /** Income in advance, sales, cost of goods sold and inventory. */
  const books = async (w: World) => ({ held: await balance(w, "2350"), sales: await balance(w, "4000"), cogs: await balance(w, "5000"), stock: await balance(w, "1400") });
  it("SPF6: an order held after it was invoiced, refunded and restocked before it's sent: the stock comes back", async () => {
    const w = await setup({ whenSent: false });
    w.state.orders.push(order({ financialStatus: "PENDING", transactions: [] }));
    await w.sync("2026-11-01T02:00:00Z");
    await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { newSalesWhenSentAccount: { code: "2350", name: "Income in advance" } }));
    Object.assign(w.state.orders[0], {
      financialStatus: "PAID",
      updatedAt: "2026-11-02T01:00:00Z",
      transactions: [{ id: 9701, kind: "SALE", amount: "149.50", processedAt: "2026-11-02T01:00:00Z" }],
    });
    await w.sync("2026-11-02T02:00:00Z");
    // As SWS12: the stock came off at the invoice.
    expect(await books(w)).toEqual({ held: "-130.00", sales: "0.00", cogs: "20.00", stock: "0.00" });
    // The customer cancels before anything is sent: the pendant (115.00) is refunded and restocked in Shopify.
    Object.assign(w.state.orders[0], {
      financialStatus: "PARTIALLY_REFUNDED",
      updatedAt: "2026-11-03T01:00:00Z",
      refunds: [{ id: 6101, processedAt: "2026-11-03T01:00:00Z", lines: [{ lineId: 8001, quantity: 1, restocked: true, subtotal: "115.00", tax: "15.00" }], transactions: [{ id: 9801, kind: "REFUND", amount: "115.00", processedAt: "2026-11-03T01:00:00Z" }] }],
    });
    await w.sync("2026-11-03T02:00:00Z");
    const after = await books(w);
    const onHand = (await w.as((tx) => tx.query<{ q: string }>("select coalesce(sum(on_hand_quantity),0)::text as q from inventory_item_balances where item_code = 'GIFTBOX'"))).rows[0].q;
    const credited = (await w.as((tx) => tx.query("select 1 from sales_credit_notes"))).rowCount;
    expect(credited).toBe(1);
    // SPF6: the pendant comes back into stock at its cost (ST5): stock 20.00, cost of sales back to 0.00, and Income in advance
    // gives up what was held for it.
    expect(after).toEqual({ held: "-30.00", sales: "0.00", cogs: "0.00", stock: "20.00" });
    expect(Number(onHand)).toBe(1);
  });
});
