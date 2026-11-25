import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
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
 * SPF2 (review H2): orders stuck on "no stock on hand" come in once the stock problem is fixed.
 * (a) Stock received on today's date: the older order is invoiced on its own date and its stock
 *     goes out on the earliest day allowed, with its cost of sales that day.
 * (b) Negative stock turned on with 30 stuck orders: retries go oldest first and all come in.
 */
const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
const GST = (amount: string) => [{ title: "GST", rate: 0.15, amount }];

/** One pendant (GIFTBOX, stock) at 34.50, paid on `day` (an NZ date) at 9am NZDT. */
function pendantOrder(n: number, day: string): OrderFixture {
  const at = new Date(Date.parse(`${day}T09:00:00+13:00`)).toISOString();
  return {
    id: 7000 + n,
    name: `#${1000 + n}`,
    processedAt: at,
    updatedAt: at,
    financialStatus: "PAID",
    taxesIncluded: true,
    total: "34.50",
    customer: AROHA,
    billingCountry: "NZ",
    lines: [{ id: 8000 + n, name: "Gift box", sku: "GIFTBOX", quantity: 1, variantId: 3004, originalTotal: "34.50", tax: GST("4.50") }],
    shipping: [],
    transactions: [{ id: 9000 + n, kind: "SALE", amount: "34.50", processedAt: at }],
  };
}

describeWithDatabase("SPF2: stuck stock orders come in once the stock is fixed", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;
  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("h2@review.nz", { serverAdmin: true, displayName: "H2" });
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });
  afterEach(() => setSalesPlatformFetchForTests(null));
  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `h2-${organisations}-co`;
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
      }),
    );
    const sync = (at: string) => syncConnection(record, connection.id, undefined, new Date(at));
    await sync("2026-10-01T01:00:00Z");
    const giftBox = (await as((tx) => tx.query<{ id: string }>("select id from items where code = 'GIFTBOX'"))).rows[0];
    const invoiced = async () =>
      (await as((tx) => tx.query<{ reference: string }>("select reference from sales_invoices order by reference"))).rows.map((row) => row.reference);
    const lastMessage = async (externalId: string) =>
      (await as((tx) => listSyncLog(tx, connection.id))).entries.find((entry) => entry.externalId === externalId)?.message ?? "";
    return { as, state, sync, giftBoxId: giftBox.id, connectionId: connection.id, invoiced, lastMessage };
  }

  it("SPF2: stock received today brings in an order paid earlier, with its stock on the earliest day allowed", async () => {
    const w = await setup();
    w.state.orders.push(pendantOrder(1, "2026-11-01"));
    await w.sync("2026-11-01T02:00:00Z");
    expect(await w.lastMessage("7001")).toContain("no stock on hand");
    expect((await w.as((tx) => stockStuck(tx, w.connectionId))).orders).toHaveLength(1);

    // The owner receives 5 gift boxes on a bill dated 25 Nov (today), as SSD3 suggests ("entering the stock on hand").
    const supplier = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Box Co", isSupplier: true }))).contact;
    const bill = await w.as((tx) =>
      createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: supplier.id,
        billDate: "2026-11-25",
        dueDate: "2026-12-20",
        supplierInvoiceNumber: "B-1",
        amountsMode: "exclusive",
        lines: [{ itemId: w.giftBoxId, description: "Gift boxes", quantity: "5", unitPrice: "10.00", accountCode: "1400", taxCode: "GST" }],
      }),
    );
    await w.as((tx) => approveBill(tx, bill.bill.id, { idempotencyKey: key("a") }));

    await w.sync("2026-11-25T02:00:00Z");
    // SPF2: invoiced on the day it was paid; its stock goes out on 25 Nov, the earliest day it can, with a note.
    expect(await w.invoiced()).toEqual(["#1001"]);
    const invoice = (await w.as((tx) => tx.query<{ id: string; invoice_date: string; approval_journal_id: string }>("select id, invoice_date::text, approval_journal_id from sales_invoices"))).rows[0];
    expect(invoice.invoice_date).toBe("2026-11-01");
    const movement = (
      await w.as((tx) =>
        tx.query<{ movement_date: string; quantity_delta: string; value_delta: string; description: string; ledger_journal_id: string }>(
          "select movement_date::text, quantity_delta::text, value_delta::text, description, ledger_journal_id from inventory_movements where source_type = 'invoice' and source_id = $1",
          [invoice.id],
        ),
      )
    ).rows;
    expect(movement).toHaveLength(1);
    expect(movement[0]).toMatchObject({ movement_date: "2026-11-25", quantity_delta: "-1", value_delta: "-10.00" });
    expect(movement[0].description).toContain("stock can't be backdated");
    // Its cost of sales is in a journal of its own on 25 Nov; the invoice's journal on 1 Nov has none.
    expect(movement[0].ledger_journal_id).not.toBe(invoice.approval_journal_id);
    const cogs = await w.as((tx) =>
      tx.query<{ posting_date: string; debit: string }>(
        `select j.posting_date::text, sum(l.debit_amount - l.credit_amount)::text as debit from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
          join accounts a on a.id = l.account_id where a.system_key = 'cost_of_goods_sold' group by j.posting_date`,
      ),
    );
    expect(cogs.rows).toEqual([{ posting_date: "2026-11-25", debit: "10.00" }]);
    // The stock and the inventory account agree: 4 boxes worth 40.00.
    const stock = (await w.as((tx) => tx.query<{ on_hand_quantity: string; carrying_value: string }>("select on_hand_quantity::text, carrying_value::text from inventory_item_balances where item_code = 'GIFTBOX'"))).rows[0];
    expect(stock).toEqual({ on_hand_quantity: "4", carrying_value: "40.00" });
    const inventory = await w.as((tx) =>
      tx.query<{ balance: string }>(
        "select sum(l.debit_amount - l.credit_amount)::text as balance from ledger_journal_lines l join accounts a on a.id = l.account_id where a.system_key = 'inventory'",
      ),
    );
    expect(inventory.rows[0].balance).toBe("40.00");
    expect(await w.lastMessage("7001")).toContain("stock can't be backdated");
    expect((await w.as((tx) => stockStuck(tx, w.connectionId))).orders).toEqual([]);
  });

  it("SPF2: negative stock turned on with 30 stuck orders: all of them come in, oldest first", async () => {
    const w = await setup();
    for (let n = 1; n <= 30; n += 1) w.state.orders.push(pendantOrder(n, `2026-11-${String(n % 20 + 1).padStart(2, "0")}`));
    await w.sync("2026-11-21T02:00:00Z");
    expect(await w.invoiced()).toEqual([]);

    await w.as((tx) => updateOrganisationSettings(tx, { allowNegativeStock: true }));
    await w.as((tx) => updateItem(tx, w.giftBoxId, { purchasePrice: "10.00" }));
    // Today's new order comes in with the retries.
    w.state.orders.push(pendantOrder(31, "2026-11-25"));
    await w.sync("2026-11-25T02:00:00Z");
    const first = await w.invoiced();
    await w.sync("2026-11-25T03:00:00Z");
    await w.sync("2026-11-25T04:00:00Z");
    await w.sync("2026-11-26T04:00:00Z");
    const after = await w.invoiced();
    // SPF2: every order comes in; none is left stuck on backdating.
    const missing = Array.from({ length: 31 }, (_, i) => `#${1001 + i}`).filter((name) => !after.includes(name));
    expect(missing).toEqual([]);
    expect(first.length).toBe(31);
    const backdated = await w.as((tx) => tx.query("select 1 from sales_platform_sync_log where message ilike '%Backdated stock movements%'"));
    expect(backdated.rowCount).toBe(0);
  }, 240_000);
});
