import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { findAiTool } from "@/lib/ai/catalogue";
import type { ToolContext } from "@/lib/ai/tools";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { getOrganisation } from "@/lib/organisations/registry";
import { connectStore, syncConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/shopify";
import { listHeldOrders, markHeldOrderSent } from "@/lib/sales-platforms/when-sent";
import { createTaxCode } from "@/lib/tax/codes";
import { AROHA, CLIENT_ID, CLIENT_SECRET, type OrderFixture, fakeShopifyStore, storeState } from "../helpers/fake-shopify-orders";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
const GST = (amount: string) => [{ title: "GST", rate: 0.15, amount }];

/**
 * #1001 as in SWS1 (made-up): Paw pendant (GIFTBOX, a stock item) 115.00,
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

/** SPF13-SPF19: a Shopify shipment cancelled after Sales when sent counted it. Not tried against a real store. */
describeWithDatabase("SPF13-SPF19: cancelled shipments under Sales when sent", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("jade@cancelled-shipments.nz", { serverAdmin: true, displayName: "Jade" });
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });
  afterEach(() => setSalesPlatformFetchForTests(null));
  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  /** Glenmore Ltd as in SPC11, posting from 1 Oct, Sales when sent on (Income in advance 2350); pendants bought at 20.00 on 1 Oct. */
  async function setup(options: { gst?: boolean; pendants?: number } = {}) {
    organisations += 1;
    const org = `cancelled-shipment-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    const registered = options.gst !== false;
    await as(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "EXPORT", label: "Exports", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" });
      await updateOrganisationSettings(tx, { gstNumber: registered ? "123-456-789" : null, gstRegistered: registered, exportTaxCode: "EXPORT" });
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
        ...(registered ? { taxCodes: [{ rate: "15", taxCode: "GST" }], untaxedTaxCode: "ZERO" } : {}),
        newSalesWhenSentAccount: { code: "2350", name: "Income in advance" },
      }),
    );
    const sync = (at: string) => syncConnection(record, connection.id, undefined, new Date(at));
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
        amountsMode: registered ? "exclusive" : "no_tax",
        lines: [{ itemId: giftBox.id, description: "Pendants", quantity: String(options.pendants ?? 1), unitPrice: "20.00", accountCode: "1400", ...(registered ? { taxCode: "GST" } : {}) }],
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
  /** Income in advance, sales, cost of goods sold, inventory, and pendants on hand. */
  const books = async (w: World) => ({
    held: await balance(w, "2350"),
    sales: await balance(w, "4000"),
    cogs: await balance(w, "5000"),
    stock: await balance(w, "1400"),
    onHand: (await w.as((tx) => tx.query<{ q: string }>("select coalesce(sum(on_hand_quantity), 0)::int::text as q from inventory_item_balances where item_code = 'GIFTBOX'"))).rows[0].q,
  });
  const reversals = async (w: World) =>
    (
      await w.as((tx) =>
        tx.query<{ posting_date: string; reference: string; description: string }>(
          "select posting_date::text, reference, description from ledger_journals where origin = 'sales_when_sent' and reference like '%not sent' order by id",
        ),
      )
    ).rows;
  const logLines = async (w: World) =>
    (await w.as((tx) => tx.query<{ message: string }>("select message from sales_platform_sync_log where message like '%was cancelled in Shopify%' order by id"))).rows.map(
      (row) => row.message,
    );
  const gstTotal = async (w: World) => balance(w, (await w.as((tx) => tx.query<{ code: string }>("select code from accounts where system_key = 'gst'"))).rows[0]?.code ?? "2200");

  it("SPF13-SPF14: a counted shipment cancelled goes back to paid, still to send; seen twice reverses once; sent again counts again", async () => {
    const w = await setup();
    w.state.orders.push(order());
    await w.sync("2026-11-01T02:00:00Z");
    const gstBefore = await gstTotal(w);
    // Shipment A on 3 Nov sends everything.
    w.state.orders[0].fulfilments = [{ id: 9901, createdAt: "2026-11-02T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }, { lineId: 8002, quantity: 1 }] }];
    await w.sync("2026-11-03T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-130.00", cogs: "20.00", stock: "0.00", onHand: "0" });
    expect(await w.as((tx) => listHeldOrders(tx, w.connectionId))).toEqual([]);

    // Cancelled in Shopify on 5 Nov.
    Object.assign(w.state.orders[0], { updatedAt: "2026-11-05T01:00:00Z" });
    w.state.orders[0].fulfilments![0] = { ...w.state.orders[0].fulfilments![0], status: "CANCELLED", updatedAt: "2026-11-05T01:00:00Z" };
    await w.sync("2026-11-05T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-130.00", sales: "0.00", cogs: "0.00", stock: "20.00", onHand: "1" });
    expect((await reversals(w)).map((j) => [j.posting_date, j.reference])).toEqual([["2026-11-03", "#1001 not sent"]]);
    // GST doesn't move: it was counted on the invoice.
    expect(await gstTotal(w)).toBe(gstBefore);
    const returned = (await w.as((tx) => tx.query<{ movement_date: string; quantity_delta: string; value_delta: string }>(
      "select movement_date::text, quantity_delta::int::text as quantity_delta, value_delta::text from inventory_movements where movement_type = 'customer_return'",
    ))).rows;
    expect(returned).toEqual([{ movement_date: "2026-11-03", quantity_delta: "1", value_delta: "20.00" }]);
    expect(await logLines(w)).toEqual([
      "#1001: shipment 9901 was cancelled in Shopify, so what it sent is back to paid, still to send: 130.00 moved from sales back to Income in advance, and 1 Paw pendant back into stock.",
    ]);
    // Back on the held orders list, for people and the AI.
    expect(await w.as((tx) => listHeldOrders(tx, w.connectionId))).toMatchObject([{ orderId: "7001", held: "130.00" }]);
    const ai: ToolContext = { role: "owner", organisationId: w.org, source: "ai-7", accessLevel: "full", grantedAccessLevel: "full" };
    expect(await w.as((tx) => findAiTool("list_held_orders")!.run(tx, { connectionId: w.connectionId }, ai))).toMatchObject({ total: 1, orders: [{ orderId: "7001", held: "130.00" }] });

    // SPF14: seen again, and again by a later read: reversed once.
    await w.sync("2026-11-05T03:00:00Z");
    Object.assign(w.state.orders[0], { updatedAt: "2026-11-06T01:00:00Z" });
    await w.sync("2026-11-06T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-130.00", sales: "0.00", cogs: "0.00", stock: "20.00", onHand: "1" });
    expect(await reversals(w)).toHaveLength(1);

    // Sent again in shipment B on 7 Nov: counted as usual.
    w.state.orders[0].fulfilments!.push({ id: 9902, createdAt: "2026-11-06T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }, { lineId: 8002, quantity: 1 }] });
    await w.sync("2026-11-07T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-130.00", cogs: "20.00", stock: "0.00", onHand: "0" });
  });

  it("SPF13: Mark as sent works on an order a cancelled shipment put back", async () => {
    const w = await setup();
    w.state.orders.push(order({ fulfilments: [{ id: 9901, createdAt: "2026-11-01T22:00:00Z", lines: [{ lineId: 8002, quantity: 1 }] }] }));
    await w.sync("2026-11-02T02:00:00Z");
    // The pendant is marked sent by hand; then Shopify's shipment of the kit is cancelled.
    await w.as((tx) => markHeldOrderSent(tx, w.connectionId, "7001", "2026-11-03"));
    expect(await books(w)).toEqual({ held: "0.00", sales: "-130.00", cogs: "20.00", stock: "0.00", onHand: "0" });
    Object.assign(w.state.orders[0], { updatedAt: "2026-11-04T01:00:00Z" });
    w.state.orders[0].fulfilments![0] = { ...w.state.orders[0].fulfilments![0], status: "CANCELLED", updatedAt: "2026-11-04T01:00:00Z" };
    await w.sync("2026-11-04T02:00:00Z");
    // Only the kit goes back; the shipping stays because the pendant (marked sent) still counts as sent.
    expect(await books(w)).toEqual({ held: "-20.00", sales: "-110.00", cogs: "20.00", stock: "0.00", onHand: "0" });
    await w.as((tx) => markHeldOrderSent(tx, w.connectionId, "7001", "2026-11-05"));
    expect(await books(w)).toEqual({ held: "0.00", sales: "-130.00", cogs: "20.00", stock: "0.00", onHand: "0" });
  });

  it("SPF15: only the cancelled shipment's lines; the shipping goes back with the last one standing", async () => {
    const w = await setup({ pendants: 2 });
    w.state.orders.push(
      order({
        total: "264.50",
        lines: [
          { id: 8001, name: "Paw pendant", sku: "GIFTBOX", quantity: 2, variantId: 3004, originalTotal: "230.00", tax: GST("30.00") },
          { id: 8002, name: "Impression kit", sku: "CANDLE-L", quantity: 1, variantId: 3001, originalTotal: "23.00", tax: GST("3.00") },
        ],
        transactions: [{ id: 9701, kind: "SALE", amount: "264.50", processedAt: "2026-10-31T20:00:00Z" }],
        fulfilments: [
          { id: 9901, createdAt: "2026-11-02T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }, { lineId: 8002, quantity: 1 }] },
          { id: 9902, createdAt: "2026-11-03T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }] },
        ],
      }),
    );
    await w.sync("2026-11-04T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-230.00", cogs: "40.00", stock: "0.00", onHand: "0" });
    // B is cancelled: one pendant back; A untouched, shipping stays.
    Object.assign(w.state.orders[0], { updatedAt: "2026-11-05T01:00:00Z" });
    w.state.orders[0].fulfilments![1] = { ...w.state.orders[0].fulfilments![1], status: "CANCELLED", updatedAt: "2026-11-05T01:00:00Z" };
    await w.sync("2026-11-05T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-100.00", sales: "-130.00", cogs: "20.00", stock: "20.00", onHand: "1" });
    expect((await reversals(w)).map((j) => j.posting_date)).toEqual(["2026-11-04"]);
    // Then A: its pendant and kit, and now the shipping too (no counted shipment is left).
    Object.assign(w.state.orders[0], { updatedAt: "2026-11-06T01:00:00Z" });
    w.state.orders[0].fulfilments![0] = { ...w.state.orders[0].fulfilments![0], status: "CANCELLED", updatedAt: "2026-11-06T01:00:00Z" };
    await w.sync("2026-11-06T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-230.00", sales: "0.00", cogs: "0.00", stock: "40.00", onHand: "2" });
    expect(await w.as((tx) => listHeldOrders(tx, w.connectionId))).toMatchObject([{ orderId: "7001", held: "230.00" }]);
  });

  it("SPF16: not GST registered: the full prices go back, no GST", async () => {
    const w = await setup({ gst: false });
    w.state.orders.push(order({ fulfilments: [{ id: 9901, createdAt: "2026-11-02T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }, { lineId: 8002, quantity: 1 }] }] }));
    await w.sync("2026-11-03T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-149.50", cogs: "20.00", stock: "0.00", onHand: "0" });
    Object.assign(w.state.orders[0], { updatedAt: "2026-11-05T01:00:00Z" });
    w.state.orders[0].fulfilments![0] = { ...w.state.orders[0].fulfilments![0], status: "CANCELLED", updatedAt: "2026-11-05T01:00:00Z" };
    await w.sync("2026-11-05T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-149.50", sales: "0.00", cogs: "0.00", stock: "20.00", onHand: "1" });
  });

  it("SPF17: counted in a locked period: reversed on the earliest day allowed, with a plain note", async () => {
    const w = await setup();
    w.state.orders.push(
      order({
        processedAt: "2026-09-30T20:00:00Z",
        updatedAt: "2026-10-02T20:00:00Z",
        transactions: [{ id: 9701, kind: "SALE", amount: "149.50", processedAt: "2026-09-30T20:00:00Z" }],
        fulfilments: [{ id: 9901, createdAt: "2026-10-02T20:00:00Z", lines: [{ lineId: 8001, quantity: 1 }, { lineId: 8002, quantity: 1 }] }],
      }),
    );
    await w.sync("2026-10-03T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-130.00", cogs: "20.00", stock: "0.00", onHand: "0" });
    const october = (await w.as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals where posting_date <= '2026-10-31'"))).rows[0].n;
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-10-31", reason: "October GST filed" }));
    Object.assign(w.state.orders[0], { updatedAt: "2026-11-04T01:00:00Z" });
    w.state.orders[0].fulfilments![0] = { ...w.state.orders[0].fulfilments![0], status: "CANCELLED", updatedAt: "2026-11-04T01:00:00Z" };
    await w.sync("2026-11-04T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-130.00", sales: "0.00", cogs: "0.00", stock: "20.00", onHand: "1" });
    const [reversal] = await reversals(w);
    expect(reversal.posting_date).toBe("2026-11-01");
    expect(reversal.description).toContain("dated 1 Nov 2026, not 3 Oct 2026, because the books are locked up to 31 Oct 2026");
    expect((await logLines(w))[0]).toContain("dated 1 Nov 2026, not 3 Oct 2026, because the books are locked up to 31 Oct 2026");
    const returned = (await w.as((tx) => tx.query<{ movement_date: string }>("select movement_date::text from inventory_movements where movement_type = 'customer_return'"))).rows;
    expect(returned).toEqual([{ movement_date: "2026-11-01" }]);
    // Nothing in the locked period changed.
    expect((await w.as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals where posting_date <= '2026-10-31'"))).rows[0].n).toBe(october);
  });

  const refund = (at: string, restocked: boolean) => ({
    id: 6101,
    processedAt: at,
    lines: [{ lineId: 8001, quantity: 1, restocked, subtotal: "115.00", tax: "15.00" }],
    transactions: [{ id: 9801, kind: "REFUND", amount: "115.00", processedAt: at }],
  });

  it("SPF18: cancelled, then refunded: the refund comes out of Income in advance, the pendant comes back once", async () => {
    const w = await setup();
    w.state.orders.push(order({ fulfilments: [{ id: 9901, createdAt: "2026-11-02T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }, { lineId: 8002, quantity: 1 }] }] }));
    await w.sync("2026-11-03T02:00:00Z");
    Object.assign(w.state.orders[0], { updatedAt: "2026-11-05T01:00:00Z" });
    w.state.orders[0].fulfilments![0] = { ...w.state.orders[0].fulfilments![0], status: "CANCELLED", updatedAt: "2026-11-05T01:00:00Z" };
    await w.sync("2026-11-05T02:00:00Z");
    Object.assign(w.state.orders[0], { updatedAt: "2026-11-06T01:00:00Z", financialStatus: "PARTIALLY_REFUNDED", refunds: [refund("2026-11-06T01:00:00Z", true)] });
    await w.sync("2026-11-06T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-30.00", sales: "0.00", cogs: "0.00", stock: "20.00", onHand: "1" });
  });

  it("SPF18: refunded and restocked, then cancelled: only the kit and shipping go back, and no stock", async () => {
    const w = await setup();
    w.state.orders.push(order({ fulfilments: [{ id: 9901, createdAt: "2026-11-02T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }, { lineId: 8002, quantity: 1 }] }] }));
    await w.sync("2026-11-03T02:00:00Z");
    Object.assign(w.state.orders[0], { updatedAt: "2026-11-04T01:00:00Z", financialStatus: "PARTIALLY_REFUNDED", refunds: [refund("2026-11-04T01:00:00Z", true)] });
    await w.sync("2026-11-04T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-30.00", cogs: "0.00", stock: "20.00", onHand: "1" });
    Object.assign(w.state.orders[0], { updatedAt: "2026-11-05T01:00:00Z" });
    w.state.orders[0].fulfilments![0] = { ...w.state.orders[0].fulfilments![0], status: "CANCELLED", updatedAt: "2026-11-05T01:00:00Z" };
    await w.sync("2026-11-05T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-30.00", sales: "0.00", cogs: "0.00", stock: "20.00", onHand: "1" });
  });

  it("SPF18: both between two syncs are taken in Shopify's order, either way the same books", async () => {
    for (const refundFirst of [true, false]) {
      const w = await setup();
      w.state.orders.push(order({ fulfilments: [{ id: 9901, createdAt: "2026-11-02T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }, { lineId: 8002, quantity: 1 }] }] }));
      await w.sync("2026-11-03T02:00:00Z");
      const refundAt = refundFirst ? "2026-11-04T01:00:00Z" : "2026-11-04T03:00:00Z";
      Object.assign(w.state.orders[0], { updatedAt: "2026-11-04T04:00:00Z", financialStatus: "PARTIALLY_REFUNDED", refunds: [refund(refundAt, true)] });
      w.state.orders[0].fulfilments![0] = { ...w.state.orders[0].fulfilments![0], status: "CANCELLED", updatedAt: "2026-11-04T02:00:00Z" };
      await w.sync("2026-11-04T05:00:00Z");
      expect(await books(w)).toEqual({ held: "-30.00", sales: "0.00", cogs: "0.00", stock: "20.00", onHand: "1" });
      const note = (await w.as((tx) => tx.query<{ code: string }>("select a.code from sales_credit_note_lines l join accounts a on a.id = l.account_id"))).rows;
      expect(note).toEqual([{ code: refundFirst ? "4000" : "2350" }]);
    }
  });

  it("SPF18: two pendants sent, one refunded and restocked, then the shipment cancelled: one pendant goes back", async () => {
    const w = await setup({ pendants: 2 });
    w.state.orders.push(
      order({
        total: "253.00",
        lines: [{ id: 8001, name: "Paw pendant", sku: "GIFTBOX", quantity: 2, variantId: 3004, originalTotal: "230.00", tax: GST("30.00") }],
        shipping: [{ id: 8101, title: "NZ Post", amount: "23.00", tax: GST("3.00") }],
        transactions: [{ id: 9701, kind: "SALE", amount: "253.00", processedAt: "2026-10-31T20:00:00Z" }],
        fulfilments: [{ id: 9901, createdAt: "2026-11-02T22:00:00Z", lines: [{ lineId: 8001, quantity: 2 }] }],
      }),
    );
    await w.sync("2026-11-03T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-220.00", cogs: "40.00", stock: "0.00", onHand: "0" });
    Object.assign(w.state.orders[0], { updatedAt: "2026-11-04T01:00:00Z", financialStatus: "PARTIALLY_REFUNDED", refunds: [refund("2026-11-04T01:00:00Z", true)] });
    await w.sync("2026-11-04T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-120.00", cogs: "20.00", stock: "20.00", onHand: "1" });
    Object.assign(w.state.orders[0], { updatedAt: "2026-11-05T01:00:00Z" });
    w.state.orders[0].fulfilments![0] = { ...w.state.orders[0].fulfilments![0], status: "CANCELLED", updatedAt: "2026-11-05T01:00:00Z" };
    await w.sync("2026-11-05T02:00:00Z");
    // One pendant (100.00) and the shipping (20.00) back to Income in advance; one pendant back into stock.
    expect(await books(w)).toEqual({ held: "-120.00", sales: "0.00", cogs: "0.00", stock: "40.00", onHand: "2" });
  });

  it("SPF19: an order held after it was invoiced: the sale goes back, no stock moves", async () => {
    const w = await setup();
    await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { salesWhenSentAccountCode: null }));
    w.state.orders.push(order({ financialStatus: "PENDING", transactions: [] }));
    await w.sync("2026-11-01T02:00:00Z");
    await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { salesWhenSentAccountCode: "2350" }));
    Object.assign(w.state.orders[0], {
      financialStatus: "PAID",
      updatedAt: "2026-11-02T01:00:00Z",
      transactions: [{ id: 9701, kind: "SALE", amount: "149.50", processedAt: "2026-11-02T01:00:00Z" }],
    });
    await w.sync("2026-11-02T02:00:00Z");
    w.state.orders[0].fulfilments = [{ id: 9901, createdAt: "2026-11-02T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }] }];
    await w.sync("2026-11-03T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-20.00", sales: "-110.00", cogs: "20.00", stock: "0.00", onHand: "0" });
    Object.assign(w.state.orders[0], { updatedAt: "2026-11-04T01:00:00Z" });
    w.state.orders[0].fulfilments[0] = { ...w.state.orders[0].fulfilments[0], status: "CANCELLED", updatedAt: "2026-11-04T01:00:00Z" };
    await w.sync("2026-11-04T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-130.00", sales: "0.00", cogs: "20.00", stock: "0.00", onHand: "0" });
  });
});
